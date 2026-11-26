import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  exportLogicalBackupSnapshot,
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  provisionAppRuntimeLoginRole,
  restoreLogicalBackupSnapshot,
  verifyDatabaseRlsReadiness,
} from "../platform/database/src/index.ts";
import { initializeIntegrationSchema } from "../engines/integration/src/index.ts";
import { hashPassword } from "../platform/identity/src/index.ts";

const ALL_TENANT_RLS_TABLES = [
  "workspaces",
  "documents",
  "document_versions",
  "idempotency_keys",
  "audit_logs",
  "ai_applied_operations",
  "xi_artifacts",
  "xi_artifact_revisions",
  "xi_dependency_edges",
  "xi_workflow_runs",
  "xi_reporting_packages",
  "xi_package_approvals",
  "xi_outbox_events",
];

const NO_UPDATE_OR_DELETE_TABLES = [
  "audit_logs",
  "document_versions",
  "ai_applied_operations",
  "xi_artifact_revisions",
];

const NO_DELETE_TABLES = ["xi_outbox_events", "xi_package_approvals"];

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("ERROR: DATABASE_URL environment variable is required.");
    process.exit(1);
  }
  return url;
}

async function cmdMigrate(db) {
  await initializePostgreSqlSchema(db);
  await initializeIntegrationSchema(db);
  let provisionedRole = null;
  const appRole = process.env.POSTGRES_APP_USER?.trim();
  const appPw = process.env.POSTGRES_APP_PASSWORD?.trim();
  if (appRole && appPw) {
    await provisionAppRuntimeLoginRole(db, { roleName: appRole, password: appPw });
    provisionedRole = appRole;
  }
  console.log(
    JSON.stringify({
      ok: true,
      command: "migrate",
      schemas: ["core-d2", "integration-xi00"],
      ...(provisionedRole ? { provisionedAppRole: provisionedRole } : {}),
      timestamp: new Date().toISOString(),
    }),
  );
}

async function cmdProvisionAppRole(db) {
  const roleName = process.env.POSTGRES_APP_USER?.trim() || "aios_app";
  const password = process.env.POSTGRES_APP_PASSWORD?.trim();
  if (!password) {
    console.error("ERROR: POSTGRES_APP_PASSWORD (>= 12 chars) is required for provision-app-role.");
    process.exit(1);
  }
  await provisionAppRuntimeLoginRole(db, { roleName, password });
  console.log(
    JSON.stringify({
      ok: true,
      command: "provision-app-role",
      roleName,
      timestamp: new Date().toISOString(),
    }),
  );
}

async function cmdVerifyRls(db) {
  const readiness = await verifyDatabaseRlsReadiness(db);
  const failures = [];

  if (!readiness.checks.connectivity) failures.push("Database connectivity check failed.");
  if (!readiness.checks.appRuntimeLeastPrivilege) {
    failures.push("Role 'app_runtime' missing or has superuser/bypassrls privilege.");
  }

  const rlsRes = await db.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [ALL_TENANT_RLS_TABLES],
  );
  const rlsByTable = new Map(rlsRes.rows.map((r) => [r.relname, r]));
  for (const tbl of ALL_TENANT_RLS_TABLES) {
    const row = rlsByTable.get(tbl);
    if (!row || !row.relrowsecurity || !row.relforcerowsecurity) {
      failures.push(`Table '${tbl}' is missing ENABLE + FORCE ROW LEVEL SECURITY.`);
    }
  }

  const grantRes = await db.query(
    `SELECT table_name, privilege_type
     FROM information_schema.role_table_grants
     WHERE grantee = 'app_runtime' AND table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [[...NO_UPDATE_OR_DELETE_TABLES, ...NO_DELETE_TABLES]],
  );
  for (const g of grantRes.rows) {
    if (
      NO_UPDATE_OR_DELETE_TABLES.includes(g.table_name) &&
      (g.privilege_type === "UPDATE" || g.privilege_type === "DELETE")
    ) {
      failures.push(`Forbidden '${g.privilege_type}' grant on immutable table '${g.table_name}' for app_runtime.`);
    }
    if (NO_DELETE_TABLES.includes(g.table_name) && g.privilege_type === "DELETE") {
      failures.push(`Forbidden 'DELETE' grant on append-only table '${g.table_name}' for app_runtime.`);
    }
  }

  const summary = {
    ok: failures.length === 0,
    command: "verify-rls",
    verifiedTables: ALL_TENANT_RLS_TABLES.length,
    failures,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exit(1);
}

async function cmdBackup(db, outPath) {
  if (!outPath) {
    console.error("Usage: node scripts/db-cli.mjs backup <output.json>");
    process.exit(1);
  }
  const snapshot = await exportLogicalBackupSnapshot(db);
  const serialized = JSON.stringify(snapshot, null, 2);
  const resolved = path.resolve(outPath);
  writeFileSync(resolved, serialized, "utf8");
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  console.log(
    JSON.stringify({
      ok: true,
      command: "backup",
      outputPath: resolved,
      sha256,
      counts: {
        organizations: snapshot.organizations.length,
        users: snapshot.users.length,
        workspaces: snapshot.workspaces.length,
        documents: snapshot.documents.length,
        documentVersions: snapshot.documentVersions.length,
        auditLogs: snapshot.auditLogs.length,
      },
    }),
  );
}

async function cmdRestore(db, inPath) {
  if (!inPath) {
    console.error("Usage: node scripts/db-cli.mjs restore <input.json>");
    process.exit(1);
  }
  const resolved = path.resolve(inPath);
  const raw = readFileSync(resolved, "utf8");
  const snapshot = JSON.parse(raw);
  await restoreLogicalBackupSnapshot(db, snapshot);
  console.log(
    JSON.stringify({
      ok: true,
      command: "restore",
      inputPath: resolved,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    }),
  );
}

async function cmdSeedDev(db) {
  if (process.env.NODE_ENV === "production") {
    console.error("REFUSED: seed-dev cannot execute when NODE_ENV=production.");
    process.exit(1);
  }
  const devPassword = process.env.DEV_SEED_PASSWORD?.trim();
  if (!devPassword || devPassword.length < 12) {
    console.error("REFUSED: DEV_SEED_PASSWORD (>= 12 chars) must be explicitly provided for seed-dev.");
    process.exit(1);
  }
  const pwHash = await hashPassword(devPassword);

  const tenantId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ownerId = "22222222-2222-4222-8222-222222222222";
  const editorId = "33333333-3333-4333-8333-333333333333";
  const viewerId = "44444444-4444-4444-8444-444444444444";

  await db.query(
    "INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'AI Office Dev SME', 'active') ON CONFLICT DO NOTHING",
    [tenantId],
  );
  await db.query(
    "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'Corporate HQ') ON CONFLICT DO NOTHING",
    [tenantId, workspaceId],
  );
  await db.query(
    `INSERT INTO users (user_id, email, password_hash, status) VALUES
       ($1::uuid, 'owner@dev.local', $4, 'active'),
       ($2::uuid, 'editor@dev.local', $4, 'active'),
       ($3::uuid, 'viewer@dev.local', $4, 'active')
     ON CONFLICT DO NOTHING`,
    [ownerId, editorId, viewerId, pwHash],
  );
  await db.query(
    `INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'owner'),
       ($1::uuid, $2::uuid, $4::uuid, 'editor'),
       ($1::uuid, $2::uuid, $5::uuid, 'viewer')
     ON CONFLICT DO NOTHING`,
    [tenantId, workspaceId, ownerId, editorId, viewerId],
  );

  console.log(
    JSON.stringify({
      ok: true,
      command: "seed-dev",
      tenantId,
      workspaceId,
      accounts: ["owner@dev.local", "editor@dev.local", "viewer@dev.local"],
    }),
  );
}

const [command, arg1] = process.argv.slice(2);
if (
  !command ||
  !["migrate", "verify-rls", "provision-app-role", "backup", "restore", "seed-dev"].includes(command)
) {
  console.error("Usage: node scripts/db-cli.mjs <migrate|verify-rls|provision-app-role|backup|restore|seed-dev> [file]");
  process.exit(1);
}

const db = new NodePgDatabaseAdapter(requireDatabaseUrl());
try {
  if (command === "migrate") await cmdMigrate(db);
  else if (command === "verify-rls") await cmdVerifyRls(db);
  else if (command === "provision-app-role") await cmdProvisionAppRole(db);
  else if (command === "backup") await cmdBackup(db, arg1);
  else if (command === "restore") await cmdRestore(db, arg1);
  else if (command === "seed-dev") await cmdSeedDev(db);
} finally {
  await db.close();
}
