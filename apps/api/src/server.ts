import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import { getJwtSecret } from "@ai-office-suite/identity";
import { redactAuditString } from "@ai-office-suite/audit";
import { createApiApp } from "./app.ts";
import { loadApiServerConfig } from "./config.ts";

export interface GracefulShutdownOptions {
  server: Pick<Server, "close"> & { closeIdleConnections?: () => void };
  db?: Pick<PgDatabaseAdapter, "close">;
  exitFn?: (code: number) => void;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
  timeoutMs?: number;
}

export function createGracefulShutdown(options: GracefulShutdownOptions): (signal: string) => void {
  const {
    server,
    db,
    exitFn = (code: number) => process.exit(code),
    writeStdout = (line: string) => process.stdout.write(line),
    writeStderr = (line: string) => process.stderr.write(line),
    timeoutMs = 10_000,
  } = options;
  let shuttingDown = false;

  return (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeStdout(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "ai-office-suite-api",
        event: "server.shutdown_initiated",
        signal,
      })}\n`,
    );

    const forceTimer = setTimeout(() => {
      writeStderr(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          service: "ai-office-suite-api",
          event: "server.shutdown_forced_timeout",
        })}\n`,
      );
      exitFn(1);
    }, timeoutMs);
    forceTimer.unref?.();

    server.close(async (closeErr) => {
      let exitCode = closeErr || signal === "uncaughtException" || signal === "unhandledRejection" ? 1 : 0;
      if (closeErr) {
        process.stderr.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            service: "ai-office-suite-api",
            event: "server.close_error",
            error: redactAuditString(closeErr instanceof Error ? closeErr.message : String(closeErr)),
          })}\n`,
        );
      }
      try {
        if (db) await db.close();
      } catch (dbCloseErr) {
        exitCode = 1;
        process.stderr.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            service: "ai-office-suite-api",
            event: "db.close_error",
            error: redactAuditString(dbCloseErr instanceof Error ? dbCloseErr.message : String(dbCloseErr)),
          })}\n`,
        );
      } finally {
        clearTimeout(forceTimer);
        exitFn(exitCode);
      }
    });
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
  };
}

async function startServer(): Promise<void> {
  const config = loadApiServerConfig(process.env);
  let db: PgDatabaseAdapter | undefined;

  if (config.authMode === "jwt-pg") {
    // Fail closed immediately on startup if JWT_SECRET is missing or weak
    getJwtSecret();

    db = new NodePgDatabaseAdapter(config.databaseUrl!, config.pgPoolConfig);

    if (config.autoMigrateOnStart) {
      await initializePostgreSqlSchema(db);
      await initializePaGovernanceSchema(db);
    }
  }

  let shuttingDown = false;
  const app = createApiApp({
    authMode: config.authMode,
    db,
    trustProxy: config.trustProxy,
    requireNonSuperuserDb: config.requireNonSuperuserDb,
    isShuttingDown: () => shuttingDown,
    readyCacheTtlMs: config.readyCacheTtlMs,
    maxConcurrentPdfExports: config.maxConcurrentPdfExports,
    maxConcurrentDataPrep: config.maxConcurrentDataPrep,
    rateLimit: config.rateLimit,
    workers: config.workers,
  });

  const server = app.listen(config.port, config.host, () => {
    const modeLabel =
      config.authMode === "jwt-pg"
        ? "Phase D2 JWT + PostgreSQL RLS"
        : "Phase D1 Prototype — Loopback Only";
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "ai-office-suite-api",
        event: "server.started",
        authMode: config.authMode,
        modeLabel,
        host: config.host,
        port: config.port,
        trustProxy: config.trustProxy,
        rateLimitStore: config.rateLimit.store,
        isolatedParsers: config.workers.isolatedParsers,
      })}\n`,
    );
  });

  // Protect against reverse-proxy keep-alive race (502) and Slowloris uploads
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  const baseShutdown = createGracefulShutdown({ server, db });
  const shutdown = (signal: string) => {
    shuttingDown = true;
    baseShutdown(signal);
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
        error: redactAuditString(reason instanceof Error ? reason.message : String(reason)),
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
        error: redactAuditString(err.message),
      })}\n`,
    );
    shutdown("uncaughtException");
  });
}

function isEntrypointModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolvedEntry = path.resolve(entry);
  const currentFile = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? resolvedEntry.toLowerCase() === currentFile.toLowerCase()
    : resolvedEntry === currentFile;
}

if (isEntrypointModule()) {
  startServer().catch((err) => {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        service: "ai-office-suite-api",
        event: "server.startup_failed",
        error: redactAuditString(err instanceof Error ? err.message : String(err)),
      })}\n`,
    );
    process.exit(1);
  });
}
