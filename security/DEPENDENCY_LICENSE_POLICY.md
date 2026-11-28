# Dependency & License Policy — AI Office Suite

**Governance Scope:** All `21` monorepo workspaces (`packages/*`, `platform/*`, `engines/*`, `modules/*`, `apps/*`)  
**Status:** Active

## 1. Purpose

AI Office Suite is planned as a **commercial SaaS and future enterprise/self-hosted platform**. Introducing strong copyleft (`AGPL`, `GPL`-only) or unlicensed/proprietary dependencies into core runtime bundles creates legal redistribution risk.

## 2. Allowed Licenses

- Permissive code licenses: `MIT`, `MIT/X11`, `ISC`, `BSD`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `Zlib`, `0BSD`, `Unlicense`, `BlueOak-1.0.0`, `CC0-1.0`, `CC-BY-4.0`, `Python-2.0`.
- Open typography licenses: `SIL Open Font License 1.1` (`OFL-1.1`) for bundled Khmer and Latin fonts (`Noto Sans Khmer`, `Kantumruy Pro`, `Inter`).
- Dual-licensed expressions (`AND` / `OR` / `WITH` clauses) evaluated by the recursive-descent SPDX parser in `scripts/check-licenses.mjs` when solvable exclusively via permissive branches.

## 3. Prohibited Without Explicit Founder & Legal Sign-Off

- `AGPL-3.0` / `AGPL-*` (triggers network copyleft across SaaS integrations).
- `GPL`-only / `SSPL` / `BSL-1.1` / `BUSL` / `UNLICENSED` runtime dependencies.
- Commercial paid SDKs requiring per-seat or OEM redistribution contracts (e.g., Tiptap Pro extensions, ONLYOFFICE Developer Edition) until evaluated and approved at a founder decision gate.

## 4. Automated Enforcement & Supply-Chain Verification

- Run `npm run lint:licenses` (executed via `scripts/check-licenses.mjs` across all 21 workspaces and root `node_modules`) on every dependency change and in CI.
- Run `npm run sbom` (`scripts/generate-sbom.mjs`) to generate the CycloneDX 1.5 JSON SBOM (`coverage/sbom.cdx.json`) with automatic runtime scope promotion (`"required"`) for packages appearing in both dev and production graphs.
- Run `npm audit --omit=dev --audit-level=high` in CI to catch high/critical runtime vulnerabilities.
