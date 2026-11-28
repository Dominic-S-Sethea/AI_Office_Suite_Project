import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import type { ActorContext, WorkspaceRole } from "@ai-office-suite/shared-contracts";
import { isWorkspaceRole } from "@ai-office-suite/authorization";
import { withTenantTransaction, type PgDatabaseAdapter } from "@ai-office-suite/database";

export const SESSION_COOKIE_NAME = "aios_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 43_200; // 12 hours
export const JWT_ISSUER = "ai-office-suite-api";
export const JWT_AUDIENCE = "ai-office-suite-workspace";

// Per-process CSPRNG fallback for test/dev only — never hardcoded, never used in production (H4)
const EPHEMERAL_DEV_JWT_SECRET = randomBytes(32).toString("hex");

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
    return EPHEMERAL_DEV_JWT_SECRET;
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

export interface SessionTokenClaims {
  userId: string;
  email: string;
  tenantId: string;
  workspaceId: string;
  role: WorkspaceRole;
  tv: number;
  mfaVerifiedAt?: string;
  jti?: string;
}

export function signSessionToken(
  claims: SessionTokenClaims,
  options: { expiresIn?: SignOptions["expiresIn"] } = {},
): string {
  return jwt.sign(
    {
      sub: claims.userId,
      email: claims.email,
      tenant_id: claims.tenantId,
      workspace_id: claims.workspaceId,
      role: claims.role,
      tv: claims.tv,
      ...(claims.mfaVerifiedAt ? { mfa_verified_at: claims.mfaVerifiedAt } : {}),
    },
    getJwtSecret(),
    {
      algorithm: "HS256",
      expiresIn: options.expiresIn ?? "12h",
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: claims.jti ?? randomUUID(),
    },
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifySessionToken(token: string): SessionTokenClaims | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
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
      !Number.isInteger(p.tv) ||
      typeof p.jti !== "string" ||
      p.jti.length < 8
    ) {
      return null;
    }
    let mfaVerifiedAt: string | undefined;
    if (typeof p.mfa_verified_at === "string" && p.mfa_verified_at.trim().length > 0) {
      if (!Number.isFinite(Date.parse(p.mfa_verified_at))) {
        return null;
      }
      mfaVerifiedAt = p.mfa_verified_at;
    }
    return {
      userId: p.sub,
      email: p.email,
      tenantId: p.tenant_id,
      workspaceId: p.workspace_id,
      role: p.role,
      tv: p.tv,
      ...(mfaVerifiedAt ? { mfaVerifiedAt } : {}),
      jti: p.jti,
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
  mfaVerifiedAt?: string;
  tokenExpiresIn?: SignOptions["expiresIn"];
}): Promise<{ token: string; actor: ActorContext }> {
  const userRes = await params.db.query<{
    user_id: string;
    email: string;
    password_hash: string;
    token_version: number;
    status: string;
  }>(
    "SELECT user_id, email, password_hash, token_version, status FROM auth_lookup_user_for_login($1)",
    [params.email.trim()],
  );
  const user = userRes.rows[0];
  const passwordOk = await verifyPassword(params.password, user ? user.password_hash : DUMMY_BCRYPT_HASH);
  if (
    !user ||
    !passwordOk ||
    user.status !== "active" ||
    !UUID_PATTERN.test(params.tenantId) ||
    !UUID_PATTERN.test(params.workspaceId)
  ) {
    // Uniform 401 prevents account status & credential enumeration (H4)
    throw new AuthenticationError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const membership = await withTenantTransaction(
    params.db,
    params.tenantId,
    async (tx) => {
      const memRes = await tx.query<{ role: string; content_access: boolean }>(
        `SELECT m.role, m.content_access
         FROM memberships m
         JOIN organizations o ON o.tenant_id = m.tenant_id
         WHERE m.tenant_id = $1::uuid
           AND m.workspace_id = $2::uuid
           AND m.user_id = $3::uuid
           AND m.status = 'active'
           AND o.status = 'active'`,
        [params.tenantId, params.workspaceId, user.user_id],
      );
      return memRes.rows[0] ?? null;
    },
    params.workspaceId,
  );
  if (!membership || !isWorkspaceRole(membership.role)) {
    // Uniform 401 prevents workspace/tenant membership enumeration (H4)
    throw new AuthenticationError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const actor: ActorContext = {
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    userId: user.user_id,
    role: membership.role,
    workspaceContentGrant: Boolean(membership.content_access),
    ...(params.mfaVerifiedAt ? { mfaVerifiedAt: params.mfaVerifiedAt } : {}),
  };
  const token = signSessionToken(
    {
      ...actor,
      email: user.email,
      tv: user.token_version,
      ...(params.mfaVerifiedAt ? { mfaVerifiedAt: params.mfaVerifiedAt } : {}),
    },
    params.tokenExpiresIn ? { expiresIn: params.tokenExpiresIn } : undefined,
  );
  return { token, actor };
}

export async function revokeUserSessions(db: PgDatabaseAdapter, userId: string): Promise<number> {
  if (!UUID_PATTERN.test(userId)) {
    throw new AuthenticationError(404, "USER_NOT_FOUND", "User not found.");
  }
  const res = await db.query<{ token_version: number | null }>(
    "SELECT auth_bump_user_token_version($1::uuid) AS token_version",
    [userId],
  );
  const nextTv = res.rows[0]?.token_version;
  if (nextTv == null) {
    throw new AuthenticationError(404, "USER_NOT_FOUND", "User not found.");
  }
  return nextTv;
}

