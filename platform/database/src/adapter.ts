import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient, type PoolConfig } from "pg";

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

export interface PgDatabaseAdapter extends PgQueryExecutor {
  readonly engine: "pglite" | "node-pg";
  withTransaction<T>(fn: (tx: PgQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PgliteDatabaseAdapter implements PgDatabaseAdapter {
  readonly engine = "pglite" as const;
  private readonly db: PGlite;

  constructor(dataDir?: string) {
    this.db = dataDir ? new PGlite(dataDir) : new PGlite();
  }

  async ready(): Promise<void> {
    await this.db.waitReady;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResult<T>> {
    const res = await this.db.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async withTransaction<T>(fn: (tx: PgQueryExecutor) => Promise<T>): Promise<T> {
    await this.db.waitReady;
    return this.db.transaction(async (pgTx) => {
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
    await this.db.close();
  }
}

export class NodePgDatabaseAdapter implements PgDatabaseAdapter {
  readonly engine = "node-pg" as const;
  private readonly pool: Pool;

  constructor(connectionString: string, poolOptions?: Omit<PoolConfig, "connectionString">) {
    this.pool = new Pool({ ...poolOptions, connectionString });
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
