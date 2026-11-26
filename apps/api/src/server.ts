import {
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import { getJwtSecret } from "@ai-office-suite/identity";
import { createApiApp } from "./app.ts";
import { loadApiServerConfig } from "./config.ts";

async function startServer(): Promise<void> {
  const config = loadApiServerConfig(process.env);
  let db: PgDatabaseAdapter | undefined;

  if (config.authMode === "jwt-pg") {
    // Fail closed immediately on startup if JWT_SECRET is missing or weak
    getJwtSecret();

    db = new NodePgDatabaseAdapter(config.databaseUrl!, config.pgPoolConfig);

    if (config.autoMigrateOnStart) {
      await initializePostgreSqlSchema(db);
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
