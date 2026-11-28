import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmarkDuckDbStress,
  benchmarkPolarsStress,
  DataPreparationPipeline,
  stageCsvSource,
} from "../engines/data-processing/src/index.ts";
import { recalculateWorkbook } from "../engines/calculation/src/index.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.resolve(rootDir, "benchmarks/baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const results = {};
const failures = [];

function checkBudget(name, measuredMs, budgetMs) {
  results[name] = { measuredMs, budgetMs, ok: measuredMs <= budgetMs };
  if (measuredMs > budgetMs) {
    failures.push(`${name}: ${measuredMs}ms exceeded budget ${budgetMs}ms`);
  }
}

function medianMs(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100;
}

// 1. DuckDB 50k stress (warmup + measured)
await benchmarkDuckDbStress(50_000);
const duck50k = await benchmarkDuckDbStress(50_000);
if (!Array.isArray(duck50k.summaryRows) || duck50k.summaryRows.length !== 2) {
  failures.push(`duckdb_50k output missing summaryRows: ${JSON.stringify(duck50k.summaryRows)}`);
}
checkBudget("duckdb_50k_p95_ms", duck50k.p95Ms, baseline.budgets.duckdb_50k_p95_ms);

// 2. Polars 50k stress (warmup + measured + exact DuckDB parity check)
benchmarkPolarsStress(50_000);
const polars50k = benchmarkPolarsStress(50_000);
if (JSON.stringify(polars50k.summaryRows) !== JSON.stringify(duck50k.summaryRows)) {
  failures.push(
    `polars_50k parity mismatch vs duckdb_50k: polars=${JSON.stringify(polars50k.summaryRows)} duck=${JSON.stringify(duck50k.summaryRows)}`,
  );
}
checkBudget("polars_50k_p95_ms", polars50k.p95Ms, baseline.budgets.polars_50k_p95_ms);

// 3. Data Pipeline 10k BigInt reconciliation (warmup + median of 3 runs + reconciliation assertion)
const lines = ["organization_id,invoice_id,line_number,currency,amount,email"];
for (let i = 0; i < 10_000; i++) {
  lines.push(`00042,INV-${i},1,${i % 2 === 0 ? "USD" : "KHR"},${i % 2 === 0 ? "15.25" : "60000"},u${i % 50}@corp.kh`);
}
const csvPayload = `${lines.join("\n")}\n`;
const runPipelineBench = (seq) => {
  const staged = stageCsvSource(csvPayload, "bench10k.csv");
  const pipeline = new DataPreparationPipeline();
  return pipeline.executeRecipe({
    actor: { tenantId: "t_b", workspaceId: "ws_b", userId: "u_b", role: "editor" },
    recipe: {
      recipeId: "bench10k",
      version: 1,
      tenantId: "t_b",
      workspaceId: "ws_b",
      pinnedInputSha256s: [staged.source.sha256],
      idempotencyKey: `idem_bench10k_${seq}`,
      steps: [
        { stepId: "s1", op: "quarantine_missing_required", params: { column: "amount" } },
        { stepId: "s2", op: "deduplicate_composite_key", params: { keys: ["organization_id", "invoice_id", "line_number"] } },
      ],
    },
    salesSources: [staged],
    expectedColumns: ["organization_id", "invoice_id", "line_number", "currency", "amount", "email"],
  });
};
const warmPipe = runPipelineBench("warmup");
if (!warmPipe.reconciliation.passed || warmPipe.reconciliation.preparedRows !== 10_000) {
  failures.push(`pipeline_10k reconciliation assertion failed: ${JSON.stringify(warmPipe.reconciliation)}`);
}
const pipeSamples = [];
for (let i = 0; i < 3; i++) {
  const tPipe = performance.now();
  const out = runPipelineBench(String(i));
  if (!out.reconciliation.passed) {
    failures.push(`pipeline_10k run ${i} reconciliation failed`);
  }
  pipeSamples.push(performance.now() - tPipe);
}
checkBudget("pipeline_10k_bigint_ms", medianMs(pipeSamples), baseline.budgets.pipeline_10k_bigint_ms);

// 4. Spreadsheet 5k-formula recalc (warmup + median of 3 runs + B5000 calculation assertion)
const runCalcBench = () => {
  const cells = {};
  for (let r = 1; r <= 5000; r++) {
    cells[`A${r}`] = { raw: r, value: r, type: "number" };
    cells[`B${r}`] = { raw: `=A${r}*2`, formula: `=A${r}*2`, value: null, type: "formula" };
  }
  return recalculateWorkbook({
    workbookId: "wb_bench",
    tenantId: "t_b",
    workspaceId: "ws_b",
    title: "Bench",
    revision: 1,
    activeSheetId: "s1",
    sheets: [{ sheetId: "s1", name: "Sheet1", rowCount: 5000, colCount: 2, cells }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};
const warmCalc = runCalcBench();
if (warmCalc.workbook.sheets[0]?.cells?.B5000?.evaluatedValue !== 10_000) {
  failures.push(`spreadsheet_5k B5000 mismatch: ${warmCalc.workbook.sheets[0]?.cells?.B5000?.evaluatedValue}`);
}
const calcSamples = [];
for (let i = 0; i < 3; i++) {
  const tCalc = performance.now();
  runCalcBench();
  calcSamples.push(performance.now() - tCalc);
}
checkBudget("spreadsheet_5k_recalc_ms", medianMs(calcSamples), baseline.budgets.spreadsheet_5k_recalc_ms);

console.log(JSON.stringify({ ok: failures.length === 0, results, failures }, null, 2));
if (failures.length > 0) process.exit(1);
