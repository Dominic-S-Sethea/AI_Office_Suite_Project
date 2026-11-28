import type { NextFunction, Request, Response } from "express";
import {
  checkAndIncrementPgRateLimit,
  pruneExpiredPgRateLimits,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";

export type RateLimitStoreMode = "memory" | "postgres";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys?: number;
  keyGenerator?: (req: Request) => string;
  onLimitExceeded?: (req: Request, key: string) => void;
}

export interface DistributedRateLimitOptions extends RateLimitOptions {
  db: PgDatabaseAdapter;
  pruneEveryRequests?: number;
  onBackendError?: (err: unknown, key: string) => void;
}

export interface RateLimitStats {
  totalAllowed: number;
  totalRejected: number;
  trackedKeys: number;
  store?: RateLimitStoreMode;
  fallbackCount?: number;
}

export interface SlidingWindowRateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  getStats: () => RateLimitStats;
  reset: () => void;
}

function defaultClientKey(req: Request): string {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return String(ip).trim().slice(0, 128);
}

/**
 * Zero-dependency, memory-bounded sliding-window rate limiter.
 * Caps tracked buckets (intelligent eviction) so spoofed IP floods cannot exhaust heap memory.
 */
export function createSlidingWindowRateLimiter(options: RateLimitOptions): SlidingWindowRateLimiter {
  const windowMs = Math.max(1_000, Math.trunc(options.windowMs));
  const maxRequests = Math.max(1, Math.trunc(options.maxRequests));
  const maxTrackedKeys = Math.max(100, Math.trunc(options.maxTrackedKeys ?? 5_000));
  const keyFn = options.keyGenerator ?? defaultClientKey;

  const buckets = new Map<string, number[]>();
  let totalAllowed = 0;
  let totalRejected = 0;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const key = keyFn(req);

    const existing = buckets.get(key) ?? [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= maxRequests) {
      totalRejected++;
      const oldestActive = active[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldestActive + windowMs - now) / 1000));
      buckets.set(key, active);
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(retryAfterSec));
      options.onLimitExceeded?.(req, key);
      res.status(429).json({
        error: "Too many requests. Please wait before retrying.",
        code: "RATE_LIMITED",
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    active.push(now);
    if (!buckets.has(key) && buckets.size >= maxTrackedKeys) {
      // Phase 1: sweep expired buckets first (H15 — never evict active throttled attackers when expired slots exist)
      let evicted = 0;
      for (const [candidateKey, timestamps] of buckets) {
        const lastTs = timestamps[timestamps.length - 1] ?? 0;
        if (lastTs <= cutoff) {
          buckets.delete(candidateKey);
          evicted++;
          if (buckets.size < maxTrackedKeys) break;
        }
      }
      // Phase 2: if still at capacity, evict the lowest-hit non-saturated bucket rather than a blocked attacker
      if (evicted === 0 && buckets.size >= maxTrackedKeys) {
        let victimKey: string | undefined;
        let minHits = Number.POSITIVE_INFINITY;
        for (const [candidateKey, timestamps] of buckets) {
          const hits = timestamps.length;
          if (hits < maxRequests && hits < minHits) {
            minHits = hits;
            victimKey = candidateKey;
            if (hits <= 1) break;
          }
        }
        const fallbackKey = victimKey ?? buckets.keys().next().value;
        if (fallbackKey !== undefined) buckets.delete(fallbackKey);
      }
    }
    buckets.set(key, active);
    totalAllowed++;

    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - active.length)));
    next();
  };

  return {
    middleware,
    getStats: () => ({
      totalAllowed,
      totalRejected,
      trackedKeys: buckets.size,
    }),
    reset: () => {
      buckets.clear();
      totalAllowed = 0;
      totalRejected = 0;
    },
  };
}

/**
 * Multi-replica PostgreSQL-backed rate limiter executing atomic window rollovers via the
 * least-privilege SECURITY DEFINER routine `rate_limit_check_and_increment`.
 * Falls back cleanly to a local memory-bounded sliding window if the database experiences a transient fault.
 */
export function createPostgresBackedRateLimiter(options: DistributedRateLimitOptions): SlidingWindowRateLimiter {
  const windowMs = Math.max(1_000, Math.trunc(options.windowMs));
  const maxRequests = Math.max(1, Math.trunc(options.maxRequests));
  const maxTrackedKeys = Math.max(100, Math.trunc(options.maxTrackedKeys ?? 5_000));
  const pruneEvery = Math.max(25, Math.trunc(options.pruneEveryRequests ?? 250));
  const keyFn = options.keyGenerator ?? defaultClientKey;
  const fallbackLimiter = createSlidingWindowRateLimiter(options);

  const recentKeys = new Set<string>();
  let totalAllowed = 0;
  let totalRejected = 0;
  let fallbackCount = 0;
  let requestCounter = 0;

  const trackKey = (key: string) => {
    if (!recentKeys.has(key) && recentKeys.size >= maxTrackedKeys) {
      const oldest = recentKeys.values().next().value;
      if (oldest !== undefined) recentKeys.delete(oldest);
    }
    recentKeys.add(key);
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    requestCounter++;
    const shouldPrune = requestCounter % pruneEvery === 0;

    void checkAndIncrementPgRateLimit(options.db, key, windowMs, maxRequests)
      .then((decision) => {
        if (shouldPrune) {
          void pruneExpiredPgRateLimits(options.db, 250).catch(() => undefined);
        }
        if (res.writableEnded) return;

        trackKey(key);
        res.setHeader("X-RateLimit-Store", "postgres");
        res.setHeader("X-RateLimit-Limit", String(maxRequests));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - decision.currentCount)));

        if (!decision.allowed) {
          totalRejected++;
          const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
          res.setHeader("Retry-After", String(retryAfterSec));
          options.onLimitExceeded?.(req, key);
          res.status(429).json({
            error: "Too many requests. Please wait before retrying.",
            code: "RATE_LIMITED",
            retryAfterSeconds: retryAfterSec,
          });
          return;
        }

        totalAllowed++;
        next();
      })
      .catch((err) => {
        if (res.writableEnded) return;
        fallbackCount++;
        options.onBackendError?.(err, key);
        res.setHeader("X-RateLimit-Store", "memory-fallback");
        fallbackLimiter.middleware(req, res, next);
      });
  };

  return {
    middleware,
    getStats: () => {
      const fbStats = fallbackLimiter.getStats();
      return {
        totalAllowed: totalAllowed + fbStats.totalAllowed,
        totalRejected: totalRejected + fbStats.totalRejected,
        trackedKeys: Math.max(recentKeys.size, fbStats.trackedKeys),
        store: "postgres",
        fallbackCount,
      };
    },
    reset: () => {
      recentKeys.clear();
      totalAllowed = 0;
      totalRejected = 0;
      fallbackCount = 0;
      requestCounter = 0;
      fallbackLimiter.reset();
    },
  };
}
