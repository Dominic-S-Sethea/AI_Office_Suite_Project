# Commercial Licensing & Vendor Outreach Briefs — AI Office Suite

**Status:** Approved for Vendor Outreach Prep (Approval #3) — **No commercial license purchase or binding contract is authorized without explicit founder review of vendor responses.**  
**Prepared For:** Founder Procurement & CTO Architecture Review  
**Scope:** Multi-tenant SME Cloud SaaS (`10–250` seats/org) with optional future self-hosted deployment (`WS-15`).

---

## 1. Tiptap Pages (`@tiptap-pro/extension-pages`) — Document Studio Pagination (`TD-DOC-01`)

- **Context:** AI Office Suite currently runs `@tiptap/core@3.35.0` (MIT) paired with `docx` (MIT) and Chromium/HarfBuzz PDF rendering. Before D3 builds interactive multi-page editing UX, we need pricing and redistribution terms for **Tiptap Pages**.
- **Outreach Questions to Vendor:**
  1. Does a single Tiptap commercial license cover SaaS multi-tenant redistribution across an unlimited number of SME customer organizations and seats, or is pricing metered per end-user / MAU / workspace?
  2. What offline / self-hosted license validation guarantees apply for air-gapped or private-VPC SME deployments (`WS-15`)?
  3. Does `@tiptap-pro/extension-pages` preserve complex **Khmer Unicode (`km-KH`) coeng subscripts and zero-width word wrapping (`Intl.Segmenter` / ICU)** across automatic page breaks without splitting stacked clusters?
  4. Are source maps and deterministic Node/Playwright print-parity hooks included?
- **Acceptance Criteria Before Purchase:** Validated 10-page bilingual Khmer/English contract sample without coeng clipping + predictable unit-economics per SME tenant.

---

## 2. Univer Pro — Spreadsheet Studio Engine Candidate #1 (`TD-SHT-01`)

- **Context:** Univer core packages are `Apache-2.0`, while Univer Pro covers full fidelity XLSX import/export, collaborative formulas, print/PDF, and pivot/chart capabilities.
- **Outreach Questions to Vendor:**
  1. Exact feature boundary between `Apache-2.0` Univer core and commercial **Univer Pro** (specifically: formula engine, Excel XLSX import/export fidelity, conditional formatting, data validation, and PivotTables).
  2. Commercial OEM / SaaS redistribution license structure (flat platform fee vs. per-tenant / per-seat tier) for SME customers (10–250 staff/org).
  3. Server-side Node headless recalculation package availability & memory footprint for `200,000+`-cell workbooks (`SHT-01.02`).
  4. Native Khmer (`Noto Sans Khmer`, `Kantumruy Pro`) rendering inside canvas/DOM grid cells and Excel `1900`/`1904` date systems.
- **Acceptance Criteria Before Purchase:** Transparent written OEM quote + 200k-cell headless benchmark + Khmer rendering sign-off.

---

## 3. Handsontable + HyperFormula Commercial — Spreadsheet Engine Candidate #2 (`TD-SHT-01`)

- **Context:** Open-source HyperFormula is `GPL-3.0-only` (prohibited in closed commercial SaaS without commercial dual-license). Therefore BOTH Handsontable and HyperFormula must be quoted under commercial OEM terms.
- **Outreach Questions to Vendor:**
  1. Bundled annual OEM/SaaS pricing for **Handsontable + HyperFormula Commercial** covering multi-tenant cloud SaaS + future self-hosted option (`WS-15`).
  2. Does HyperFormula commercial support deterministic headless Node.js worker execution decoupled from browser UI state, plus Excel-compatible `ROUND`, `SUMIFS`, `XLOOKUP`/`VLOOKUP`, and `1900`/`1904` date serials?
  3. Explicit redistribution rights covering our backend calculation workers (`SHT-03`) and frontend grid.
- **Acceptance Criteria Before Purchase:** Written commercial redistribution clarity eliminating all `GPL-3.0-only` obligations + 200k-cell memory/latency test.

---

## 4. ONLYOFFICE Docs Developer Edition — Optional Document & Spreadsheet Benchmark (`R-01`)

- **Context:** **ONLYOFFICE Community Edition is permanently excluded (`AGPL v3`)**. Only the proprietary **Developer Edition** is eligible for benchmarking if needed.
- **Outreach Questions to Vendor:**
  1. Concurrent connection pricing and hardware/RAM footprint for SME SaaS hosting of ONLYOFFICE Document Server Developer Edition.
  2. API/Plugin hooks for enforcing AI Office Suite's **approval-gated AI proposals**, RBAC permissions, and linked governed datasets (`LinkedMetricReference`) without exposing raw document server bypasses.
  3. HarfBuzz/ICU Khmer rendering parity in collaborative Document & Spreadsheet canvases.

---

## 5. Non-Negotiable Procurement Guardrails

1. Every commercial license agreement must explicitly waive copyleft (`AGPL` / `GPL-3.0`) propagation across our proprietary codebase.
2. No per-developer-seat ambush clauses or undocumented production-volume overage penalties.
3. Founder & legal counsel must review the actual vendor SLA and DPA before any procurement payment.
