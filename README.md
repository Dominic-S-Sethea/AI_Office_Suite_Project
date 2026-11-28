# AI Office Suite

Bilingual (English / ខ្មែរ) modular document, spreadsheet, presentation, analytics, and governed AI productivity platform built as a strict TypeScript/ESM monorepo.

## Prerequisites

- **Node.js:** `>=22.18.0` (native TypeScript execution & `node --test`/Vitest support)
- **PostgreSQL:** `16+` (for `jwt-pg` multi-tenant Row-Level Security mode)
- **Optional:** Docker Engine `24+` + Docker Compose v2+ for containerized full-stack runs, Chromium/Edge for HarfBuzz PDF rendering

## Workspace Architecture (`20` Workspaces)

- **Packages:** `packages/shared-contracts`, `packages/validation`
- **Platform:** `platform/audit`, `platform/authorization`, `platform/database`, `platform/identity`, `platform/storage`
- **Engines:** `engines/analytics`, `engines/calculation`, `engines/data-processing`, `engines/document`, `engines/file-conversion`, `engines/intelligence`, `engines/presentation`, `engines/speech`
- **Modules & Apps:** `modules/ai`, `modules/documents`, `apps/api`, `apps/web`

## Quick-Start

### Local Development (`provisional-local` loopback mode)

```bash
npm ci
npm run dev
```

Starts the API server on `http://127.0.0.1:4100` (`provisional-local` loopback only) and the Vite web workspace on `http://127.0.0.1:5174`.

### Production / `jwt-pg` Docker Compose Mode

See [`documentation/DEVOPS_RUNBOOK.md`](documentation/DEVOPS_RUNBOOK.md) for required environment variables (`POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `JWT_SECRET`, `AI_PROPOSAL_SIGNING_SECRET`, `PII_PSEUDONYMIZATION_KEY`) and database operations (`npm run db:migrate`, `npm run db:verify-rls`, `npm run db:backup`, `npm run db:restore`).

## Core Scripts

| Script | Purpose |
| :--- | :--- |
| `npm run typecheck` | Workspace-wide TypeScript check (`tsconfig.typecheck.json`) |
| `npm run build` | Build API + Vite Web bundle |
| `npm test` | Run full Vitest test suite |
| `npm run bench:check` | Verify performance regression budgets |
| `npm run lint:hygiene` | Check tracked files, secret patterns & speech gate invariants |
| `npm run lint:licenses` | Enforce SPDX permissive license compliance across workspaces |
| `npm run sbom` | Generate CycloneDX 1.5 JSON SBOM (`coverage/sbom.cdx.json`) |

## Documentation & Governance

- [DevOps & Operations Runbook](documentation/DEVOPS_RUNBOOK.md)
- [Security & Compliance Audit Report](documentation/SECURITY_AUDIT_REPORT.md)
- [Dependency & License Policy](security/DEPENDENCY_LICENSE_POLICY.md)
- [Product Specification](PRODUCT.md) · [Design System](DESIGN.md)
