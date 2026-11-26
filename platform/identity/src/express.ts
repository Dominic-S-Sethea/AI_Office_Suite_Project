import type { NextFunction, Request, Response } from "express";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { isWorkspaceRole } from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter } from "@ai-office-suite/database";
import {
  parseCookie,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  verifySessionToken,
} from "./authService.ts";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;

export interface AuthenticatedRequest extends Request {
  actor?: ActorContext;
  authSource?: "bearer" | "cookie";
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (process.env.NODE_ENV === "production" || req.secure) {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production" || req.secure) {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function verifyCookieCsrf(
  req: Request,
  res: Response,
  allowedOrigins: readonly string[],
): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite.trim().length > 0) {
    const normalizedSite = fetchSite.trim().toLowerCase();
    // Reject cross-site AND same-site (sibling subdomain) cookie mutations; only allow same-origin or direct none (H2)
    if (normalizedSite !== "same-origin" && normalizedSite !== "none") {
      res.status(403).json({ error: "Cross-origin or sibling-site request rejected", code: "CSRF_ORIGIN_REJECTED" });
      return false;
    }
  }

  const originHeader = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  const refererHeader = typeof req.headers.referer === "string" ? req.headers.referer.trim() : "";
  const requestOrigin = originHeader
    ? normalizeOrigin(originHeader)
    : refererHeader
      ? normalizeOrigin(refererHeader)
      : null;

  if (!requestOrigin) {
    res.status(403).json({ error: "Missing origin for cookie mutation", code: "CSRF_ORIGIN_REJECTED" });
    return false;
  }

  const allowed = new Set<string>();
  for (const orig of allowedOrigins) {
    const n = normalizeOrigin(orig);
    if (n) allowed.add(n);
  }
  // Never trust arbitrary Host headers in production; in non-prod only permit matching loopback hosts (H2)
  if (process.env.NODE_ENV !== "production") {
    const host = typeof req.headers.host === "string" ? req.headers.host.trim().toLowerCase() : "";
    if (host && LOOPBACK_HOST_PATTERN.test(host)) {
      allowed.add(`http://${host}`);
    }
  }

  if (!allowed.has(requestOrigin)) {
    res.status(403).json({ error: "Origin not allowed", code: "CSRF_ORIGIN_REJECTED" });
    return false;
  }
  return true;
}

export function createJwtAuthMiddleware(
  db: PgDatabaseAdapter,
  allowedOrigins: readonly string[],
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    let token = "";
    let authSource: "bearer" | "cookie";
    if (bearerToken) {
      token = bearerToken;
      authSource = "bearer";
    } else {
      const cookieToken = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
      if (!cookieToken) {
        res.status(401).json({ error: "Authentication required", code: "MISSING_TOKEN" });
        return;
      }
      token = cookieToken;
      authSource = "cookie";
    }

    if (authSource === "cookie" && STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
      if (!verifyCookieCsrf(req, res, allowedOrigins)) return;
    }

    const claims = verifySessionToken(token);
    if (!claims) {
      res.status(401).json({ error: "Invalid or expired session token", code: "INVALID_TOKEN" });
      return;
    }

    // Reject forged tenant/workspace headers that conflict with authenticated JWT claims
    const headerTenant = req.header("x-tenant-id")?.trim();
    const headerWorkspace = req.header("x-workspace-id")?.trim();
    if (
      (headerTenant && headerTenant !== claims.tenantId) ||
      (headerWorkspace && headerWorkspace !== claims.workspaceId)
    ) {
      res.status(403).json({
        error: "Cross-tenant or cross-workspace header mismatch denied.",
        code: "TENANT_ISOLATION_DENIED",
      });
      return;
    }

    // Live PostgreSQL re-verification of user status, org status, epoch `token_version`, and live RBAC role
    try {
      const liveRes = await db.query<{
        status: string;
        token_version: number;
        role: string;
        org_status: string;
      }>(
        `SELECT u.status, u.token_version, m.role, o.status AS org_status
         FROM users u
         JOIN memberships m ON m.user_id = u.user_id
         JOIN organizations o ON o.tenant_id = m.tenant_id
         WHERE u.user_id = $1::uuid AND m.tenant_id = $2::uuid AND m.workspace_id = $3::uuid`,
        [claims.userId, claims.tenantId, claims.workspaceId],
      );
      const live = liveRes.rows[0];
      if (!live) {
        res.status(403).json({ error: "Account or workspace membership revoked", code: "ACCOUNT_REVOKED" });
        return;
      }
      if (live.org_status !== "active") {
        res.status(403).json({ error: "Organization is suspended", code: "ORGANIZATION_SUSPENDED" });
        return;
      }
      if (live.status !== "active") {
        res.status(403).json({ error: "Account is inactive or deleted", code: "ACCOUNT_INACTIVE" });
        return;
      }
      if (claims.tv !== live.token_version) {
        res.status(401).json({ error: "Session revoked; please sign in again", code: "TOKEN_REVOKED" });
        return;
      }
      if (!isWorkspaceRole(live.role)) {
        res.status(403).json({ error: "Invalid workspace role", code: "FORBIDDEN_ROLE" });
        return;
      }

      req.actor = {
        tenantId: claims.tenantId,
        workspaceId: claims.workspaceId,
        userId: claims.userId,
        role: live.role,
      };
      req.authSource = authSource;
      next();
    } catch {
      res.status(500).json({ error: "Authentication check failed", code: "AUTH_BACKEND_ERROR" });
    }
  };
}
