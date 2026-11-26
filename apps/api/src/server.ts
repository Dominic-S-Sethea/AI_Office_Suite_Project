import {
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import { getJwtSecret } from "@ai-office-suite/identity";
import { createApiApp } from "./app.ts";

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function resolveAuthMode(): "provisional-local" | "jwt-pg" {
  const explicit = (process.env.AUTH_MODE ?? "").trim().toLowerCase();
  if (explicit === "jwt-pg") return "jwt-pg";
  if (explicit === "provisional-local") return "provisional-local";
  return process.env.DATABASE_URL?.trim() ? "jwt-pg" : "provisional-local";
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function resolveTrustProxy(raw: string | undefined): number | string | false {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "false" || trimmed === "0") return false;
  if (/^[1-5]$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed === "loopback" || trimmed === "linklocal" || trimmed === "uniquelocal") return trimmed;
  throw new Error(`Invalid TRUST_PROXY value '${raw}'. Allowed: false, 0..5, loopback, linklocal, uniquelocal.`);
}

async function startServer(): Promise<void> {
  const authMode = resolveAuthMode();
  const port = parsePositiveInt(process.env.PORT, 4100, 1, 65535);
  const defaultHost = authMode === "jwt-pg" ? "0.0.0.0" : "127.0.0.1";
  const host = (process.env.HOST || defaultHost).trim();
  const trustProxy = resolveTrustProxy(process.env.TRUST_PROXY);
  const requireNonSuperuserDb =
    process.env.REQUIRE_NON_SUPERUSER_DB === "true" ||
    (process.env.NODE_ENV === "production" && process.env.ALLOW_SUPERUSER_DB_RUNTIME !== "true");

  let db: PgDatabaseAdapter | undefined;

  if (authMode === "provisional-local") {
    if (process.env.NODE_ENV === "production" || !ALLOWED_LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `PROVISIONAL_AUTH_LOOPBACK_ONLY: Phase D1 prototype header authentication cannot bind to '${host}' or run in production mode.`,
      );
    }
  } else {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when AUTH_MODE=jwt-pg.");
    }
    // Fail closed immediately on startup if JWT_SECRET is missing or weak
    getJwtSecret();

    const poolMax = parsePositiveInt(process.env.PG_POOL_MAX, 10, 1, 100);
    const statementTimeout = parsePositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 15_000, 1_000, 120_000);
    const sslMode = (process.env.PG_SSL_MODE ?? "").trim().toLowerCase();
    if (sslMode && sslMode !== "disable" && sslMode !== "require" && sslMode !== "verify-full") {
      throw new Error(`Invalid PG_SSL_MODE '${sslMode}'. Allowed: disable, require, verify-full.`);
    }

    db = new NodePgDatabaseAdapter(databaseUrl, {
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: statementTimeout,
      ...(sslMode === "require" || sslMode === "verify-full"
        ? { ssl: { rejectUnauthorized: sslMode === "verify-full" } }
        : {}),
    });

    if (process.env.AUTO_MIGRATE_ON_START === "true") {
      await initializePostgreSqlSchema(db);
    }
  }

  let shuttingDown = false;
  const app = createApiApp({
    authMode,
    db,
    trustProxy,
    requireNonSuperuserDb,
    isShuttingDown: () => shuttingDown,
    rateLimit: {
      enabled: process.env.DISABLE_RATE_LIMIT !== "true",
      loginMaxPerWindow: parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, 15, 1, 1000),
      apiMaxPerWindow: parsePositiveInt(process.env.RATE_LIMIT_API_MAX, 300, 10, 10_000),
      windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000),
    },
  });

  const server = app.listen(port, host, () => {
    const modeLabel =
      authMode === "jwt-pg"
        ? "Phase D2 JWT + PostgreSQL RLS"
        : "Phase D1 Prototype — Loopback Only";
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "ai-office-suite-api",
        event: "server.started",
        authMode,
        modeLabel,
        host,
        port,
        trustProxy,
      })}\n`,
    );
  });

  // Protect against reverse-proxy keep-alive race (502) and Slowloris uploads
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "ai-office-suite-api",
        event: "server.shutdown_initiated",
        signal,
      })}\n`,
    );

    const forceTimer = setTimeout(() => {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          service: "ai-office-suite-api",
          event: "server.shutdown_forced_timeout",
        })}\n`,
      );
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(async () => {
      try {
        if (db) await db.close();
      } finally {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        service: "ai-office-suite-api",
        event: "process.unhandled_rejection",
        error: reason instanceof Error ? reason.message : String(reason),
      })}\n`,
    );
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        service: "ai-office-suite-api",
        event: "process.uncaught_exception",
        error: err.message,
      })}\n`,
    );
    shutdown("uncaughtException");
  });
}

startServer().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      service: "ai-office-suite-api",
      event: "server.startup_failed",
      error: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
});
