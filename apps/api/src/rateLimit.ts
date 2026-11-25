import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys?: number;
  keyGenerator?: (req: Request) => string;
  onLimitExceeded?: (req: Request, key: string) => void;
}

export interface RateLimitStats {
  totalAllowed: number;
  totalRejected: number;
  trackedKeys: number;
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
 * Caps tracked buckets (FIFO eviction) so spoofed IP floods cannot exhaust heap memory.
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
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
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
