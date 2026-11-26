import type { Express, Request, RequestHandler } from "express";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { assertCanPerform } from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter } from "@ai-office-suite/database";
import {
  authenticateUserWithPassword,
  parseCookie,
  revokeUserSessions,
  SESSION_COOKIE_NAME,
} from "@ai-office-suite/identity";
import {
  clearSessionCookie,
  createJwtAuthMiddleware,
  setSessionCookie,
  verifyCookieCsrf,
  type AuthenticatedRequest,
} from "@ai-office-suite/identity/express";
import { loginRequestSchema } from "@ai-office-suite/validation";
import type { ApiObservabilityHandle } from "../observability.ts";
import type { SlidingWindowRateLimiter } from "../rateLimit.ts";

export interface AuthRoutesDeps {
  useJwtPg: boolean;
  authMode: "provisional-local" | "jwt-pg";
  db?: PgDatabaseAdapter;
  allowedOrigins: readonly string[];
  rateLimitEnabled: boolean;
  loginLimiter: SlidingWindowRateLimiter;
  loginIpLimiter: SlidingWindowRateLimiter;
  apiLimiter: SlidingWindowRateLimiter;
  observability: ApiObservabilityHandle;
  resolvePrototypeActor: (req: Request) => ActorContext;
}

export function registerAuthAndMetricsRoutes(app: Express, deps: AuthRoutesDeps): void {
  const {
    useJwtPg,
    authMode,
    db,
    allowedOrigins,
    rateLimitEnabled,
    loginLimiter,
    loginIpLimiter,
    apiLimiter,
    observability,
    resolvePrototypeActor,
  } = deps;

  if (useJwtPg && db) {
    const jwtMiddleware = createJwtAuthMiddleware(db, allowedOrigins);

    if (rateLimitEnabled) {
      app.use("/api/auth/login", loginLimiter.middleware);
      app.use("/api/auth/token", loginLimiter.middleware);
    }

    const metricsMiddleware: RequestHandler[] = [
      jwtMiddleware as unknown as RequestHandler,
      ...(rateLimitEnabled ? [apiLimiter.middleware] : []),
    ];

    app.get("/api/metrics", ...metricsMiddleware, (req, res, next) => {
      try {
        const authReq = req as AuthenticatedRequest;
        assertCanPerform(authReq.actor!, "metrics", "read");
        const accept = String(req.headers.accept ?? "");
        const wantsProm =
          req.query.format === "prometheus" ||
          accept.includes("text/plain") ||
          accept.includes("application/openmetrics-text");
        if (wantsProm && observability.formatPrometheusMetrics) {
          res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
          res.send(observability.formatPrometheusMetrics(db.getPoolStats ? db.getPoolStats() : undefined));
          return;
        }
        res.json({
          service: "ai-office-suite-api",
          authMode,
          metrics: observability.getMetrics(),
          rateLimits: {
            enabled: rateLimitEnabled,
            login: loginLimiter.getStats(),
            loginIp: loginIpLimiter.getStats(),
            api: apiLimiter.getStats(),
          },
          ...(db.getPoolStats ? { dbPool: db.getPoolStats() } : {}),
        });
      } catch (err) {
        next(err);
      }
    });

    app.post("/api/auth/login", async (req, res, next) => {
      try {
        const parsed = loginRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid login credentials payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
          return;
        }
        const session = await authenticateUserWithPassword({
          db,
          email: parsed.data.email,
          password: parsed.data.password,
          tenantId: parsed.data.tenantId,
          workspaceId: parsed.data.workspaceId,
        });
        setSessionCookie(req, res, session.token);
        // Browser login issues HttpOnly session cookie only — never leaks raw JWT into JS response body (H2)
        res.json({ actor: session.actor });
      } catch (err) {
        next(err);
      }
    });

    // Dedicated programmatic Bearer token endpoint (CLI / service integrations); rejects browser origins (H2)
    app.post("/api/auth/token", async (req, res, next) => {
      try {
        if (req.headers.origin || req.headers["sec-fetch-site"]) {
          res.status(403).json({
            error: "Programmatic token endpoint cannot be invoked from browser origins; use /api/auth/login.",
            code: "BROWSER_TOKEN_ENDPOINT_BLOCKED",
          });
          return;
        }
        const parsed = loginRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid login credentials payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
          return;
        }
        const session = await authenticateUserWithPassword({
          db,
          email: parsed.data.email,
          password: parsed.data.password,
          tenantId: parsed.data.tenantId,
          workspaceId: parsed.data.workspaceId,
          tokenExpiresIn: "2h",
        });
        res.json({
          token: session.token,
          tokenType: "Bearer",
          expiresInSeconds: 7200,
          actor: session.actor,
        });
      } catch (err) {
        next(err);
      }
    });

    app.post("/api/auth/logout", (req, res) => {
      const hasBearer = Boolean(req.headers.authorization?.startsWith("Bearer "));
      const hasCookie = Boolean(parseCookie(req.headers.cookie, SESSION_COOKIE_NAME));
      if (!hasBearer && hasCookie) {
        if (!verifyCookieCsrf(req, res, allowedOrigins)) return;
      }
      clearSessionCookie(req, res);
      res.json({ ok: true });
    });

    app.get("/api/auth/me", jwtMiddleware, (req, res) => {
      const authReq = req as AuthenticatedRequest;
      res.json({ actor: authReq.actor, authSource: authReq.authSource });
    });

    app.post("/api/auth/revoke-sessions", jwtMiddleware, async (req, res, next) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const nextVersion = await revokeUserSessions(db, authReq.actor!.userId);
        clearSessionCookie(req, res);
        res.json({ revoked: true, tokenVersion: nextVersion });
      } catch (err) {
        next(err);
      }
    });

    // Enforce JWT + PostgreSQL RLS live membership check on all document, speech & data-prep routes
    app.use("/api/documents", jwtMiddleware);
    app.use("/api/speech", jwtMiddleware);
    app.use("/api/data-prep", jwtMiddleware);
    if (rateLimitEnabled) {
      app.use("/api/documents", apiLimiter.middleware);
      app.use("/api/speech", apiLimiter.middleware);
      app.use("/api/data-prep", apiLimiter.middleware);
    }
    return;
  }

  if (rateLimitEnabled) {
    app.use("/api/documents", apiLimiter.middleware);
    app.use("/api/speech", apiLimiter.middleware);
    app.use("/api/data-prep", apiLimiter.middleware);
  }
  app.get("/api/metrics", (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      assertCanPerform(actor, "metrics", "read");
      const accept = String(req.headers.accept ?? "");
      const wantsProm =
        req.query.format === "prometheus" ||
        accept.includes("text/plain") ||
        accept.includes("application/openmetrics-text");
      if (wantsProm && observability.formatPrometheusMetrics) {
        res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.send(observability.formatPrometheusMetrics());
        return;
      }
      res.json({
        service: "ai-office-suite-api",
        authMode,
        metrics: observability.getMetrics(),
        rateLimits: {
          enabled: rateLimitEnabled,
          login: loginLimiter.getStats(),
          api: apiLimiter.getStats(),
        },
      });
    } catch (err) {
      next(err);
    }
  });
}
