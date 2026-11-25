import { readFileSync } from "node:fs";
import path from "node:path";
import {
  benchmarkDuckDbStress,
  benchmarkPolarsStress,
  DataPreparationPipeline,
  stageCsvSource,
} from "../engines/data-processing/src/index.ts";
import { recalculateWorkbook } from "../engines/calculation/src/index.ts";

const baselinePath = path.resolve(process.cwd(), "benchmarks/baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const results = {};
const failures = [];

function checkBudget(name, measuredMs, budgetMs) {
  results[name] = { measuredMs, budgetMs, ok: measuredMs <= budgetMs };
  if (measuredMs > budgetMs) {
    failures.push(`${name}: ${measuredMs}ms exceeded budget ${budgetMs}ms`);
  }
}

// 1. DuckDB 50k stress
const duck50k = await benchmarkDuckDbStress(50_000);
checkBudget("duckdb_50k_p95_ms", duck50k.p95Ms, baseline.budgets.duckdb_50k_p95_ms);

// 2. Polars 50k stress
const polars50k = benchmarkPolarsStress(50_000);
checkBudget("polars_50k_p95_ms", polars50k.p95Ms, baseline.budgets.polars_50k_p95_ms);

// 3. Data Pipeline 10k BigInt reconciliation
const lines = ["organization_id,invoice_id,line_number,currency,amount,email"];
for (let i = 0; i < 10_000; i++) {
  lines.push(`00042,INV-${i},1,${i % 2 === 0 ? "USD" : "KHR"},${i % 2 === 0 ? "15.25" : "60000"},u${i % 50}@corp.kh`);
}
const tPipe = performance.now();
const staged = stageCsvSource(`${lines.join("\n")}\n`, "bench10k.csv");
const pipeline = new DataPreparationPipeline();
pipeline.executeRecipe({
  actor: { tenantId: "t_b", workspaceId: "ws_b", userId: "u_b", role: "editor" },
  recipe: {
    recipeId: "bench10k",
    version: 1,
    tenantId: "t_b",
    workspaceId: "ws_b",
    pinnedInputSha256s: [staged.source.sha256],
    idempotencyKey: "idem_bench10k",
    steps: [
      { stepId: "s1", op: "quarantine_missing_required", params: { column: "amount" } },
      { stepId: "s2", op: "deduplicate_composite_key", params: { keys: ["organization_id", "invoice_id", "line_number"] } },
    ],
  },
  salesSources: [staged],
  expectedColumns: ["organization_id", "invoice_id", "line_number", "currency", "amount", "email"],
});
const pipeMs = Math.round((performance.now() - tPipe) * 100) / 100;
checkBudget("pipeline_10k_bigint_ms", pipeMs, baseline.budgets.pipeline_10k_bigint_ms);

// 4. Spreadsheet 5k-formula recalc
const cells = {};
for (let r = 1; r <= 5000; r++) {
  cells[`A${r}`] = { raw: r, value: r, type: "number" };
  cells[`B${r}`] = { raw: `=A${r}*2`, formula: `=A${r}*2`, value: null, type: "formula" };
}
const tCalc = performance.now();
recalculateWorkbook({
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
const calcMs = Math.round((performance.now() - tCalc) * 100) / 100;
checkBudget("spreadsheet_5k_recalc_ms", calcMs, baseline.budgets.spreadsheet_5k_recalc_ms);

console.log(JSON.stringify({ ok: failures.length === 0, results, failures }, null, 2));
if (failures.length > 0) process.exit(1);
