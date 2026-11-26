# Stage 4 Technical Feasibility Plan (`TF-01`..`TF-12`) & Stage 3 Exit Review

- **Source Mandate:** Main Research & Engineering Report V1.4 (Part C + Stage 3 Exit Review)
- **Progressive Delivery Strategy (`CR-008` / `APPROVAL-01`):** **`S1` (Document-first vertical slice) -> `S2` (Governed numerical intelligence) -> `S3` (Complete integrated reporting workflow)** while preserving all **51 original parent requirements (`46 P0`, `5 P1`)**.
- **Governance Boundary:** Zero unapproved spending, zero external data/audio transfer, zero unapproved third-party dependencies, and zero production rollout (`PA-01+`, `AIC-01+`, `VI-01+`, `D3+` remain halted).

---

## 1. Stage 4 Technical Feasibility Investigation Register (`TF-01`..`TF-12`)

| ID | Investigation | Cost / External Requirement | Status | Evidence & Notes |
| :--- | :--- | :--- | :--- | :--- |
| **TF-01** | Baseline Consolidation, 51-Parent RTM, 313-Test Realignment & `RC-T01..08` / `RC-P1-01..05` | Zero cost, local | **VERIFIED_LOCAL** | Completed under `APPROVAL-02`: verbatim V1.4 archived, `REQUIREMENTS_TRACEABILITY_MATRIX.md` verified by live `RC-T07` parser (`51` parents, `46 P0`/`5 P1`, `313` tests), all 4 V1.3 test suites realigned 1:1 to V1.4 Appendix A, `RC-T01..08` + `RC-P1-01..05` passing. |
| **TF-02** | Live Bilingual EN/KM LLM Structured-Output & Hallucination Benchmark | Paid API keys + ZDR terms | **BLOCKED (Pending `APPROVAL-04`)** | External providers (`openai`, `anthropic`, `google-gemini`) remain fail-closed (`423`). Model upgrade regression gate (`evaluateModelUpgradeRegression`, `AI-T24`) ready locally. |
| **TF-03** | Consented Native Khmer (`km-KH`) & English Live Speech WER/CER Benchmark | Consented human audio corpus + GPU/STT | **BLOCKED (Pending `APPROVAL-05`)** | Cloud STT (`423`) and P1 `VOC-03` features (`423`) fail closed. Local `FasterWhisperLocalAdapter` & `VoiceGovernancePipeline` (`VOC-T01..T30`) verified with synthetic/mock contracts only. |
| **TF-04** | Bounded 1,000,000-Row Analytical Spill-to-Disk & Descriptive Statistics Benchmark | Zero cost, local | **VERIFIED_LOCAL** | Completed under `APPROVAL-03`: DuckDB `@duckdb/node-api` processed **1,000,000 bilingual USD/KHR rows** in **580.8 ms** (`+125 MB` RSS, `memory_limit='256MB'`, `temp_directory`, `enable_external_access=false`) with exact BigInt parity (`$25,000,000.00` / `៛102,000,000,000`) + `computeDescriptiveStatistics` (`RC-T02`). |
| **TF-05** | Production Spreadsheet Engine Commercial Evaluation (`Univer` vs `Handsontable+HyperFormula`) | Vendor licensing quotes + desktop Excel | **PENDING (Vendor RFP / `APPROVAL-06`)** | Vendor outreach briefs prepared (`VENDOR_OUTREACH_BRIEFS.md`); 19-function prototype remains feasibility-only. |
| **TF-06** | Desktop Reference App Interoperability (Word / Excel / PowerPoint + Khmer Shaping) | Licensed desktop Office / Windows/macOS QA | **BLOCKED_EXTERNAL** | Automated OOXML/PDF pipelines verified locally (`DOC-T05/06`, `SHT-T13`, `PPT-T05/09/10`); desktop reference opens (`PPT-T06`, `NFR-T33/34/35`) await desktop QA environment. |
| **TF-07** | Production Identity, SSO/OIDC & MFA Step-Up Provider Evaluation | Identity provider sandbox | **PENDING (Gated until `PA-01`)** | Local HS256 JWT + `token_version` + MFA step-up policy verified (`PLT-T13`, `PLT-T14`). |
| **TF-08** | Object Storage S3/R2 Integration, AV Scanning & KMS Envelope Encryption | Cloud bucket + ClamAV/KMS sandbox | **PENDING (Gated until `PA-01`)** | `LocalPrivateObjectStore` contract (tenant keys, signed URLs, quarantine, orphan sweep, restore parity) verified locally (`PLT-T18..26`, `PLT-T35`). |
| **TF-09** | Multi-User Staging Load, Cloud HA Failover & Telemetry/Alerting Drill | Cloud staging environment | **BLOCKED_EXTERNAL** | Local soak benchmarks (`bench:check`), lease fencing (`PLT-T27`), and health snapshots (`PLT-T36`) verified; cloud multi-AZ HA/load (`NFR-T01/02/14/17/19`) pending staging. |
| **TF-10** | Billing Gateway (Stripe / KHQR) & Tax Compliance Integration | Sandbox merchant credentials | **PENDING (Gated until `PA-01`)** | Mock signed webhook reconciliation & atomic quota reservations verified (`PLT-T30..T33`); zero real charges enabled. |
| **TF-11** | Supply-Chain Hardening: CycloneDX 1.5 SBOM, Reproducible Build & Frontend Coverage/A11y | Zero cost, local | **VERIFIED_LOCAL** | Completed under `APPROVAL-03`: zero-dependency `scripts/generate-sbom.mjs` (`npm run sbom`, `620` components / `358` runtime required), `lint:licenses`, `npm audit --omit=dev --audit-level=high` (0 high/critical), and boosted `apiClient.ts` + `AiVoicePanel.tsx` test/a11y coverage. |
| **TF-12** | Independent Security Threat Model & External Penetration Test Readiness | External security reviewer | **BLOCKED_EXTERNAL** | Internal 64-finding audit remediated + backup-restore revoked-member security bug caught & fixed in `PLT-T35`/`GOV-T08`; external pentest (`NFR-T29`) pending pre-MVP. |

---

## 2. Founder Approval Checklist (`APPROVAL-01`..`APPROVAL-07`)

| Gate ID | Decision Scope | Status |
| :--- | :--- | :--- |
| **APPROVAL-01** | Adopt progressive delivery order **`S1 -> S2 -> S3`** while preserving all `51` original parent requirements (`46 P0`, `5 P1`) and recording `CR-008` | **APPROVED** (2026-11-26) |
| **APPROVAL-02** | Complete `TF-01` locally: archive verbatim V1.4 report, commit canonical consolidation docs, realign V1.3 suites 1:1 to V1.4 Appendix A, implement `RC-T01..08`, `RC-P1-01..05`, and missing `DOC-T`/`SHT-T` local edges | **APPROVED & VERIFIED_LOCAL** (2026-11-26) |
| **APPROVAL-03** | Execute zero-cost local `TF-04` (1M-row DuckDB spill + exact descriptive stats) and `TF-11` (CycloneDX 1.5 SBOM + frontend coverage/a11y boost) | **APPROVED & VERIFIED_LOCAL** (2026-11-26) |
| **APPROVAL-04** | Authorize external LLM ZDR API keys & bounded `TF-02` bilingual LLM benchmark spend | **PENDING FOUNDER REVIEW** |
| **APPROVAL-05** | Authorize consented native Khmer (`km-KH`) & English speech corpus collection & `TF-03` live ASR evaluation | **PENDING FOUNDER REVIEW** |
| **APPROVAL-06** | Approve commercial spreadsheet engine vendor decision (`TF-05`) & desktop Office QA resources (`TF-06`) | **PENDING FOUNDER REVIEW** |
| **APPROVAL-07** | Authorize remote `git push` / PR publication and entry into Production Milestone **`S1`** (`PA-01` / `D3` / `AIC-01` / `VI-01`) | **PENDING FOUNDER REVIEW** |
