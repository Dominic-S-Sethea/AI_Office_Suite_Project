# Dependency & License Policy — AI Office Suite

**Phase:** D0.03 Engineering Governance  
**Status:** Active for Phase D0–D1

## 1. Purpose

AI Office Suite is planned as a **commercial SaaS and future enterprise/self-hosted platform**. Introducing strong copyleft (AGPL, GPL-only) or unlicensed/proprietary dependencies into core runtime bundles creates legal redistribution risk.

## 2. Allowed Licenses (Phase D0–D1)

- Permissive code licenses: `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `0BSD`, `BlueOak-1.0.0`, `CC0-1.0`.
- Open typography licenses: `SIL Open Font License 1.1` (`OFL-1.1`) for bundled Khmer and Latin fonts (`Noto Sans Khmer`, `Kantumruy Pro`, `Inter`).

## 3. Prohibited Without Explicit Founder & Legal Sign-Off

- `AGPL-3.0` / `AGPL-*` (e.g., ONLYOFFICE Docs Community Edition — triggers network copyleft across SaaS integrations).
- `GPL-only` runtime dependencies.
- Commercial paid SDKs requiring per-seat or OEM redistribution contracts (e.g., Tiptap Pro extensions, ONLYOFFICE Developer Edition) until evaluated and approved at a Phase D1/D2 founder decision gate.

## 4. Automated Enforcement

Run `npm.cmd run lint:licenses` (executed via `scripts/check-licenses.mjs`) on every dependency change and in CI.
