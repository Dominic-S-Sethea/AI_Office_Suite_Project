import { z } from "zod";
import { createPgPoolConfigFromEnv } from "@ai-office-suite/database";
import type { PoolConfig } from "pg";

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const optionalIntString = (name: string, min: number, max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw, ctx): number => {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) return fallback;
      if (!/^\d+$/.test(trimmed)) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid ${name} '${raw}': expected integer in [${min}, ${max}].`,
        });
        return z.NEVER;
      }
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid ${name} '${raw}': expected integer in [${min}, ${max}].`,
        });
        return z.NEVER;
      }
      return n;
    });

const trustProxySchema = z
  .string()
  .optional()
  .transform((raw, ctx): number | string | false => {
    const trimmed = (raw ?? "").trim().toLowerCase();
    if (!trimmed || trimmed === "false" || trimmed === "0") return false;
    if (/^[1-5]$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    if (trimmed === "loopback" || trimmed === "linklocal" || trimmed === "uniquelocal") return trimmed;
    ctx.addIssue({
      code: "custom",
      message: `Invalid TRUST_PROXY value '${raw}'. Allowed: false, 0..5, loopback, linklocal, uniquelocal.`,
    });
    return z.NEVER;
  });

const authModeEnvSchema = z
  .string()
  .optional()
  .transform((raw, ctx): "provisional-local" | "jwt-pg" | "" => {
    const trimmed = (raw ?? "").trim().toLowerCase();
    if (!trimmed) return "";
    if (trimmed === "provisional-local" || trimmed === "jwt-pg") return trimmed;
    ctx.addIssue({
      code: "custom",
      message: `Invalid AUTH_MODE '${raw}'. Allowed: provisional-local, jwt-pg.`,
    });
    return z.NEVER;
  });

const apiEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  AUTH_MODE: authModeEnvSchema,
  PORT: optionalIntString("PORT", 1, 65535, 4100),
  HOST: z.string().optional(),
  TRUST_PROXY: trustProxySchema,
  DATABASE_URL: z.string().optional(),
  REQUIRE_NON_SUPERUSER_DB: z.string().optional(),
  ALLOW_SUPERUSER_DB_RUNTIME: z.string().optional(),
  AUTO_MIGRATE_ON_START: z.string().optional(),
  DISABLE_RATE_LIMIT: z.string().optional(),
  RATE_LIMIT_LOGIN_MAX: optionalIntString("RATE_LIMIT_LOGIN_MAX", 1, 1000, 15),
  RATE_LIMIT_LOGIN_IP_MAX: optionalIntString("RATE_LIMIT_LOGIN_IP_MAX", 1, 5000, 60),
  RATE_LIMIT_API_MAX: optionalIntString("RATE_LIMIT_API_MAX", 10, 10_000, 300),
  RATE_LIMIT_WINDOW_MS: optionalIntString("RATE_LIMIT_WINDOW_MS", 1_000, 3_600_000, 60_000),
  MAX_CONCURRENT_PDF_EXPORTS: optionalIntString("MAX_CONCURRENT_PDF_EXPORTS", 1, 16, 2),
  MAX_CONCURRENT_DATA_PREP: optionalIntString("MAX_CONCURRENT_DATA_PREP", 1, 16, 2),
  READY_CACHE_TTL_MS: optionalIntString("READY_CACHE_TTL_MS", 0, 60_000, 2_000),
});

export interface ApiServerConfig {
  nodeEnv: string;
  authMode: "provisional-local" | "jwt-pg";
  port: number;
  host: string;
  trustProxy: number | string | false;
  databaseUrl?: string;
  pgPoolConfig?: Omit<PoolConfig, "connectionString">;
  requireNonSuperuserDb: boolean;
  autoMigrateOnStart: boolean;
  readyCacheTtlMs: number;
  maxConcurrentPdfExports: number;
  maxConcurrentDataPrep: number;
  rateLimit: {
    enabled: boolean;
    loginMaxPerWindow: number;
    loginIpMaxPerWindow: number;
    apiMaxPerWindow: number;
    windowMs: number;
  };
}

/**
 * Zod-validated fail-closed API runtime configuration loader (L5, M18).
 */
export function loadApiServerConfig(
  env: Record<string, string | undefined> = process.env,
  opts?: { onWarn?: (msg: string) => void },
): ApiServerConfig {
  const parsed = apiEnvSchema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(first?.message ?? "Invalid API environment configuration.");
  }
  const v = parsed.data;
  const nodeEnv = (v.NODE_ENV ?? "development").trim().toLowerCase();
  const databaseUrl = v.DATABASE_URL?.trim() || undefined;
  const authMode: "provisional-local" | "jwt-pg" =
    v.AUTH_MODE || (databaseUrl ? "jwt-pg" : "provisional-local");

  const defaultHost = authMode === "jwt-pg" ? "0.0.0.0" : "127.0.0.1";
  const host = (v.HOST?.trim() || defaultHost).trim();

  if (authMode === "provisional-local") {
    if (nodeEnv === "production" || !ALLOWED_LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `PROVISIONAL_AUTH_LOOPBACK_ONLY: Phase D1 prototype header authentication cannot bind to '${host}' or run in production mode.`,
      );
    }
  } else if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when AUTH_MODE=jwt-pg.");
  }

  const pgPoolConfig = authMode === "jwt-pg" ? createPgPoolConfigFromEnv(env, opts) : undefined;
  const requireNonSuperuserDb =
    v.REQUIRE_NON_SUPERUSER_DB === "true" ||
    (nodeEnv === "production" && v.ALLOW_SUPERUSER_DB_RUNTIME !== "true");

  return {
    nodeEnv,
    authMode,
    port: v.PORT,
    host,
    trustProxy: v.TRUST_PROXY,
    databaseUrl,
    pgPoolConfig,
    requireNonSuperuserDb,
    autoMigrateOnStart: v.AUTO_MIGRATE_ON_START === "true",
    readyCacheTtlMs: v.READY_CACHE_TTL_MS,
    maxConcurrentPdfExports: v.MAX_CONCURRENT_PDF_EXPORTS,
    maxConcurrentDataPrep: v.MAX_CONCURRENT_DATA_PREP,
    rateLimit: {
      enabled: v.DISABLE_RATE_LIMIT !== "true",
      loginMaxPerWindow: v.RATE_LIMIT_LOGIN_MAX,
      loginIpMaxPerWindow: v.RATE_LIMIT_LOGIN_IP_MAX,
      apiMaxPerWindow: v.RATE_LIMIT_API_MAX,
      windowMs: v.RATE_LIMIT_WINDOW_MS,
    },
  };
}
