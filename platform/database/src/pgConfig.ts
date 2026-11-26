import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

export type PgSslMode = "disable" | "require" | "verify-full";

export interface PgPoolEnvOptions {
  onWarn?: (message: string) => void;
}

function parseBoundedInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name} value '${raw}'. Expected integer in [${min}, ${max}].`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name} value '${raw}'. Expected integer in [${min}, ${max}].`);
  }
  return value;
}

/**
 * Single validated PostgreSQL pool & TLS configuration builder shared across
 * `apps/api/src/server.ts` and `scripts/db-cli.mjs` (M18).
 */
export function createPgPoolConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: PgPoolEnvOptions = {},
): Omit<PoolConfig, "connectionString"> {
  const max = parseBoundedInt(env.PG_POOL_MAX, "PG_POOL_MAX", 10, 1, 100);
  const statementTimeout = parseBoundedInt(
    env.PG_STATEMENT_TIMEOUT_MS,
    "PG_STATEMENT_TIMEOUT_MS",
    15_000,
    1_000,
    120_000,
  );
  const sslModeRaw = (env.PG_SSL_MODE ?? "").trim().toLowerCase();
  if (sslModeRaw && sslModeRaw !== "disable" && sslModeRaw !== "require" && sslModeRaw !== "verify-full") {
    throw new Error(`Invalid PG_SSL_MODE '${sslModeRaw}'. Allowed: disable, require, verify-full.`);
  }
  const sslMode: PgSslMode = (sslModeRaw as PgSslMode) || "disable";
  const caFile = (env.PG_SSL_CA_FILE ?? "").trim();

  let sslConfig: PoolConfig["ssl"];
  if (sslMode === "require" || sslMode === "verify-full") {
    let ca: string | undefined;
    if (caFile) {
      let pem: string;
      try {
        pem = readFileSync(caFile, "utf8").trim();
      } catch (err) {
        throw new Error(
          `Unable to read PG_SSL_CA_FILE '${caFile}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
        throw new Error(`PG_SSL_CA_FILE '${caFile}' does not contain a valid PEM certificate.`);
      }
      ca = pem;
    }

    const rejectUnauthorized = sslMode === "verify-full";
    if (!rejectUnauthorized) {
      const warnMsg =
        "PG_SSL_MODE=require disables TLS certificate verification (rejectUnauthorized=false). Use PG_SSL_MODE=verify-full with PG_SSL_CA_FILE in production.";
      if (options.onWarn) {
        options.onWarn(warnMsg);
      } else {
        process.stderr.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            event: "db.tls_verification_disabled",
            message: warnMsg,
          })}\n`,
        );
      }
    }

    sslConfig = {
      rejectUnauthorized,
      ...(ca ? { ca } : {}),
    };
  } else if (caFile) {
    throw new Error("PG_SSL_CA_FILE was provided while PG_SSL_MODE is disabled. Set PG_SSL_MODE=verify-full.");
  }

  return {
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeout,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  };
}
