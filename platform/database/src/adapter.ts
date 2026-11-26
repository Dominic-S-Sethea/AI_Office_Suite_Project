import { Pool, type PoolClient, type PoolConfig } from "pg";

interface PgliteLike {
  waitReady: Promise<unknown>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface PgQueryExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface PgPoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface PgDatabaseAdapter extends PgQueryExecutor {
  readonly engine: "pglite" | "node-pg";
  withTransaction<T>(fn: (tx: PgQueryExecutor) => Promise<T>): Promise<T>;
  getPoolStats?(): PgPoolStats;
  close(): Promise<void>;
}

export class PgliteDatabaseAdapter implements PgDatabaseAdapter {
  readonly engine = "pglite" as const;
  private readonly dataDir?: string;
  private dbPromise: Promise<PgliteLike> | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir;
  }

  private async getDb(): Promise<PgliteLike> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const mod = (await import("@electric-sql/pglite")) as unknown as {
          PGlite: new (dataDir?: string) => PgliteLike;
        };
        const instance = this.dataDir ? new mod.PGlite(this.dataDir) : new mod.PGlite();
        await instance.waitReady;
        return instance;
      })();
    }
    return this.dbPromise;
  }

  async ready(): Promise<void> {
    await this.getDb();
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResult<T>> {
    const db = await this.getDb();
    const res = await db.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    const db = await this.getDb();
    await db.exec(sql);
  }

  async withTransaction<T>(fn: (tx: PgQueryExecutor) => Promise<T>): Promise<T> {
    const db = await this.getDb();
    return db.transaction(async (pgTx) => {
      const executor: PgQueryExecutor = {
        query: async <R extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) => {
          const res = await pgTx.query<R>(sql, params);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          };
        },
        exec: async (sql: string) => {
          await pgTx.exec(sql);
        },
      };
      return fn(executor);
    });
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    await db.close();
  }
}

export class NodePgDatabaseAdapter implements PgDatabaseAdapter {
  readonly engine = "node-pg" as const;
  private readonly pool: Pool;

  constructor(
    connectionString: string,
    poolOptions?: Omit<PoolConfig, "connectionString"> & { onPoolError?: (err: Error) => void },
  ) {
    const { onPoolError, ...pgOptions } = poolOptions ?? {};
    this.pool = new Pool({ ...pgOptions, connectionString });
    this.pool.on("error", (err) => {
      if (onPoolError) {
        onPoolError(err);
      } else {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            event: "db.pool_idle_client_error",
            errorName: err.name,
            message: err.message,
          }),
        );
      }
    });
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResult<T>> {
    const res = await this.pool.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async withTransaction<T>(fn: (tx: PgQueryExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    let releaseErr: Error | undefined;
    try {
      await client.query("BEGIN");
      const executor: PgQueryExecutor = {
        query: async <R extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) => {
          const res = await client.query<R>(sql, params);
          return {
            rows: res.rows,
            rowCount: res.rowCount ?? res.rows.length,
          };
        },
        exec: async (sql: string) => {
          await client.query(sql);
        },
      };
      const out = await fn(executor);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rbErr) {
        releaseErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      }
      throw err;
    } finally {
      client.release(releaseErr);
    }
  }

  getPoolStats(): PgPoolStats {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
