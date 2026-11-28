# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary Users:** Finance, management, administration, and business analyst teams operating in corporate and bilingual English / ខ្មែរ environments.
- **Governance Roles:** Workspace Owners, Administrators, Workspace Managers, Billing Admins, Auditors, Editors, Reviewers (read-only plus DOCX/PDF export and audit inspection), and Viewers (read-only document and version inspection).

## Product Purpose

AI Office Suite provides an integrated, governance-ready productivity workspace where organizations can author, format, import, review, and export bilingual English and Khmer corporate documents cleanly today while sharing a unified deterministic analytical, data-preparation, and permission backbone for future spreadsheet, presentation, and business intelligence studios.

## Positioning

Unlike standalone generic office editors or unverified generative AI tools, AI Office Suite binds rich bilingual English/Khmer authoring directly to deterministic calculations, immutable revision histories, preview-before-apply AI/voice diffs, and backend-enforced 8-role RBAC with PostgreSQL Row-Level Security—without forcing business users to write Excel formulas, SQL, or DAX.

## Operating Context

- **Runtime Environments:** Browser web client (`apps/web`) backed by the Express API gateway (`apps/api`) in either authenticated PostgreSQL RLS mode (`jwt-pg`, `aios_session` HttpOnly cookie) or loopback local prototype mode (`provisional-local`).
- **Viewports & Formats:** Responsive workspace across desktop (`1440px+`), compact workstation (`1024px`), and mobile (`390px`) screens, supporting `A4` and `Letter` documents in portrait and landscape orientations.

## Capabilities and Constraints

- **Document Studio (Live):** Rich-text authoring via Tiptap/ProseMirror with `blockId` preservation, atomic read-only linked metric pills, bilingual fixture seeding, `.docx` import (`.docm` macro uploads blocked; SHA-256 diagnostics recorded), `.docx` export, paginated HarfBuzz `.pdf` export, optimistic `409` revision conflict recovery, immutable block-level diffs, and two-step inline revision restore.
- **Upcoming Studios (UI Gated / Engine Verified):** Spreadsheets (`SS-00`), Presentations (`PS-00`), and Intelligence BI (`BI-00`) engines plus cross-module links (`XI-00`) are verified in automated test suites; interactive UI builders remain gated for Milestones `S2` and `S3` (spreadsheet production grid selection `Univer` vs `Handsontable + HyperFormula` remains undecided pending `TF-03` / `APPROVAL-04`).
- **AI & Voice Safety Gates:** Contextual, command, and dictation modes generate structured operation proposals tied to `expectedRevision` and require explicit human approval before applying. Voice controls use deterministic `MockSpeechAdapter` (`isMock: true`); external cloud LLM/STT adapters fail closed (`HTTP 423`) unless authorized.
- **Permission Boundaries:** `reviewer` cannot edit, create, or restore; `viewer` cannot edit, export (`export:export`), or inspect workspace audit trails (`audit:read`), while still retaining `document:read` access to immutable versions and revision diffs.

## Brand Commitments

- **Naming:** Product title **"AI Office Suite"** and top-level studios **"Document Studio"**, **"Spreadsheets"**, **"Presentations"**, and **"Intelligence BI"**.
- **Voice & Honesty Commitments:** Formal, bilingual English / ខ្មែរ corporate tone; preserve explicit status disclosures (`Planned`, `SIMULATED (isMock: true)`, `Live API`, `Live Controls`, `Reference Benchmark`, and `Scroll View (Paginated on PDF Export)`).
- **Non-Fabrication Rule:** Do not invent customer logos, testimonials, SLA guarantees, commercial pricing tiers, or live acoustic WER metrics.

## Evidence on Hand

- Live web studio client and modular workspace components (`apps/web/src/`).
- Bilingual English/Khmer corporate management report fixture (`tests/fixtures/bilingual-management-report.ts`).
- Backend API gateway and domain/platform engines (`apps/api/src/`, `engines/`, `modules/`, `platform/`, `packages/`).
- Verification and security regression suites (`tests/`).
- **Recorded Absences:** External customer case studies, commercial pricing/billing tiers, and real-microphone Khmer/English acoustic WER field telemetry are absent and must never be fabricated.

## Product Principles

1. **Explainable Determinism:** Mutations, financial figures, and AI suggestions remain inspectable, non-destructive, and bound to revision locks before altering approved content.
2. **Honest Surface Boundaries:** Simulated voice adapters (`isMock: true`), future studios (`Planned`), and static benchmark sub-panels (`Reference Benchmark`) are unmistakably distinguished from live production mutations.
3. **Bilingual Parity First:** English and ខ្មែរ scripts share first-class fidelity across editing, grapheme-boundary range snapping, revision diffs, and document exports.
4. **Clarity Over Silent Denial:** Role restrictions (`reviewer`, `viewer`, `audit:read`) surface actionable explanations directly in context rather than disabling controls without reason.

## Accessibility & Inclusion

- **Baseline Standard:** WCAG 2.2 AA contrast (`>= 4.5:1` for normal copy, `>= 3:1` for large text and UI boundaries) and full keyboard operability (`Tab` focus trapping and `Escape` dismissal on modals/drawers, arrow-key navigation across tabs and rail menus, and safe focus restoration).
- **Touch & Pointer Targets:** Minimum `32px` desktop controls (exceeding WCAG 2.2 SC 2.5.8 `24x24px`) and `>= 44x44px` interactive targets on mobile (`<= 640px`) and `pointer: coarse` input devices.
- **Khmer Script & Motion Inclusion:** Generous vertical clearance (`0` artificial letter-spacing, unclipped Khmer coeng subscripts and vowel signs), per-document language tagging without mislabeling mixed bilingual copy, and complete `prefers-reduced-motion` compliance across transitions, animations, and scroll behavior.
