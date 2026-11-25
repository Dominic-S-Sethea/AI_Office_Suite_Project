import { createHash, randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import type {
  ActorContext,
  AnalysisProvenance,
  AnalyticalQuery,
  AnalyticalResult,
  AnalyticalValuePayload,
  LinkedMetricReference,
  MetricVersion,
  RoundingMode,
  SpreadsheetWorkbook,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import { assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import { BusinessMetricRegistry } from "./metricRegistry.ts";
import {
  addMinorUnits,
  AnalyticsError,
  convertCurrencyMinorUnits,
  DEFAULT_FINANCIAL_PRECISION_POLICY,
  divideExactScaled,
  formatCurrencyOrRatioDisplay,
  formatScaledBigInt,
  parseDecimalToMinorUnits,
  subMinorUnits,
} from "./precision.ts";

export interface AnalyticalFinanceRow {
  rowId: string;
  invoiceDate: string; // YYYY-MM-DD
  reportingMonth: string; // YYYY-MM
  department: string;
  customerId: string;
  status: "posted" | "voided";
  currency: string;
  grossSales: string | number | null;
  returnsDiscounts: string | number | null;
  cogs: string | number | null;
  opex: string | number | null;
}

export interface AnalyticalBudgetRow {
  reportingMonth: string;
  department: string;
  currency: string;
  budgetCategory: "revenue" | "costs" | "operating_profit";
  budgetAmount: string | number;
}

export type AnalyticalDatasetRecord =
  | {
      datasetId: string;
      version: number;
      tenantId: string;
      workspaceId: string;
      granularity: "invoice_line";
      sha256: string;
      rows: AnalyticalFinanceRow[];
    }
  | {
      datasetId: string;
      version: number;
      tenantId: string;
      workspaceId: string;
      granularity: "department_month_budget";
      sha256: string;
      rows: AnalyticalBudgetRow[];
    };

export interface PublishedAnalyticalSnapshot {
  snapshotId: string;
  tenantId: string;
  workspaceId: string;
  publishedAt: string;
  frozenMetricVersion: MetricVersion;
  result: AnalyticalResult;
}

export interface ExecuteQueryOptions {
  roundingMode?: RoundingMode;
  simulateTransientFailureOnce?: boolean;
  includeAiInterpretation?: boolean;
}

export interface AnalyticsStressResult {
  engine: "duckdb";
  rowCount: number;
  p50Ms: number;
  p95Ms: number;
  rssDeltaMb: number;
}

const ALLOWED_GROUP_COLUMNS = new Set(["department", "reportingMonth", "customerId"]);
const DUCKDB_COLUMN_MAP: Record<string, string> = {
  department: "department",
  reportingMonth: "reporting_month",
  customerId: "customer_id",
};

function datasetKey(tenantId: string, workspaceId: string, datasetId: string, version: number): string {
  return `${tenantId}::${workspaceId}::${datasetId}::v${version}`;
}

function stableSha256(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function computeFiscalYtdStart(anchorDate: string, fiscalYearStartMonth = 1): string {
  const year = Number.parseInt(anchorDate.slice(0, 4), 10);
  const month = Number.parseInt(anchorDate.slice(5, 7), 10);
  const fyStartYear = month >= fiscalYearStartMonth ? year : year - 1;
  return `${fyStartYear}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`;
}

function shiftMonthRange(start: string, endExclusive: string, monthsDelta: number): { start: string; endExclusive: string } {
  const shiftDate = (iso: string): string => {
    const [yStr = "2026", mStr = "1", dStr = "1"] = iso.split("-");
    const date = new Date(Date.UTC(Number(yStr), Number(mStr) - 1 + monthsDelta, Number(dStr)));
    return date.toISOString().slice(0, 10);
  };
  return {
    start: shiftDate(start),
    endExclusive: shiftDate(endExclusive),
  };
}

function isPresentAmount(val: string | number | null | undefined): val is string | number {
  if (val === null || val === undefined) return false;
  if (typeof val === "string" && val.trim() === "") return false;
  return true;
}

export class BusinessAnalysisEngine {
  readonly registry: BusinessMetricRegistry;
  private readonly datasets = new Map<string, AnalyticalDatasetRecord>();
  private readonly resultCache = new Map<string, AnalyticalResult>();
  private readonly idempotencyResults = new Map<string, AnalyticalResult>();
  private readonly publishedSnapshots = new Map<string, PublishedAnalyticalSnapshot>();
  private readonly publicationCountByKey = new Map<string, number>();
  private readonly simulatedFailureTriggered = new Set<string>();
  private readonly audit?: AuditStore;

  constructor(registry = new BusinessMetricRegistry(), audit?: AuditStore) {
    this.registry = registry;
    this.audit = audit;
  }

  registerDataset(record: AnalyticalDatasetRecord): AnalyticalDatasetRecord {
    const clone = structuredClone(record);
    if (!clone.sha256) {
      clone.sha256 = stableSha256(clone.rows);
    }
    this.datasets.set(
      datasetKey(clone.tenantId, clone.workspaceId, clone.datasetId, clone.version),
      clone,
    );
    return clone;
  }

  getCachedResult(actor: ActorContext, resultId: string): AnalyticalResult {
    const found = this.resultCache.get(resultId);
    if (!found) {
      throw new AnalyticsError(404, "RESULT_NOT_FOUND", `Analytical result '${resultId}' does not exist.`);
    }
    assertTenantWorkspaceAccess(actor, found.tenantId, found.workspaceId);
    return structuredClone(found);
  }

  publishSnapshot(actor: ActorContext, resultId: string, publicationIdempotencyKey?: string): PublishedAnalyticalSnapshot {
    const result = this.getCachedResult(actor, resultId);
    const pubKey = `${actor.tenantId}::${actor.workspaceId}::${publicationIdempotencyKey ?? result.idempotencyKey}`;
    const existing = Array.from(this.publishedSnapshots.values()).find(
      (s) => s.tenantId === actor.tenantId && s.workspaceId === actor.workspaceId && s.result.idempotencyKey === result.idempotencyKey,
    );
    if (existing) {
      return structuredClone(existing);
    }
    const { versionSpec } = this.registry.getMetricVersion(result.metricId, result.metricVersion);
    const snapshot: PublishedAnalyticalSnapshot = {
      snapshotId: `pub_${randomUUID()}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      publishedAt: new Date().toISOString(),
      frozenMetricVersion: structuredClone(versionSpec),
      result: {
        ...structuredClone(result),
        linkedMetricReference: {
          ...structuredClone(result.linkedMetricReference),
          approvalStatus: "published_snapshot",
          mode: "published_snapshot",
        },
      },
    };
    this.publishedSnapshots.set(snapshot.snapshotId, snapshot);
    this.publicationCountByKey.set(pubKey, (this.publicationCountByKey.get(pubKey) ?? 0) + 1);
    return structuredClone(snapshot);
  }

  getPublishedSnapshot(actor: ActorContext, snapshotId: string): PublishedAnalyticalSnapshot {
    const snap = this.publishedSnapshots.get(snapshotId);
    if (!snap) {
      throw new AnalyticsError(404, "SNAPSHOT_NOT_FOUND", `Published snapshot '${snapshotId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, snap.tenantId, snap.workspaceId);
    return structuredClone(snap);
  }

  getPublicationCountForKey(actor: ActorContext, key: string): number {
    return this.publicationCountByKey.get(`${actor.tenantId}::${actor.workspaceId}::${key}`) ?? 0;
  }

  private getDatasetOrThrow(actor: ActorContext, datasetId: string, version: number): AnalyticalDatasetRecord {
    // Check if dataset exists under another tenant to distinguish 403 vs 404
    const exact = this.datasets.get(datasetKey(actor.tenantId, actor.workspaceId, datasetId, version));
    if (exact) return exact;
    for (const candidate of this.datasets.values()) {
      if (candidate.datasetId === datasetId && candidate.version === version) {
        assertTenantWorkspaceAccess(actor, candidate.tenantId, candidate.workspaceId);
      }
    }
    throw new AnalyticsError(404, "DATASET_NOT_FOUND", `Dataset '${datasetId}' v${version} not found for tenant.`);
  }

  async executeQuery(
    actor: ActorContext,
    query: AnalyticalQuery,
    options: ExecuteQueryOptions = {},
  ): Promise<AnalyticalResult> {
    assertTenantWorkspaceAccess(actor, query.tenantId, query.workspaceId);

    const idemKey = `${actor.tenantId}::${actor.workspaceId}::${query.idempotencyKey}`;
    const existing = this.idempotencyResults.get(idemKey);
    if (existing) {
      return structuredClone(existing);
    }

    if (options.simulateTransientFailureOnce && !this.simulatedFailureTriggered.has(idemKey)) {
      this.simulatedFailureTriggered.add(idemKey);
      throw new AnalyticsError(503, "TRANSIENT_JOB_FAILURE", "Simulated transient analytical worker interruption before commit.");
    }

    if (query.metrics.length === 0) {
      throw new AnalyticsError(400, "MISSING_METRIC", "At least one approved metric identifier is required.");
    }

    const groupByCols = query.groupBy ?? [];
    for (const col of groupByCols) {
      if (!ALLOWED_GROUP_COLUMNS.has(col)) {
        throw new AnalyticsError(400, "INVALID_DIMENSION", `Grouping dimension '${col}' is not in the approved semantic allowlist.`);
      }
    }

    const primaryMetricRef = query.metrics[0]!;
    const { definition, versionSpec } = this.registry.getMetricVersion(primaryMetricRef.id, primaryMetricRef.version);
    const dataset = this.getDatasetOrThrow(actor, query.dataset.id, query.dataset.version);
    if (dataset.granularity !== "invoice_line") {
      throw new AnalyticsError(422, "UNSUPPORTED_PRIMARY_GRANULARITY", "Primary financial analytical queries require invoice_line dataset granularity.");
    }

    const roundingMode: RoundingMode = options.roundingMode ?? DEFAULT_FINANCIAL_PRECISION_POLICY.roundingMode;
    const effectiveStart =
      query.comparison === "ytd"
        ? computeFiscalYtdStart(query.period.start, query.period.fiscalYearStartMonth ?? 1)
        : query.period.start;

    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    let engineVersion = "duckdb";

    try {
      await conn.run("SET memory_limit = '256MB'");
      await conn.run("SET threads = 2");
      await conn.run("SET allow_unsigned_extensions = false");

      await conn.run(`
        CREATE TABLE sales_lines (
          row_id VARCHAR,
          invoice_date DATE,
          reporting_month VARCHAR,
          department VARCHAR,
          customer_id VARCHAR,
          status VARCHAR,
          currency VARCHAR,
          gross_sales VARCHAR,
          returns_discounts VARCHAR,
          cogs VARCHAR,
          opex VARCHAR
        );
      `);

      const stmt = await conn.prepare(
        "INSERT INTO sales_lines VALUES ($1, CAST($2 AS DATE), $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      );
      for (const r of dataset.rows) {
        stmt.bindVarchar(1, r.rowId);
        stmt.bindVarchar(2, r.invoiceDate);
        stmt.bindVarchar(3, r.reportingMonth);
        stmt.bindVarchar(4, r.department);
        stmt.bindVarchar(5, r.customerId);
        stmt.bindVarchar(6, r.status);
        stmt.bindVarchar(7, r.currency);
        stmt.bindVarchar(8, isPresentAmount(r.grossSales) ? String(r.grossSales) : "");
        stmt.bindVarchar(9, isPresentAmount(r.returnsDiscounts) ? String(r.returnsDiscounts) : "");
        stmt.bindVarchar(10, isPresentAmount(r.cogs) ? String(r.cogs) : "");
        stmt.bindVarchar(11, isPresentAmount(r.opex) ? String(r.opex) : "");
        await stmt.run();
      }
      stmt.destroySync();

      // Lock down external I/O after loading staged dataset rows
      await conn.run("SET enable_external_access = false");

      const verReader = await conn.runAndReadAll("SELECT version() AS ver");
      engineVersion = String(verReader.getRowObjects()[0]?.ver ?? "duckdb");

      // Build parameterized period & filter query via DuckDB (inclusion rules: status = 'posted')
      const params: Array<string> = [effectiveStart, query.period.endExclusive];
      const filterSqlClauses = ["status = 'posted'", "invoice_date >= CAST($1 AS DATE)", "invoice_date < CAST($2 AS DATE)"];
      const normalizedFilterContext: Record<string, string> = {};

      if (query.filters) {
        for (const [k, rawVal] of Object.entries(query.filters)) {
          const mappedCol = DUCKDB_COLUMN_MAP[k];
          if (!mappedCol) {
            throw new AnalyticsError(400, "INVALID_FILTER_DIMENSION", `Filter dimension '${k}' is not permitted.`);
          }
          const val = Array.isArray(rawVal) ? (rawVal[0] ?? "") : rawVal;
          params.push(val);
          filterSqlClauses.push(`${mappedCol} = $${params.length}`);
          normalizedFilterContext[k] = val;
        }
      }

      const fetchPeriodRows = async (startDate: string, endDate: string): Promise<AnalyticalFinanceRow[]> => {
        const localParams = [startDate, endDate, ...params.slice(2)];
        const selStmt = await conn.prepare(`
          SELECT row_id, CAST(invoice_date AS VARCHAR) AS invoice_date, reporting_month, department,
                 customer_id, status, currency, gross_sales, returns_discounts, cogs, opex
          FROM sales_lines
          WHERE ${filterSqlClauses.join(" AND ")}
          ORDER BY row_id
        `);
        for (let idx = 0; idx < localParams.length; idx++) {
          selStmt.bindVarchar(idx + 1, localParams[idx]!);
        }
        const reader = await selStmt.runAndReadAll();
        selStmt.destroySync();
        return reader.getRowObjects().map((o) => ({
          rowId: String(o.row_id),
          invoiceDate: String(o.invoice_date),
          reportingMonth: String(o.reporting_month),
          department: String(o.department),
          customerId: String(o.customer_id),
          status: "posted",
          currency: String(o.currency),
          grossSales: String(o.gross_sales) === "" ? null : String(o.gross_sales),
          returnsDiscounts: String(o.returns_discounts) === "" ? "0" : String(o.returns_discounts),
          cogs: String(o.cogs) === "" ? null : String(o.cogs),
          opex: String(o.opex) === "" ? null : String(o.opex),
        }));
      };

      const filteredRows = await fetchPeriodRows(effectiveStart, query.period.endExclusive);
      const totalInPeriodStmt = await conn.prepare(
        "SELECT COUNT(*)::INTEGER AS cnt FROM sales_lines WHERE invoice_date >= CAST($1 AS DATE) AND invoice_date < CAST($2 AS DATE)",
      );
      totalInPeriodStmt.bindVarchar(1, effectiveStart);
      totalInPeriodStmt.bindVarchar(2, query.period.endExclusive);
      const totalPeriodCnt = Number((await totalInPeriodStmt.runAndReadAll()).getRowObjects()[0]?.cnt ?? filteredRows.length);
      totalInPeriodStmt.destroySync();

      // Exact BigInt monetary accumulation + missing-amount certification guard (ANA-T10) & multi-currency guard (ANA-T08)
      const validationErrors: string[] = [];
      const warnings: string[] = [];
      const assumptions: string[] = [
        `Precision policy ${DEFAULT_FINANCIAL_PRECISION_POLICY.policyId} (${roundingMode})`,
        `Metric ${definition.metricId} v${versionSpec.version}`,
      ];

      if (query.period.isPartialPeriod) {
        warnings.push(
          `PARTIAL_PERIOD_COMPARISON: Period '${effectiveStart}..${query.period.endExclusive}' represents ${query.period.comparableDaysElapsed ?? "partial"} elapsed days rather than a full reporting month.`,
        );
      }

      const convertRowMinor = (rawVal: string | number | null, rowCurrency: string, rowId: string, fieldName: string): bigint => {
        if (!isPresentAmount(rawVal)) {
          validationErrors.push(`MISSING_REQUIRED_AMOUNT: Row '${rowId}' is missing '${fieldName}'.`);
          return 0n;
        }
        const parsed = parseDecimalToMinorUnits(rawVal, 2);
        return convertCurrencyMinorUnits(parsed, 2, rowCurrency, query.currency, query.exchangeRate, roundingMode);
      };

      interface GroupAccum {
        grossSalesMinor: bigint;
        returnsMinor: bigint;
        netSalesMinor: bigint;
        cogsMinor: bigint;
        opexMinor: bigint;
        customers: Set<string>;
      }

      const newAccum = (): GroupAccum => ({
        grossSalesMinor: 0n,
        returnsMinor: 0n,
        netSalesMinor: 0n,
        cogsMinor: 0n,
        opexMinor: 0n,
        customers: new Set<string>(),
      });

      const aggregateRowsExact = (rows: AnalyticalFinanceRow[]) => {
        const overall = newAccum();
        const groups = new Map<string, GroupAccum>();
        for (const r of rows) {
          const gs = convertRowMinor(r.grossSales, r.currency, r.rowId, "grossSales");
          const rd = convertRowMinor(r.returnsDiscounts ?? "0", r.currency, r.rowId, "returnsDiscounts");
          const ns = subMinorUnits(gs, rd);
          const cg = convertRowMinor(r.cogs, r.currency, r.rowId, "cogs");
          const ox = convertRowMinor(r.opex, r.currency, r.rowId, "opex");

          overall.grossSalesMinor = addMinorUnits(overall.grossSalesMinor, gs);
          overall.returnsMinor = addMinorUnits(overall.returnsMinor, rd);
          overall.netSalesMinor = addMinorUnits(overall.netSalesMinor, ns);
          overall.cogsMinor = addMinorUnits(overall.cogsMinor, cg);
          overall.opexMinor = addMinorUnits(overall.opexMinor, ox);
          if (r.customerId.trim()) overall.customers.add(r.customerId);

          if (groupByCols.length > 0) {
            const keyObj: Record<string, string> = {};
            for (const gCol of groupByCols) {
              keyObj[gCol] = String(r[gCol as keyof AnalyticalFinanceRow] ?? "");
            }
            const gKey = JSON.stringify(keyObj);
            const gAcc = groups.get(gKey) ?? newAccum();
            gAcc.grossSalesMinor = addMinorUnits(gAcc.grossSalesMinor, gs);
            gAcc.returnsMinor = addMinorUnits(gAcc.returnsMinor, rd);
            gAcc.netSalesMinor = addMinorUnits(gAcc.netSalesMinor, ns);
            gAcc.cogsMinor = addMinorUnits(gAcc.cogsMinor, cg);
            gAcc.opexMinor = addMinorUnits(gAcc.opexMinor, ox);
            if (r.customerId.trim()) gAcc.customers.add(r.customerId);
            groups.set(gKey, gAcc);
          }
        }
        return { overall, groups };
      };

      const { overall, groups } = aggregateRowsExact(filteredRows);

      // Compute metric value from an Accumulator cleanly & uniformly
      const computeFromAccum = (acc: GroupAccum, metricId: string, priorAcc?: GroupAccum): AnalyticalValuePayload => {
        const grossProfit = subMinorUnits(acc.netSalesMinor, acc.cogsMinor);
        const totalCosts = addMinorUnits(acc.cogsMinor, acc.opexMinor);
        const operatingProfit = subMinorUnits(grossProfit, acc.opexMinor);

        switch (metricId) {
          case "FIN-GROSS-SALES":
            return {
              status: "available",
              minorUnits: acc.grossSalesMinor.toString(),
              decimalString: formatScaledBigInt(acc.grossSalesMinor, 2),
              displayValue: formatCurrencyOrRatioDisplay(acc.grossSalesMinor, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-NET-SALES":
            return {
              status: "available",
              minorUnits: acc.netSalesMinor.toString(),
              decimalString: formatScaledBigInt(acc.netSalesMinor, 2),
              displayValue: formatCurrencyOrRatioDisplay(acc.netSalesMinor, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-COGS":
            return {
              status: "available",
              minorUnits: acc.cogsMinor.toString(),
              decimalString: formatScaledBigInt(acc.cogsMinor, 2),
              displayValue: formatCurrencyOrRatioDisplay(acc.cogsMinor, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-OPEX":
            return {
              status: "available",
              minorUnits: acc.opexMinor.toString(),
              decimalString: formatScaledBigInt(acc.opexMinor, 2),
              displayValue: formatCurrencyOrRatioDisplay(acc.opexMinor, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-TOTAL-COSTS":
            return {
              status: "available",
              minorUnits: totalCosts.toString(),
              decimalString: formatScaledBigInt(totalCosts, 2),
              displayValue: formatCurrencyOrRatioDisplay(totalCosts, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-GROSS-PROFIT":
            return {
              status: "available",
              minorUnits: grossProfit.toString(),
              decimalString: formatScaledBigInt(grossProfit, 2),
              displayValue: formatCurrencyOrRatioDisplay(grossProfit, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-OPERATING-PROFIT":
            return {
              status: "available",
              minorUnits: operatingProfit.toString(),
              decimalString: formatScaledBigInt(operatingProfit, 2),
              displayValue: formatCurrencyOrRatioDisplay(operatingProfit, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
          case "FIN-GROSS-MARGIN": {
            const ratio = divideExactScaled(grossProfit, acc.netSalesMinor, 2, roundingMode, 100n);
            if (ratio.status === "unavailable") {
              return {
                status: "unavailable",
                unavailableReason: ratio.reason,
                displayValue: "Unavailable (zero denominator)",
                unit: "percent",
              };
            }
            return {
              status: "available",
              decimalString: ratio.decimalString,
              displayValue: `${ratio.decimalString}%`,
              unit: "percent",
            };
          }
          case "FIN-OPERATING-MARGIN": {
            const ratio = divideExactScaled(operatingProfit, acc.netSalesMinor, 2, roundingMode, 100n);
            if (ratio.status === "unavailable") {
              return {
                status: "unavailable",
                unavailableReason: ratio.reason,
                displayValue: "Unavailable (zero denominator)",
                unit: "percent",
              };
            }
            return {
              status: "available",
              decimalString: ratio.decimalString,
              displayValue: `${ratio.decimalString}%`,
              unit: "percent",
            };
          }
          case "FIN-REVENUE-GROWTH": {
            if (!priorAcc) {
              return {
                status: "unavailable",
                unavailableReason: "PRIOR_PERIOD_UNAVAILABLE",
                displayValue: "Unavailable (no prior period)",
                unit: "percent",
              };
            }
            const delta = subMinorUnits(acc.netSalesMinor, priorAcc.netSalesMinor);
            const growth = divideExactScaled(delta, priorAcc.netSalesMinor, 2, roundingMode, 100n);
            if (growth.status === "unavailable") {
              return {
                status: "unavailable",
                unavailableReason: growth.reason,
                displayValue: "Unavailable (zero denominator)",
                unit: "percent",
              };
            }
            return {
              status: "available",
              decimalString: growth.decimalString,
              displayValue: `${growth.decimalString}%`,
              unit: "percent",
            };
          }
          case "FIN-DISTINCT-CUSTOMERS":
            return {
              status: "available",
              decimalString: String(acc.customers.size),
              displayValue: String(acc.customers.size),
              unit: "count",
            };
          default:
            return {
              status: "available",
              minorUnits: operatingProfit.toString(),
              decimalString: formatScaledBigInt(operatingProfit, 2),
              displayValue: formatCurrencyOrRatioDisplay(operatingProfit, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
            };
        }
      };

      let priorOverall: GroupAccum | undefined;
      if (query.comparison === "previous_month" || definition.metricId === "FIN-REVENUE-GROWTH") {
        const prevRange = shiftMonthRange(query.period.start, query.period.endExclusive, -1);
        const priorRows = await fetchPeriodRows(prevRange.start, prevRange.endExclusive);
        priorOverall = aggregateRowsExact(priorRows).overall;
      }

      // Verify distinct count parity directly against DuckDB SQL COUNT(DISTINCT customer_id)
      const distinctReader = await conn.prepare(
        `SELECT COUNT(DISTINCT customer_id)::INTEGER AS cnt FROM sales_lines WHERE ${filterSqlClauses.join(" AND ")}`,
      );
      for (let idx = 0; idx < params.length; idx++) {
        distinctReader.bindVarchar(idx + 1, params[idx]!);
      }
      const duckDistinctCnt = Number((await distinctReader.runAndReadAll()).getRowObjects()[0]?.cnt ?? 0);
      distinctReader.destroySync();
      if (duckDistinctCnt !== overall.customers.size) {
        validationErrors.push(`DISTINCT_COUNT_RECONCILIATION_MISMATCH: DuckDB=${duckDistinctCnt}, Exact=${overall.customers.size}`);
      }

      let primaryValue: AnalyticalValuePayload;
      let breakdown: AnalyticalResult["breakdown"] = [];
      let budgetDatasetUsed: { id: string; version: number } | undefined;

      // Special granularity-aligned Budget vs Actual (ANA-T05)
      if (query.operation === "budget_vs_actual") {
        if (!query.budgetDataset) {
          throw new AnalyticsError(400, "MISSING_BUDGET_DATASET", "budget_vs_actual requires budgetDataset.");
        }
        const budgetDs = this.getDatasetOrThrow(actor, query.budgetDataset.id, query.budgetDataset.version);
        if (budgetDs.granularity !== "department_month_budget") {
          throw new AnalyticsError(422, "INVALID_BUDGET_GRANULARITY", "Budget dataset must declare department_month_budget granularity.");
        }
        budgetDatasetUsed = { id: budgetDs.datasetId, version: budgetDs.version };
        assumptions.push("Pre-aggregated invoice_line actuals to (reporting_month, department) before 1:1 budget join to prevent budget multiplication.");

        // Sum budgets once per category across filtered departments/months (guaranteed NO invoice multiplication!)
        const monthSet = new Set(filteredRows.map((r) => r.reportingMonth));
        const deptFilter = query.filters?.department
          ? Array.isArray(query.filters.department)
            ? query.filters.department[0]
            : query.filters.department
          : undefined;
        let revBudgetMinor = 0n;
        let costBudgetMinor = 0n;
        let opProfitBudgetMinor = 0n;
        for (const b of budgetDs.rows) {
          if (monthSet.size > 0 && !monthSet.has(b.reportingMonth)) continue;
          if (deptFilter && b.department !== deptFilter) continue;
          const bMinor = convertCurrencyMinorUnits(
            parseDecimalToMinorUnits(b.budgetAmount, 2),
            2,
            b.currency,
            query.currency,
            query.exchangeRate,
            roundingMode,
          );
          if (b.budgetCategory === "revenue") revBudgetMinor = addMinorUnits(revBudgetMinor, bMinor);
          if (b.budgetCategory === "costs") costBudgetMinor = addMinorUnits(costBudgetMinor, bMinor);
          if (b.budgetCategory === "operating_profit") opProfitBudgetMinor = addMinorUnits(opProfitBudgetMinor, bMinor);
        }

        const actualTotalCosts = addMinorUnits(overall.cogsMinor, overall.opexMinor);
        const actualOpProfit = subMinorUnits(subMinorUnits(overall.netSalesMinor, overall.cogsMinor), overall.opexMinor);
        const revVar = subMinorUnits(overall.netSalesMinor, revBudgetMinor);
        const costVar = subMinorUnits(actualTotalCosts, costBudgetMinor);
        const profitVar = subMinorUnits(actualOpProfit, opProfitBudgetMinor);

        const assess = (v: bigint, dir: "higher_is_favorable" | "lower_is_favorable") => {
          if (v === 0n) return "on_budget" as const;
          if (dir === "higher_is_favorable") return v > 0n ? ("favorable" as const) : ("unfavorable" as const);
          return v < 0n ? ("favorable" as const) : ("unfavorable" as const);
        };

        primaryValue = {
          status: "available",
          minorUnits: profitVar.toString(),
          decimalString: formatScaledBigInt(profitVar, 2),
          displayValue: formatCurrencyOrRatioDisplay(profitVar, 2, { currency: query.currency }),
          unit: "currency",
          currency: query.currency,
          varianceAssessment: assess(profitVar, "higher_is_favorable"),
        };

        breakdown = [
          {
            dimensionValues: { category: "revenue", budget: formatScaledBigInt(revBudgetMinor, 2), actual: formatScaledBigInt(overall.netSalesMinor, 2) },
            value: {
              status: "available",
              minorUnits: revVar.toString(),
              decimalString: formatScaledBigInt(revVar, 2),
              displayValue: formatCurrencyOrRatioDisplay(revVar, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
              varianceAssessment: assess(revVar, "higher_is_favorable"),
            },
          },
          {
            dimensionValues: { category: "total_costs", budget: formatScaledBigInt(costBudgetMinor, 2), actual: formatScaledBigInt(actualTotalCosts, 2) },
            value: {
              status: "available",
              minorUnits: costVar.toString(),
              decimalString: formatScaledBigInt(costVar, 2),
              displayValue: formatCurrencyOrRatioDisplay(costVar, 2, { currency: query.currency }),
              unit: "currency",
              currency: query.currency,
              varianceAssessment: assess(costVar, "lower_is_favorable"),
            },
          },
          {
            dimensionValues: { category: "operating_profit", budget: formatScaledBigInt(opProfitBudgetMinor, 2), actual: formatScaledBigInt(actualOpProfit, 2) },
            value: primaryValue,
          },
        ];
      } else {
        primaryValue = computeFromAccum(overall, definition.metricId, priorOverall);
        for (const [keyJson, gAcc] of groups.entries()) {
          const dimensionValues = JSON.parse(keyJson) as Record<string, string>;
          breakdown.push({
            dimensionValues,
            value: computeFromAccum(gAcc, definition.metricId),
          });
        }
      }

      // Basic descriptive stats (ANA-02.05..07) computed over line net sales when requested
      let stats: Record<string, number | string | number[]> | undefined;
      if (query.operation === "descriptive_stats" || query.operation === "historical_trend" || query.operation === "basic_anomaly") {
        const netValues = filteredRows
          .filter((r) => isPresentAmount(r.grossSales))
          .map((r) => Number(r.grossSales) - Number(r.returnsDiscounts ?? 0))
          .sort((a, b) => a - b);
        const count = netValues.length;
        const mean = count > 0 ? netValues.reduce((a, b) => a + b, 0) / count : 0;
        const mid = Math.floor(count / 2);
        const median =
          count === 0 ? 0 : count % 2 === 1 ? netValues[mid]! : (netValues[mid - 1]! + netValues[mid]!) / 2;
        const min = netValues[0] ?? 0;
        const max = netValues[count - 1] ?? 0;
        const variance = count > 0 ? netValues.reduce((s, x) => s + (x - mean) ** 2, 0) / count : 0;
        const stddev = Math.sqrt(variance);
        const q1 = netValues[Math.floor(count * 0.25)] ?? 0;
        const q3 = netValues[Math.floor(count * 0.75)] ?? 0;
        const iqr = q3 - q1;
        const outlierHigh = q3 + 1.5 * iqr;
        const outliers = netValues.filter((x) => x > outlierHigh);
        stats = {
          count,
          mean: Math.round(mean * 100) / 100,
          median: Math.round(median * 100) / 100,
          min,
          max,
          stddev: Math.round(stddev * 100) / 100,
          iqr: Math.round(iqr * 100) / 100,
          outliers,
        };
      }

      const validationStatus: AnalyticalResult["validationStatus"] =
        validationErrors.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "certified";

      const provenanceId = `prov_${randomUUID()}`;
      const executedAt = new Date().toISOString();
      const reportingPeriod = `${effectiveStart}..${query.period.endExclusive}`;
      const provenance: AnalysisProvenance = {
        provenanceId,
        engineName: "duckdb-exact-minor-units",
        engineVersion,
        datasetId: dataset.datasetId,
        datasetVersion: dataset.version,
        datasetSha256: dataset.sha256,
        budgetDatasetId: budgetDatasetUsed?.id,
        budgetDatasetVersion: budgetDatasetUsed?.version,
        metricId: definition.metricId,
        metricVersion: versionSpec.version,
        precisionPolicyId: versionSpec.precisionPolicyId,
        executedAt,
        inputRowCount: filteredRows.length,
        excludedRowCount: Math.max(0, totalPeriodCnt - filteredRows.length),
        filterContext: normalizedFilterContext,
        reportingPeriod,
        assumptions,
        warnings,
      };

      const linkedMetricReference: LinkedMetricReference = {
        datasetId: dataset.datasetId,
        datasetVersion: `v${dataset.version}`,
        metricId: definition.metricId,
        metricVersion: `v${versionSpec.version}`,
        reportingPeriod,
        filterContext: normalizedFilterContext,
        unit: primaryValue.unit,
        currency: primaryValue.currency,
        approvalStatus: validationStatus === "certified" ? "certified" : "draft",
        freshnessTimestamp: executedAt,
        mode: "live_draft",
        displayLabel: query.outputLanguage === "km" ? definition.displayNameKm : definition.displayNameEn,
        cachedFormattedValue: primaryValue.displayValue,
        provenanceId,
        calculationEngineVersion: `duckdb:${engineVersion}|FIN-POL-V1`,
        precisionPolicyId: versionSpec.precisionPolicyId,
        status: primaryValue.status,
        unavailableReason: primaryValue.unavailableReason,
      };

      const observedFacts = [
        `${definition.displayNameEn} (${definition.metricId} v${versionSpec.version}) = ${primaryValue.displayValue} over ${filteredRows.length} eligible posted rows.`,
        ...(priorOverall ? [`Prior-period reference net sales = ${formatCurrencyOrRatioDisplay(priorOverall.netSalesMinor, 2, { currency: query.currency })}.`] : []),
        ...warnings,
      ];

      const result: AnalyticalResult = {
        resultId: `res_${randomUUID()}`,
        queryId: query.queryId,
        idempotencyKey: query.idempotencyKey,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        metricId: definition.metricId,
        metricVersion: versionSpec.version,
        displayNameEn: definition.displayNameEn,
        displayNameKm: definition.displayNameKm,
        value: primaryValue,
        breakdown,
        stats,
        validationStatus,
        validationErrors,
        observedFacts,
        aiInterpretation: options.includeAiInterpretation
          ? {
              summaryEn: `Observed ${definition.displayNameEn} is ${primaryValue.displayValue}. Further operational root cause requires supporting business evidence.`,
              summaryKm: `លទ្ធផលដែលបានគណនាសម្រាប់ ${definition.displayNameKm} គឺ ${primaryValue.displayValue}។ មូលហេតុប្រតិបត្តិការលម្អិតត្រូវការភស្តុតាងបន្ថែម។`,
              disclaimer: "AI narrative commentary only — numerical authority resides exclusively in BusinessAnalysisEngine.",
              isObservedFact: false,
            }
          : undefined,
        provenance,
        linkedMetricReference,
      };

      this.resultCache.set(result.resultId, structuredClone(result));
      this.idempotencyResults.set(idemKey, structuredClone(result));

      this.audit?.append({
        auditId: `aud_${randomUUID()}`,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "system",
        action: "analytics.execute",
        outcome: validationStatus === "blocked" ? "failed" : "success",
        summary: `${definition.metricId} v${versionSpec.version} -> ${primaryValue.displayValue} (${validationStatus})`,
        metadata: {
          datasetId: dataset.datasetId,
          metricId: definition.metricId,
          provenanceId,
        },
        createdAt: executedAt,
      });

      return result;
    } finally {
      conn.closeSync();
      instance.closeSync();
    }
  }
}

export function buildCrossModuleReconciledOutputs(
  actor: ActorContext,
  metricResults: {
    netSales: AnalyticalResult;
    operatingProfit: AnalyticalResult;
    operatingMargin: AnalyticalResult;
  },
): {
  document: StudioDocument;
  workbook: SpreadsheetWorkbook;
  allMatchExactDecimals: boolean;
} {
  const now = new Date().toISOString();
  const doc: StudioDocument = {
    documentId: `doc_reconciled_${randomUUID().slice(0, 8)}`,
    tenantId: actor.tenantId,
    workspaceId: actor.workspaceId,
    title: "Monthly Management Performance Report",
    language: "bilingual",
    revision: 1,
    status: "approved",
    layout: {
      size: "A4",
      orientation: "portrait",
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      headerText: "AI Office Suite · Management Report",
      footerText: "Certified Metrics",
      showPageNumbers: true,
    },
    blocks: [
      {
        id: "blk_metric_net_sales",
        type: "linked_metric_placeholder",
        metric: structuredClone(metricResults.netSales.linkedMetricReference),
      },
      {
        id: "blk_metric_op_profit",
        type: "linked_metric_placeholder",
        metric: structuredClone(metricResults.operatingProfit.linkedMetricReference),
      },
      {
        id: "blk_metric_op_margin",
        type: "linked_metric_placeholder",
        metric: structuredClone(metricResults.operatingMargin.linkedMetricReference),
      },
    ],
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  };

  const netSalesNum = Number(metricResults.netSales.value.decimalString ?? "0");
  const opProfitNum = Number(metricResults.operatingProfit.value.decimalString ?? "0");
  const opMarginRatioNum = opProfitNum / (netSalesNum || 1);

  const workbook: SpreadsheetWorkbook = {
    workbookId: `wb_reconciled_${randomUUID().slice(0, 8)}`,
    title: "Management Metrics Reconciliation",
    revision: 1,
    dateSystem: "1900",
    unsupportedFeatures: [],
    sheets: [
      {
        sheetId: "sheet_summary",
        name: "Summary",
        cells: {
          A1: { value: "Net sales revenue" },
          B1: {
            value: netSalesNum,
            evaluatedValue: netSalesNum,
            currency: "USD",
            numberFormat: "$#,##0.00",
            protected: true,
          },
          A2: { value: "Operating profit" },
          B2: {
            value: opProfitNum,
            evaluatedValue: opProfitNum,
            currency: "USD",
            numberFormat: "$#,##0.00",
            protected: true,
          },
          A3: { value: "Operating margin" },
          B3: {
            value: null,
            formula: "=ROUND((B2/B1)*100, 2)",
            evaluatedValue: Math.round(opMarginRatioNum * 10000) / 100,
            numberFormat: "0.00%",
            protected: true,
          },
        },
      },
    ],
  };

  const docOpMargin = (doc.blocks[2] as Extract<StudioDocument["blocks"][number], { type: "linked_metric_placeholder" }>).metric.cachedFormattedValue;
  const sheetOpMargin = `${Number(workbook.sheets[0]!.cells.B3!.evaluatedValue).toFixed(2)}%`;
  const allMatchExactDecimals =
    docOpMargin === metricResults.operatingMargin.value.displayValue &&
    sheetOpMargin === metricResults.operatingMargin.value.displayValue;

  return { document: doc, workbook, allMatchExactDecimals };
}

export async function benchmarkAnalyticsDuckDb(rowCount: number): Promise<AnalyticsStressResult> {
  const safeRowCount = Math.trunc(rowCount);
  if (!Number.isSafeInteger(safeRowCount) || safeRowCount < 1 || safeRowCount > 5_000_000) {
    throw new RangeError(`benchmarkAnalyticsDuckDb rowCount must be an integer in [1, 5000000], got ${rowCount}`);
  }
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run("SET memory_limit = '256MB'");
    await conn.run("SET threads = 2");
    await conn.run("SET allow_unsigned_extensions = false");
    await conn.run(`
      CREATE TABLE bench_sales AS
      SELECT
        'ROW-' || i::VARCHAR AS row_id,
        '2026-11-' || LPAD(((i % 28) + 1)::VARCHAR, 2, '0') AS invoice_date,
        'D' || ((i % 5) + 1)::VARCHAR AS department,
        'C' || ((i % 400) + 1)::VARCHAR AS customer_id,
        'posted' AS status,
        'USD' AS currency,
        CAST(((i % 200) + 50) AS DECIMAL(18,2)) AS net_sales,
        CAST(((i % 100) + 20) AS DECIMAL(18,2)) AS cogs,
        CAST(((i % 30) + 10) AS DECIMAL(18,2)) AS opex
      FROM range(0, ${safeRowCount}) t(i);
    `);
    await conn.run("SET enable_external_access = false");

    const query = `
      SELECT department,
             COUNT(DISTINCT customer_id)::INTEGER AS distinct_customers,
             SUM(net_sales)::DOUBLE AS net_sales,
             SUM(net_sales - cogs - opex)::DOUBLE AS operating_profit
      FROM bench_sales
      WHERE status = 'posted'
      GROUP BY department
      ORDER BY department
    `;
    await conn.runAndReadAll(query);
    const rssBefore = process.memoryUsage().rss;
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await conn.runAndReadAll(query);
      samples.push(performance.now() - t0);
    }
    const rssAfter = process.memoryUsage().rss;
    samples.sort((a, b) => a - b);
    return {
      engine: "duckdb",
      rowCount: safeRowCount,
      p50Ms: Math.round(samples[1]! * 100) / 100,
      p95Ms: Math.round(samples[2]! * 100) / 100,
      rssDeltaMb: Math.round(((rssAfter - rssBefore) / (1024 * 1024)) * 100) / 100,
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
