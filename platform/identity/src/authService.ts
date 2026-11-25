import bcrypt from "bcryptjs";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import type { ActorContext, WorkspaceRole } from "@ai-office-suite/shared-contracts";
import { isWorkspaceRole } from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter } from "@ai-office-suite/database";

export const SESSION_COOKIE_NAME = "aios_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 604800; // 7 days
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class AuthenticationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AuthenticatedRequest extends Request {
  actor?: ActorContext;
  authSource?: "bearer" | "cookie";
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (process.env.NODE_ENV === "production") {
    if (
      !secret ||
      secret.length < 32 ||
      /(changeme|placeholder|super_secret|dev_key|example_secret|default_secret|replace-with)/i.test(secret)
    ) {
      throw new Error("JWT_SECRET must be set to a strong non-placeholder secret (>= 32 chars) in production.");
    }
    return secret;
  }
  if (secret && secret.length >= 32) {
    return secret;
  }
  if (process.env.NODE_ENV === "test" || process.env.ALLOW_DEV_JWT_SECRET === "true") {
    return "aios-ephemeral-test-jwt-secret-min-32-chars-only";
  }
  throw new Error("JWT_SECRET (>= 32 chars) is required outside tests.");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key !== name) continue;
    let rawVal = part.slice(eqIdx + 1).trim();
    if (rawVal.length >= 2 && rawVal.startsWith('"') && rawVal.endsWith('"')) {
      rawVal = rawVal.slice(1, -1);
    }
    if (!rawVal) return null;
    try {
      return decodeURIComponent(rawVal);
    } catch {
      return rawVal;
    }
  }
  return null;
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
  if (typeof fetchSite === "string" && fetchSite.trim().toLowerCase() === "cross-site") {
    res.status(403).json({ error: "Cross-site request rejected", code: "CSRF_ORIGIN_REJECTED" });
    return false;
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
  const host = typeof req.headers.host === "string" ? req.headers.host.trim().toLowerCase() : "";
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }

  if (!allowed.has(requestOrigin)) {
    res.status(403).json({ error: "Origin not allowed", code: "CSRF_ORIGIN_REJECTED" });
    return false;
  }
  return true;
}

export interface SessionTokenClaims {
  userId: string;
  email: string;
  tenantId: string;
  workspaceId: string;
  role: WorkspaceRole;
  tv: number;
}

export function signSessionToken(claims: SessionTokenClaims): string {
  return jwt.sign(
    {
      sub: claims.userId,
      email: claims.email,
      tenant_id: claims.tenantId,
      workspace_id: claims.workspaceId,
      role: claims.role,
      tv: claims.tv,
    },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "7d" },
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifySessionToken(token: string): SessionTokenClaims | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
    if (typeof decoded === "string") return null;
    const p = decoded as JwtPayload;
    if (
      typeof p.sub !== "string" ||
      !UUID_PATTERN.test(p.sub) ||
      typeof p.email !== "string" ||
      typeof p.tenant_id !== "string" ||
      !UUID_PATTERN.test(p.tenant_id) ||
      typeof p.workspace_id !== "string" ||
      !UUID_PATTERN.test(p.workspace_id) ||
      typeof p.role !== "string" ||
      !isWorkspaceRole(p.role) ||
      typeof p.tv !== "number" ||
      !Number.isInteger(p.tv)
    ) {
      return null;
    }
    return {
      userId: p.sub,
      email: p.email,
      tenantId: p.tenant_id,
      workspaceId: p.workspace_id,
      role: p.role,
      tv: p.tv,
    };
  } catch {
    return null;
  }
}

// Constant-time sentinel bcrypt hash (cost 10, matches hashPassword) to prevent user-enumeration timing side-channels.
const DUMMY_BCRYPT_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export async function authenticateUserWithPassword(params: {
  db: PgDatabaseAdapter;
  email: string;
  password: string;
  tenantId: string;
  workspaceId: string;
}): Promise<{ token: string; actor: ActorContext }> {
  const userRes = await params.db.query<{
    user_id: string;
    email: string;
    password_hash: string;
    token_version: number;
    status: string;
  }>(
    "SELECT user_id, email, password_hash, token_version, status FROM users WHERE lower(email) = lower($1)",
    [params.email.trim()],
  );
  const user = userRes.rows[0];
  const passwordOk = await verifyPassword(params.password, user ? user.password_hash : DUMMY_BCRYPT_HASH);
  if (!user || !passwordOk) {
    throw new AuthenticationError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (user.status !== "active") {
    throw new AuthenticationError(403, "ACCOUNT_INACTIVE", "User account is not active.");
  }

  const memRes = await params.db.query<{ role: string }>(
    `SELECT m.role
     FROM memberships m
     JOIN organizations o ON o.tenant_id = m.tenant_id
     WHERE m.tenant_id = $1::uuid AND m.workspace_id = $2::uuid AND m.user_id = $3::uuid AND o.status = 'active'`,
    [params.tenantId, params.workspaceId, user.user_id],
  );
  const membership = memRes.rows[0];
  if (!membership || !isWorkspaceRole(membership.role)) {
    throw new AuthenticationError(403, "WORKSPACE_MEMBERSHIP_DENIED", "User is not a member of the requested tenant/workspace.");
  }

  const actor: ActorContext = {
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    userId: user.user_id,
    role: membership.role,
  };
  const token = signSessionToken({
    ...actor,
    email: user.email,
    tv: user.token_version,
  });
  return { token, actor };
}

export async function revokeUserSessions(db: PgDatabaseAdapter, userId: string): Promise<number> {
  const res = await db.query<{ token_version: number }>(
    "UPDATE users SET token_version = token_version + 1 WHERE user_id = $1::uuid RETURNING token_version",
    [userId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new AuthenticationError(404, "USER_NOT_FOUND", "User not found.");
  }
  return row.token_version;
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
