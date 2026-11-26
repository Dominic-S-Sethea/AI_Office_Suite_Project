# AI Office Suite (AI Corporate Workspace)
## Main Research and Engineering Report V1.4
### FR-12 Non-functional Requirements + FR-13 Complete Requirements Consolidation

**Date:** 26 November 2026.  
**Status:** proposed Stage 3 consolidated requirements baseline, ready for founder review and Stage 4 feasibility planning; not an approved production specification, implementation audit, or release authorization.

## 0. Engineering mandate and how to use this report

Read this entire report before modifying the project. It consolidates the previous FR-12 research with the final FR-13 requirements synthesis. It is a successor engineering handover to V1.1 (FR-03/04 and D0/D1 decisions), V1.2 (FR-06/07), and V1.3 (FR-09/10/11); it does not replace their detailed requirements, FR-05 analytical definitions, FR-08 integration requirements, or the original master context. Preserve all stable IDs, accepted source code and independently established test evidence. When documents conflict, record the conflict and the proposed resolution in the change register. Do not silently rename IDs, erase historical requirements, or mark a test passed without evidence.

The founder's product direction is an independent commercial AI-native office suite for SMEs, initially a cloud web application with future desktop and self-hosted options. The four professional studios (Document, Spreadsheet, Presentation, Intelligence) and shared AI Intelligence Core form one 5-in-1 product; data preparation, analytics, voice, integration and platform administration are shared capabilities rather than additional independent applications. Global English-first market positioning does not mean English-only interaction: English and Khmer spoken and typed instructions and bilingual artifact output are core launch requirements. The flagship initial workflow is end-to-end monthly management reporting for administration, finance and management.

Scope control: P0 describes the proposed minimum supported product release, not work authorized in the next sprint. P1 describes subsequent expansion. P2 is longer-term discovery. The first vertical slice is deliberately smaller than the P0 release. Do not confuse a completed research draft with an implemented or accepted requirement. Existing G0/G1 and D0/D1 authorization boundaries remain unchanged. Before any new implementation, determine actual founder approvals and repository state. This document recommends a read-only QE-00/RC-00 baseline and bounded local feasibility experiments subject to explicit authorization. Do not start production D2 or later phases, deploy, spend money, install machine-wide dependencies, transmit confidential information/audio, change live data, push remotely, or purchase/activate licenses without separate permission. Do not assume prior chat recommendations were approved. If you cannot inspect the repository, report that blocker.

### 0.1 Source lineage and evidence policy

- Master Research and Project Context V1.1, pp. 26–33 (51 grouped entries and original Stage 3 exit criteria), with FR-01/FR-02 detail. The earlier V1.0 and Stage 2/3 Requirements remain historical baselines.
- Main Engineering Handover V1.1, sections 3–11: preliminary editor/database/speech/Git decisions, FR-03/FR-04 requirements and evidence gates.
- FR-05 Business Analysis and Calculation Engine V0.1 (conversation research): metric registry, financial precision, ANA tests and AN-00.
- Main Engineering Report V1.2, FR-06/FR-07: presentation and BI requirements, X-VIS integration tests, and department fixture.
- FR-08 Cross-module Integration V0.1 (conversation research): linked objects, manifests, workflow and INT tests.
- Main Research Report V1.3, FR-09/10/11: AI, speech, identity, authorization, quota, audit and job contracts, GOV tests.
- FR-12 V0.1 (immediately preceding research): quality targets, 40 NFR refinements and NFR-T01–T40, retained below.
- FR-13 is the new consolidation, priority resolution and parent-level traceability plan. It does not add a second set of competing product features.

Evidence labels: SOURCE = existing research or owner decision; PROPOSED = design/target requiring review; REPORTED = coder's previous claim; VERIFIED = actual reproducible evidence reviewed for the named environment; PENDING/BLOCKED = not yet verified. No new code, test execution, penetration test, real audio benchmark, recovery drill or commercial license approval was performed by this research report. The previous coder's reported prototype evidence (including 15 tests reported passing, limited spreadsheet function evaluator and mocked speech) is historical and must not be treated as the current repository baseline.

## 1. Executive recommendations

- Retain the modular monolith with bounded, isolated processing workers. Do not create per-studio databases, duplicate AI/voice agents, or independently implemented policy and audit services. Establish shared identity, artifact, metric, operation, workflow and publication contracts.
- Prove the existing document-first vertical slice: edit an English/Khmer document manually, perform a typed scoped edit, use real or explicitly mocked speech to propose the same edit, confirm, verify, undo, save/reopen, and export supported DOCX/PDF. Mock voice is not proof of bilingual recognition.
- Establish the verified financial reporting slice as the commercial MVP: immutable XLSX/CSV inputs → reproducible data preparation → approved metric definitions → reconciled spreadsheet summary, management document, presentation and dashboard → review → published package. Use the same authorized source, metric, period, currency and filter context for all outputs.
- Preserve the 51 parent requirements (46 P0, 5 P1); organize the detailed refinements and acceptance cases beneath them. FR-01's WS refinements and FR-13 management requirements are traceability layers, not extra counted parent entries.
- Treat security, numerical correctness, supported file fidelity, recoverability, authorization and independent evidence as gates. Performance, capacity, availability, RPO/RTO and cost figures in this report are provisional test targets, not customer commitments.
- Prioritize actual evidence over expanding the prototype catalogue. Stage 4 should compare candidates against common fixtures, validate licenses and real bilingual speech, and make explicit engineering decisions before Stage 5 architecture freeze.

---

# PART A — FR-12: Non-functional Requirements (retained and clarified)

## 2. Standards and verification policy

FR-12 defines quality attributes across the four professional studios and shared services. Use ISO/IEC 25010:2023's product quality model as a taxonomy, not a certification claim [R01]. Use OWASP ASVS, with the exact version pinned (previous draft used 5.0.0; confirm the adopted stable version), target Level 2 and explicitly select additional controls for higher-risk functions [R02]. NIST SSDF and its AI profile inform secure development [R03, R04]; NIST AI RMF Generative AI Profile and OWASP GenAI resources inform risk assessment [R05, R06]. WCAG 2.2 AA is the proposed accessibility conformance target [R07]. SRE practices inform internal SLOs/error budgets [R08]; Core Web Vitals supply web UX references [R09]; ECMA-376 informs supported Office Open XML compatibility [R10]. These references are not legal advice, an audit, or evidence of conformance. Public abstracts and excerpts were used; full applicable clauses must be reviewed by qualified reviewers when adopting formal claims.

Use four classifications: mandatory hard blocker; measurable target; configurable policy with safety bounds; later enhancement. For every target define scope, measurement boundary, eligible denominator, fixture, workload, reference environment, sampling window, pass rule, owner and evidence artifact. A target may be revised through documented change control; a security or numerical correctness failure is not waived by a higher average score elsewhere. Some measurements are not meaningful until actual infrastructure, hardware, provider, browser and compatibility profiles have been selected.

## 3. Security, privacy and data integrity

Mandatory release controls:

| Domain | Requirement and verification |
| :--- | :--- |
| Identity | Secure established authentication/session implementation, protected recovery, MFA/step-up for privileged operations, expiry and revocation. Never trust a client/model tenant identifier or voice as authentication. |
| Authorization | Deny by default; server checks actor membership, tenant, workspace, resource, operation, effective row/column scope, policy, entitlement and approval at every protected call and subsequent delivery. Roles alone do not grant universal data access. Test across UI/API, AI/voice, background jobs, search, caches and file download. |
| Isolation | Tenant-scoped DB keys/relationships, private blobs, storage policies, index and result cache partitions, worker context and logs. If PostgreSQL RLS is adopted, test actual app role (non-owner/non-bypass), connection pooling, policy scope reset and foreign-key edges [R11]. Application authorization remains mandatory. |
| Transport/storage | Approved TLS and encrypted storage, backups and secret/key management. Inventory what is protected, who controls keys and how recovery/rotation is performed. Redact credentials, raw confidential prompts, unnecessary audio and personal data. |
| File processing | Untrusted original files quarantined/validated, bounded decompression/size/time/memory, isolated processing with restricted network/filesystem; detect macros, external links, active content and unsupported structures. No macro execution or unapproved external retrieval. Preserve original bytes and itemize unsupported behavior. Validate export package including notes, hidden sheets, comments, metadata and embedded chart data [R12]. |
| AI and connectors | Structured proposals only; strict schemas plus semantic checks, explicit risk and tool allowlists, protected operation handlers, bounded costs and time, no arbitrary code/SQL/files/network or prompt-granted authority. Treat retrieved files, transcripts and tool results as untrusted. Validate exact destination and revision, verify resulting state, handle conflicts, deny unauthorized provider fallback. |
| Privacy | Minimize context sent to providers; enforce approved data class, region, retention and contractual restrictions. No automatic upload of entire workspace or recordings. Audio temporary by default. Define deletion, backup expiry, holds and retention; do not promise instant purge from providers or previously downloaded files. |
| Supply chain | Lockfiles, versioned dependencies, SBOM, license inventory, secret scanning, SAST and vulnerability triage. Review commercial and embedding rights of engines, fonts, speech models, model weights and assets. Avoid a paid/restricted dependency until approved. |
| Audit | Material action actor, target/source versions, operation, approval digest, actual result, timestamps, policy and sanitized failure; access-controlled audit separate from ordinary logs. Integrity-protect records and audit privileged access; never store secrets to prove actions. |
| Security evaluation | Pin ASVS/control checklist; threat model by trust boundary; negative authorization, file, AI adversarial, concurrency and recovery tests. Authorized isolated security review before release. No unresolved known critical or relevant exploitable high-severity issue in release scope; lower-risk residual findings require documented owners and acceptance. |

Release blockers: confirmed cross-tenant access or unauthorized disclosure; authentication/authorization bypass; exposed credentials; unapproved arbitrary execution; macro execution; unauthorized change of certified data or publication; unresolved critical/relevant exploitable high vulnerabilities; inability to restore essential state. These are hard blockers, not weighted rubric deductions. A finite test suite or clean scanner cannot prove absolute security. Stage 6 develops full threat model and security design; controls are required from baseline onward, not postponed.

## 4. Performance, scalability and measurement protocols

### 4.1 Web and editor targets

Core Web Vitals reference thresholds at p75 are LCP ≤2.5 s, INP ≤200 ms and CLS ≤0.1 [R09]. Evaluate representative device categories separately; field measurements when users exist, lab tests as early diagnostic evidence. Editors need additional measurements that do not hide cold starts, slow recalculation, or expensive work behind generic web scores.

| Operation / SLI | Candidate initial target | Measurement boundary |
| :--- | :--- | :--- |
| Ordinary local edit | p95 ≤100 ms | User action to visible editor update; separate calculation/re-render for complex edits; include dropped frames and failures. |
| Standard API read | p95 ≤500 ms | Client request to complete response on named representative network; separately report server timing. |
| Small artifact save | p95 ≤1 s | Save request to truthful durable acknowledgment. Distinguish autosave draft/pending vs committed. |
| Open medium document | p95 ≤3 s | Open request to usable editor and required content. |
| Open medium workbook | p95 ≤5 s | Usable viewport and required formula state; distinguish full recalc. |
| Open medium presentation | p95 ≤5 s | First usable slide and required editing controls. |
| Standard dashboard filter | p95 ≤2 s | Input to all affected visuals showing the newest authorized result; no stale response overwrite. |
| Long operation feedback | ≤1 s proposed | Submit to visible accepted/queued/failed state; never fake percentage progress. |
| Short voice input final transcript | p95 ≤3 s | Stop/end utterance to final transcript visible, including provider/network and decode. |
| Routine AI proposal | p95 ≤5 s | Final confirmed transcript/text submit to usable validated proposal; complex workflows separately timed. |
| Microphone activation and stop | Visual response ideally ≤100 ms; stop ≤500 ms | Distinguish visual UI acknowledgment from actual capture termination; measure both. |

P95 is the 95th percentile of measured latency, not a success rate. Report p50/p95/p99, failures, timeouts, count and confidence/sample limitations. Report cold/warm runs separately; do not omit failed or timed-out operations. For initial feasibility use a reproducible fixed seed and enough repeated runs to expose tails (e.g., ≥100 routine requests per agreed workload where practical; disclose smaller samples and correlated observations). Stage 4 confirms or revises objectives on representative hardware and network, not a fabricated promise.

### 4.2 Workload envelope

| Studio / service | Small | Medium | Stress (not promised) | Complexity dimensions |
| :--- | :--- | :--- | :--- | :--- |
| Document | 5 pages | 25 pages | 100 pages | Khmer/English, images, nested tables, styles, pagination, linked fields |
| Spreadsheet | 1k×20 (20k cells) | 10k×20 (200k cells) | 100k×20 (2m cells) | Dense/sparse, formula dependency depth, volatile and cross-sheet functions, styles, long IDs |
| Data preparation | 10k rows | 100k rows | 1m rows | Width, distinct cardinality, malformed rows, joins, skew, transforms, spill disk |
| Analytics | Single summary | Grouped fiscal/budget comparisons | Many groups/concurrent queries | Distinct counts, multi-grain relationships, precision, filter scope, dates |
| Presentation | 5 slides | 20 slides | 100 slides | Native objects, charts, table count, images, mixed script and export |
| Intelligence | 4 visuals/10k rows | 12 visuals/100k rows | 30 visuals/1m rows | Filter interactions, query concurrency, cardinality, detail paging, cache isolation |
| AI | Selected-object edit | Bounded multi-step task | Management-report package | Tool count, tokens, retrieval, provider delay and failures |
| Voice | Short PTT | 30-second utterance | Long session (P1) | Accent, noise, codec, latency, critical terms, partial/duplicate events |

Retain FR-06/07 intermediate fixtures (e.g., 50 slides and 8/12-visual BI reports). Test candidate concurrent active sessions 25/100/250 across multiple tenants; begin smaller, scale only on approved resources. Sessions are not jobs: specify operations per user/minute, request rate, concurrent workers, workload mix and arrival pattern. Suggested initial synthetic mix for planning: 50% editor reads/writes, 25% dashboard queries, 15% bounded AI/voice proposals, 10% import/export/preparation jobs; revise to observed pilot data. Do not interpret it as known customer behavior. Report sustained steady-state, burst, saturation and soak behavior; define stop conditions and overload behavior before stress testing. Never load-test production or provider endpoints without authorization.

Use workload manifests with fixture hashes, engine/browser/runtime versions, hardware/OS, network/RTT, concurrency, cache state, timeout, warmup, duration, operation mix, raw timing results and cost. Separate engine-only from client-facing tests. Track import, render, recalc, memory, CPU, temporary disk, queue wait, query result size, export duration and cancellation. Record limits, failures and bottlenecks. Do not publish row/slide/cell limits based on an untested stress target.

### 4.3 Resource and scaling controls

Prefer modular application API with private transactional metadata, versioned file storage and bounded workers for conversion, analytical processing and AI/speech. Separate worker pools only when security/isolation or measured contention warrants it. Bound CPU/memory, disk, connections, request size, decoded document size, queue length, per-tenant/user task count, per-task AI/voice budget and duration. Apply backpressure and fair scheduling. Release queued jobs only after reauthorization. Oversized jobs fail safely with actionable limits; one tenant's workload must not monopolize all capacity. Use a representative second tenant in saturation tests.

## 5. Reliability, SLOs and recovery

### 5.1 Internal service-level objectives

SLI = measured outcome; SLO = internal objective; SLA = contractual commitment. Prefer user-journey SLIs rather than only /health checks. SRE guidance supports measurable goals and an explicit error-budget policy [R08].

| Service outcome | Candidate objective and definition |
| :--- | :--- |
| Core application private pilot | ≥99.5% successful eligible requests over rolling 30 days (if sufficient traffic). |
| Core application commercial GA | ≥99.9% successful eligible requests over rolling 30 days, subject to feasibility and support economics. |
| Manual editor | Remains usable for supported operations during AI/speech outage; report provider-dependent features separately. |
| AI/voice | Separate end-to-end eligible task completion SLI; include provider failures, not just our API status. |
| Acknowledged saves | All mandatory ordinary crash/restart/fault-injection fixtures recover exact acknowledged state. |
| Publication | No incomplete published package in mandatory failure cases. |
| Freshness | Display source version, last good refresh, stale/error state; organization-specific max age and explicit pinned-history exemption. |

Define eligible requests to include authorized, valid supported operations within documented limits. Count server errors, timeouts and user-visible erroneous successes as bad. Separate legitimate denials and invalid requests but audit them; do not game SLO with selective exclusion. Track user-visible outages via synthetic probes when volume is low. Request-based error budget = (1 − objective) × eligible requests. Time-based 30-day examples: 99.5% permits 216 minutes of unavailable time; 99.9% permits 43.2 minutes. These are distinct measures, not equivalent contractual SLAs. If error budget is exhausted, prioritize reliability work and pause risky feature rollouts, with emergency security fixes/approved exceptions. Establish alert thresholds, on-call responsibilities and communication procedures only after operational capacity is known.

### 5.2 Fault and consistency behavior

Browser crash/refresh returns latest acknowledged revision; unsaved recovery is best effort and clearly labeled. Save acknowledgment follows required durable commit, not a mere queue receipt. Reconcile uncertain execution using operation identity and committed result before retrying. Detect stale revision and concurrent edit conflicts; restore as a new revision, not history rewrite. Provider outage preserves manual/typed modes and last good artifacts; only permitted compatible fallback. Worker restart persists leases, fencing, attempts and job state; retries bounded and idempotent; cancellation stops eligible future steps and accurately reports already committed effects. No partial publication: stage blobs and verify manifest, then commit publication metadata/revision pointers/audit/outbox transactionally. Object storage and DB are not one atomic transaction; reconcile orphaned stages. Never expose partly validated outputs as published. Apply rollback-compatible migrations, schema/backward compatibility plan and isolated restoration verification before production changes.

### 5.3 Recovery objectives and backup scope

| Environment | Proposed RPO | Proposed RTO | Qualification |
| :--- | :--- | :--- | :--- |
| Local development | Snapshot before material changes | Within one working day | Protected development backup, not customer SLO. |
| Private pilot catastrophic loss | ≤24 h | ≤8 h | Subject to approval and exercised restoration. |
| Initial commercial catastrophic loss | ≤15 min | ≤4 h | Candidate across entire required state, not just database. Validate costs and actual restoration. |
| Future enterprise | Contract-specific | Contract-specific | Do not sell until supported. |

RPO measures maximum tolerable loss window and RTO service restoration time after a disruption. These catastrophic-loss objectives do not permit loss of acknowledged saves in ordinary failures. PostgreSQL continuous archiving/PITR is a candidate if selected [R13]. Backup DB and immutable files/datasets/revisions together using recoverable manifest/checkpoint references, checksums and consistent availability; protect configuration, keys and audit separately, ensure recovery of keys and access control. Use encrypted copies under restricted credentials, independent failure domain where authorized; verify retention and deletion/hold policy. Design recovery for deleted/revoked identities, tombstones and obsolete connector credentials; do not replay external jobs automatically. Isolated restoration drill: restore data and files, validate reference graph and checksums, compare financial outputs and published history, verify tenant/role policies and revocation, run supported critical workflows, measure time and actual recovery point. Record every discrepancy. Proposed automated verification and quarterly full drill once operating, subject to staffing. No live restore in this research. NIST contingency planning is an additional reference [R14].

## 6. Data integrity and Office interoperability

Certified data, metrics and snapshots are versioned; a change to a draft cannot overwrite official figures. Original source checksums, recipes, lineage, exceptions and approvals are preserved. Missing is not zero; a zero denominator is explicitly unavailable unless an approved metric specifies otherwise. Use stable business keys, enforce join cardinality, validate unmatched and multiplied records, protect IDs and ambiguous dates. Do not sum different currencies without authorized conversion policy, rate source/date/direction. Governed financial metrics use documented exact monetary storage and rounding; spreadsheet compatibility behavior may differ. DuckDB DECIMAL division must be tested because division can produce approximate floating results [R15]. Compare independently expected totals, not just consistency between outputs of the same engine. All required golden calculation fixtures pass for release scope.

### 6.1 Common golden fixture (synthetic, USD only)

November (complete fictional period): net sales 150,000; COGS 90,000; gross profit 60,000; operating expenses 20,000; operating profit 40,000; total costs 110,000; gross margin 40.00%; operating margin 26.67% (40,000/150,000, display rounded); previous-month net sales 125,000; growth 20.00%. Budget revenue 140,000, budget total costs 100,000, budget operating profit 40,000. Actual-minus-budget: revenue +10,000 favorable under approved policy, total costs +10,000 unfavorable, operating profit 0. These are management-report definitions, not a complete accounting model; no tax, interest, FX or accrual assumptions. Use immutable test fixtures and independent expected results. Test ratio of totals, distinct counts, fiscal boundary, missing amount, unmatched joins, ambiguity and rounding. The detailed department fixture appears in V1.2; do not mix fiscal periods or filter scopes. Use the same certified result reference across workbook, document, deck and dashboard.

### 6.2 Candidate supported-format profiles

| Format | Initial scope to verify | Explicit limits / failure behavior |
| :--- | :--- | :--- |
| DOCX | Supported paragraphs/runs, headings, lists, tables, images, page sizing/margins, basic header/footer, numbering and supported template fields; editable output; Khmer text. | Detect unsupported structures, sections, advanced fields, track changes, embedded objects, macros, font substitutions; reject/read-only/warn when editing would materially lose content. |
| XLSX | Supported sheets, values/types/styles, relative/absolute/mixed/cross-sheet references, documented core formulas, basic tables, filters, named ranges, charts where supported. | Preserve leading zeros and long identifiers; test 1900/1904 date systems; warn about unsupported functions, external links, pivot/Power Query, macros, cached values; never pretend unsupported formula = 0. |
| PPTX | Supported slides, text, shapes, geometry, images, native tables/charts, notes and basic layout/theme; editable objects. | Detect advanced animation, SmartArt, OLE, macros/external links and unavailable fonts; no flattening as substitute for required editability. |
| PDF | Render supported artifacts with readable bilingual text and intended layout, searchable text where supported; inspect rendered pages. | Export format, not general editable Office import. Document font, accessibility and conversion limitations. |
| CSV | Delimited records, header/encoding/locale decisions, quoted fields, malformed reject accounting, safe CSV injection policy. | Not a workbook; no formulas/styles/sheets. Preserve original input; distinguish safe export from raw data. |

These are proposed profiles, not frozen compatibility promises. Test in named licensed reference applications/versions; Office Open XML package validation alone is insufficient [R10]. Preserve original bytes, parse supported content, edit, export, reopen, inspect semantics/geometry/render, recalc independently and verify editability. Use visual QA alongside structural checks (native text/tables/charts, no required clipping, Khmer shaped text and fonts). Define per-feature tolerances (e.g., page layout/font substitution) from representative fixtures in Stage 4; no silent supported-feature loss. If reference application is unavailable, mark verification blocked, not pass from XML alone. Never automatically execute embedded content or external references.

## 7. AI, voice, accessibility and product validation

### 7.1 AI and voice release evidence

Retain FR-09 evaluation: proposed 200 underlying routine task scenarios, EN and KM equivalent typed versions (400 language-specific cases before repeats), separately adversarial/ambiguous/error suites. Use held-out tasks not used to tune prompts, compare independently specified final state, target, operation and side effects. Report first-attempt and after permitted correction success, failed/abandoned/timed-out tasks, cost and latency, repeated-trial consistency (not just pass-at-least-once), confidence intervals and sample limitations. No benchmark guarantees all future tasks.

Retain FR-10 proposed Corporate Voice Benchmark: at least 30 consented speakers, 1,000+ utterances (illustrative 400 EN, 400 KM, 200 mixed), speaker-disjoint held-out sets; vary device, noise, accents and instruction complexity. Measure WER English, documented Khmer CER/normalization, critical-field exact-match, intent/target and final-state correctness, clarification and false activation, latency and cost. Native review for Khmer, real recordings only with informed authorization; separate synthetic/mocked transcripts from live recognition. Evaluate code-switching and TTS separately before P1 claims. Verify critical amounts, currencies, dates, names, cell addresses and metric definition with structured confirmation; transcript corrections invalidate obsolete confirmation. Partial transcripts and dictated imperative text must not trigger a protected mutation. The same tool/policy path applies to typed and spoken commands.

| Quality gate | Candidate threshold or hard rule |
| :--- | :--- |
| Routine typed English | ≥95% end-to-end success on approved held-out suite |
| Routine typed Khmer | ≥95% separately before general release |
| Routine English voice-to-action | ≥95% independently assessed |
| Routine Khmer voice-to-action | ≥95% independently assessed before general release |
| Typed-spoken equivalence | ≥95% across agreed paired routine tasks; separately report both languages |
| Critical fields/financial fixtures | All required accepted-execution fixtures exact according to policy; no wrong-target protected mutation |
| Authorization, injection, recovery | All mandatory negative and recovery fixtures pass; no unauthorized material action/disclosure in tested scenarios |
| Model/provider upgrades | Version/capability/prompt/schema regression and policy checks before activation; rollback/disable plan |
| Grounding | Material factual claims in certified reporting traceable to approved evidence; unresolved critical issue blocks publication |

Targets are provisional; include eligible failures in denominators. If Khmer speech does not meet launch criteria, do not silently remove it or call mocks production support. Escalate evidence-based release scope decision to founder. Limited alpha may be explicitly scoped/labeled with typed/manual fallbacks; general-release bilingual requirement remains unless formally changed. Model capabilities and vendor policies vary: validate exact region, model, mode, lifecycle, license, processing terms, cost, actual accuracy; no assumed winner.

### 7.2 Accessibility and language quality

Target WCAG 2.2 AA for defined web experience [R07]; verify applicable criteria including ordinary text contrast ≥4.5:1 where applicable, 3:1 large text and relevant non-text controls, keyboard access, visible focus, semantic names/roles/state, non-color indicators, meaningful status announcements, accessible authentication, keyboard/non-drag alternatives, reflow/zoom and reduced motion. Distinguish essential two-dimensional editor/table exceptions from inaccessible surrounding controls. Test actual editors, menus, dialogs, grid navigation, slide object selection, filter controls, textual chart alternatives, transcript and error states; automated axe checks plus manual keyboard and assistive technology. Voice never mandatory. Separate generated artifact accessibility from web shell accessibility; inspect alt text, heading order, table headers, reading order and PDF accessibility profile without claiming universal conformance. Khmer Unicode preserve graphemes, combining marks/subscripts, line wrapping, cursor/selection/delete/search, date/currency/ID correctness, font substitution and searchable exports; use native-reviewed fixtures, independent input/UI/output language settings [R16].

### 7.3 Pilot business outcomes

Retain prior proposed targets: ≥30% median reduction in active time from import to approved reporting package (including corrections and review), ≥90% eligible attempts reach approved output (include abandoned/failed), ≥60% eligible activated pilot organizations repeat the next reporting cycle. Measure comparable baseline tasks, task complexity, participant role, training and assistance; collect active time and elapsed time separately. Define activation and recurrence denominators before pilot. Monitor cost per successful approved task and quality; do not infer commercial demand from a small prototype or mock test. SME workflow interviews, representative templates and willingness-to-pay remain validation tasks.

## 8. Maintainability, observability and commercial operations

Use reproducible Git, reviewable changes, strict shared schema and types, versioned migrations, documented ADRs, lockfiles, license/SBOM inventory, static checks, tests, build reproducibility, secrets isolation, structured sanitized errors, and rollback/roll-forward plan. Unit/property tests for formulas/policies and transform invariants, integration tests for real DB/storage/job consistency, E2E for user workflows, dedicated security/adversarial, accessibility, interoperability, load and recovery suites. Select existing frameworks first. Candidate tools: Vitest/Jest, Playwright, fast-check, k6/Locust, axe-core, ecosystem vulnerability scanner, appropriate SAST, authorized isolated OWASP ZAP, SPDX/CycloneDX SBOM and OpenTelemetry-compatible instrumentation [R17]. No automatic dependency installation. Maintain the existing passing suites and isolate experiments.

Monitor request count/latency/errors, queue depth and waits, worker failure/resource saturation, DB connections and query latency, object storage, AI/speech health/cost/fallback, job completion and cancellation, backup freshness and verification, user-visible frontend error, security denials and incident signals. Use correlation IDs and safe structured metadata; avoid raw customer documents/audio in telemetry, control access to audit. Dashboards for operator vs tenant admin are distinct. Proposed severity model: SEV-1 breach/severe data corruption/broad outage, immediate containment/incident process; SEV-2 major studio outage/degradation, prioritized recovery; SEV-3 limited feature failure, urgent remediation; SEV-4 minor defect, backlog. Assign responsibilities and escalation; actual support/SLA depends on staffing. Post-incident review, action owners and due dates; no false resolution claims.

Commercial quality: one shared ledger across AI, speech, storage and processing; distinguish estimates, reservations, observed and reconciled charges, deduplicate events, account for failed/retried tasks and unknown provider charges. Track infrastructure cost per active organization, cost per successful approved package including AI calls, speech, rendering, storage/recovery, support allocation where applicable; enforce tenant/user/task quota, concurrent reservations, safe cancellation and entitlement decisions. Exhausted AI allowance must not delete or block authorized retrieval of existing work. Set pricing/budget only after benchmark and vendor terms, not hypothetical rates. Internal entitlements and mock plan states P0; live billing adapter and subscriptions require separate commercial authorization.

## 9. FR-12 detailed requirement register (40 retained IDs)

These are proposed refinements of NFR-01–04, not additional parent requirements. Test IDs below are evidence links, not claims of completed execution. Parent/leaf tests may share fixtures; every applicable control still needs verification.

| ID | Requirement | Priority | Principal verification |
| :--- | :--- | :--- | :--- |
| NFR-01.01 | Encrypted data transport | P0 | NFR-T01 |
| NFR-01.02 | Protected storage and key management | P0 | NFR-T02, NFR-T13 |
| NFR-01.03 | Secure authentication and session lifecycle | P0 | NFR-T04, NFR-T09 |
| NFR-01.04 | Server-side resource authorization | P0 | NFR-T03, NFR-T04, PLT-T10 |
| NFR-01.05 | End-to-end tenant isolation | P0 | NFR-T03, PLT-T08, PLT-T12, NFR-T25 |
| NFR-01.06 | Safe file ingestion and processing | P0 | NFR-T05, PLT-T22–T26 |
| NFR-01.07 | AI and connector security verification | P0 | NFR-T06, AI-T10–T14, AI-T17 |
| NFR-01.08 | Secure software supply chain | P0 | NFR-T07, NFR-T08, NFR-T38 |
| NFR-01.09 | Confidential-data and privacy controls | P0 | NFR-T02, NFR-T07, VOC-T20, VOC-T26, PLT-T20 |
| NFR-01.10 | Security assessment and remediation gates | P0 | NFR-T03–T09, control matrix and residual-risk review |
| NFR-02.01 | Service-level indicators and objectives | P0 | NFR-T23–T25, NFR-T39, SLO measurement review |
| NFR-02.02 | Durable acknowledgment of saved state | P0 | NFR-T10, PLT-T15 |
| NFR-02.03 | Job interruption and retry recovery | P0 | NFR-T11, NFR-T12, INT-T13–T15 |
| NFR-02.04 | Encrypted, coordinated application backups | P0 | NFR-T02, NFR-T13, PLT-T35 |
| NFR-02.05 | Defined and tested RPO and RTO | P0 | NFR-T13, NFR-T14 |
| NFR-02.06 | Monitoring, alerting and service-health reporting | P0 | NFR-T39, PLT-T36 |
| NFR-02.07 | Incident management and operational procedures | P0 | NFR-T39, tabletop and recovery evidence |
| NFR-02.08 | Controlled software deployment and rollback | P0 | NFR-T17, NFR-T37, NFR-T38 |
| NFR-02.09 | External-provider failure isolation | P0 | NFR-T15, NFR-T16, GOV-T04 |
| NFR-02.10 | Enhanced redundancy and disaster resilience | P1 | NFR-T13–T14, future fault-domain test |
| NFR-03.01 | WCAG 2.2 AA verification target | P0 | NFR-T18–T22, applicable criteria matrix |
| NFR-03.02 | Keyboard-accessible essential workflows | P0 | NFR-T18, VOC-T28 |
| NFR-03.03 | Meaningful focus, labels and status feedback | P0 | NFR-T18–T20 |
| NFR-03.04 | Accessible editor and chart interaction | P0 | NFR-T18–T20, BI-T31 |
| NFR-03.05 | Alternative typed and visual voice interactions | P0 | NFR-T16, NFR-T22, VOC-T01 |
| NFR-03.06 | English and Khmer rendering quality | P0 | NFR-T21, NFR-T36, PPT-T09–T10 |
| NFR-03.07 | Locale-aware business information presentation | P0 | NFR-T21, NFR-T27, SHT-T05, DAT-T03 |
| NFR-03.08 | Representative user workflow evaluation | P0 | NFR-T40, pilot outcome protocol |
| NFR-04.01 | Browser experience performance | P0 | NFR-T23 |
| NFR-04.02 | Editor responsiveness | P0 | NFR-T24 |
| NFR-04.03 | API latency and throughput | P0 | NFR-T25 |
| NFR-04.04 | Representative workload capacity | P0 | NFR-T24–T26 |
| NFR-04.05 | Tenant-aware resource and concurrency limits | P0 | NFR-T25, NFR-T26, NFR-T32 |
| NFR-04.06 | Financial and cross-module correctness | P0 | NFR-T27, NFR-T28, NFR-T40 |
| NFR-04.07 | Bilingual AI task evaluation | P0 | NFR-T29, NFR-T30 |
| NFR-04.08 | Bilingual voice task evaluation | P0 | NFR-T31, VOC-T05–T15 |
| NFR-04.09 | AI and infrastructure cost measurement | P0 | NFR-T25, NFR-T31, NFR-T32; measured cost ledger |
| NFR-04.10 | Supported Office format fidelity | P0 | NFR-T33–T36, E2E-06 |
| NFR-04.11 | Maintainability and reproducible engineering | P0 | NFR-T37, NFR-T38, ADR/code review |
| NFR-04.12 | Automated regression and release verification | P0 | NFR-T37–T40; release checklist |

## 10. NFR acceptance matrix (40 retained cases)

All test statuses in this document: NOT RUN / pending evidence. Include relevant positive and negative cases, expected behavior and evidence scope. Where infrastructure or licensed tools are unavailable, mark BLOCKED. Do not claim real production controls pass from a mock.

| Test ID | Scenario | Required result / evidence |
| :--- | :--- | :--- |
| NFR-T01 | Verify transport security | No unapproved plaintext transfer; inspect actual TLS boundaries. |
| NFR-T02 | Inspect stored confidential information | Approved encryption, access controls and key recovery design; verify protected storage/backups. |
| NFR-T03 | Attempt cross-tenant resource access | Denied through API, DB role, object store, cache, retrieval and worker. |
| NFR-T04 | Attempt administrative privilege escalation | Denied and safely audited; privileged step-up as applicable. |
| NFR-T05 | Submit malformed Office file | Safe bounded rejection/quarantine; source preserved. |
| NFR-T06 | Process malicious embedded instructions | No unauthorized execution/disclosure; test prompt-injected file and tool output. |
| NFR-T07 | Inspect build and logs for credentials | No unintended secret or sensitive content exposure. |
| NFR-T08 | Scan dependencies and licenses | Findings documented, triaged and resolved or accepted within release policy; actual versions and license evidence. |
| NFR-T09 | Test expired or revoked sessions | Protected reads/writes/jobs denied; session context revoked. |
| NFR-T10 | Crash browser after acknowledged save | Recover exact committed revision; unsaved state correctly distinguished. |
| NFR-T11 | Interrupt processing worker | Safe recovery, fencing and truthful status. |
| NFR-T12 | Repeat committed operation | No duplicate business effect or publication. |
| NFR-T13 | Restore isolated backup | DB/object references, checksums, financial values, permissions and history reconcile. |
| NFR-T14 | Measure disaster recovery | Actual recovery point/time meet approved targets for complete service. |
| NFR-T15 | Simulate AI outage | Supported manual editing remains functional; policy-aware fallback only. |
| NFR-T16 | Simulate speech outage | Typed/manual interaction remains available. |
| NFR-T17 | Interrupt deployment | Recover supported consistent state; migration rollback or safe roll-forward. |
| NFR-T18 | Keyboard-only workflow | All scoped essential controls, editors, dialogs and alternatives usable. |
| NFR-T19 | Screen-reader interaction | Meaningful names/roles/state and status; manual assistive-technology evidence. |
| NFR-T20 | Evaluate contrast | Applicable WCAG AA criteria satisfied or explicit blocker. |
| NFR-T21 | Render Khmer across studios | No mandatory character corruption, correct layout/editing and locale handling. |
| NFR-T22 | Complete essential task without voice | Typed/visual alternative supports equivalent authorized operation. |
| NFR-T23 | Measure web experience | p75 Core Web Vitals and environment, field/lab distinction, errors. |
| NFR-T24 | Medium editor workloads | p95 responsiveness/open/save/recalc, memory and failures reported against targets. |
| NFR-T25 | Multi-tenant load | Throughput, latency, isolation, fairness, saturation and resource/cost evidence. |
| NFR-T26 | Oversized processing job | Bounded execution or controlled rejection, no escape/starvation. |
| NFR-T27 | Financial golden fixtures | Independently specified values, rounding, zero/null, FX and aggregation semantics. |
| NFR-T28 | Reconcile all reporting outputs | Exact approved result context and supported figures, not circular verification. |
| NFR-T29 | Held-out English AI benchmark | Real-model success/failures/clarification, latency and cost separately. |
| NFR-T30 | Held-out Khmer AI benchmark | Real-model results, native review and separate denominator. |
| NFR-T31 | Bilingual speech benchmark | Consented held-out actual speech to exact state; critical field and cost evidence. |
| NFR-T32 | Concurrent usage reservations | Atomic bounds, deduplicated settlement, failure handling. |
| NFR-T33 | DOCX round trip | Supported content, editable structure and actual layout preserved. |
| NFR-T34 | XLSX round trip | Values, types, formulas and supported behavior verified independently. |
| NFR-T35 | PPTX round trip | Native editable objects, supported chart values and geometry preserved. |
| NFR-T36 | Render bilingual PDF | Visual QA, no required clipping/glyph corruption, searchable text where supported. |
| NFR-T37 | Reproduce application build | From documented versioned configuration, exact commands and logs; no secrets. |
| NFR-T38 | Upgrade model/dependency | Applicable regression/security/license checks, rollback or disable strategy. |
| NFR-T39 | Operational incident simulation | Monitoring, alerting, escalation, response, recovery and postmortem function. |
| NFR-T40 | Complete reporting workflow | Accurate linked outputs, controlled approval, recovery, publication and user outcome evidence. |

## 11. Quality engineering and release lifecycle

Retain QE-00 baseline; QE-01 requirements traceability; QE-02 security verification; QE-03 builds/regression; QE-04 numerical integrity; QE-05 Office compatibility; QE-06 performance; QE-07 reliability; QE-08 backup/recovery; QE-09 accessibility/localization; QE-10 live AI/voice evaluation; QE-11 monitoring/economics; QE-12 integrated readiness. These are cross-cutting workstreams, not sequential permission to defer security or tests. Attach the relevant tasks to each module phase.

| Release stage | Entry/exit gate |
| :--- | :--- |
| Local engineering prototype | Synthetic fixtures; mock vs real clearly labeled; no unsupported commercial claims. |
| Integrated development build | Approved contracts, baseline tests, actual scoped integration and safe failures. |
| Private alpha | Explicitly authorized users, approved limited features, real tenant/auth and restore safety, known limitations and incident contacts. |
| Private pilot | Approved SME participants, representative workflows, measured usability, security, fidelity, reliability, bilingual quality and costs; support and retention controls. |
| Release candidate | Approved P0 scope, verified full release matrix and no critical blockers; reference app and actual live AI/voice evidence. |
| GA | Founder release approval, approved operations/support/commercial/legal terms, controlled deployment and rollback. |

Hard-stop release conditions include any mandatory security, data correctness, disclosure, recovery, supported-format, or required bilingual capability failure. Evaluate target shortfalls using risk and revised formally approved scope before release; do not claim untested features or use an averaged readiness score. The final evidence register should distinguish PASS (target environment), FAIL, NOT RUN, BLOCKED, MOCK ONLY, and approved nonapplicability. A mock may pass a contract unit test but cannot establish live provider, real DB isolation, actual Office reference-renderer, or production recovery evidence.

---

# PART B — FR-13: Complete Requirements Consolidation (new research)

## 12. Requirements engineering method

ISO/IEC/IEEE 29148:2018 defines requirements-engineering processes and the information items produced across the lifecycle [R18]. NASA's requirements verification matrix guidance uses uniquely identified requirements tied to definitive sources [R19]. SEBoK describes bidirectional traceability and baselining/change control [R20, R21]. We adopt these principles proportionately for an SME software project: no claim of formal ISO conformity or use of aerospace certification processes. A requirement must be necessary, clear, consistent, feasible, testable, traceable and within an explicitly agreed scope. Verification asks whether the specified behavior was implemented; validation asks whether it solves the user's actual business problem. Both are needed. In this document, proposed shall statements become binding only after approval and must be tested in their applicable release environment.

Use a single canonical Requirements Register in the repository. Suggested record fields: stable ID; parent and aliases; source/version and source location; business need/user journey; normative requirement; rationale; scope and priority; release target; owning module and accountable role; dependencies; preconditions; positive/negative acceptance conditions; test IDs and verification method; evidence path/commit/environment; actual status; risk/ADR/change request; reviewer and decision date. One requirement can map to several tests and one integration fixture to several requirements. Store implementation evidence separately from specification. Distinguish the original parent count from leaf-level refinements, execution work items and test cases. Keep superseded entries and migrations of IDs; do not delete a requirement simply because it is not implemented yet.

Example: INT-01 → INT-01.03 (versioned metric references) + ANA-01 + DOC-03 + PPT-01 + BI-01 → INT-T01, X-VIS-01, GOV-T02, E2E-01, NFR-T28 → actual code paths and fixture version/expected and actual values (to be supplied by coder) → reviewer decision. A test plan covering these IDs is not itself successful verification.

Change procedure: submit change request with reason, customer impact, affected requirements/tests/roles/architecture/license/cost/security and migration; compare alternatives; founder or designated approver accepts/rejects; record version and effective date; update dependent specifications and tests; verify regressions. No hidden scope changes during implementation. Retain historical approved snapshots independently of requirements revision changes.

## 13. Consolidated product requirements specification

### 13.1 Vision, target users and bounded product promise

Commercial, public-facing SaaS for small/medium businesses, with globally usable English-first positioning and explicit English–Khmer command/output support. Hypothesized customer size 10–250 staff is unvalidated; do not set seat or server capacity from this assumption. Primary jobs: prepare dependable corporate documents; organize and clean spreadsheet data; calculate business metrics; generate editable management presentations and dashboards; coordinate reporting through natural language; review and publish outputs while preserving provenance. Initial departments administration, finance and management. Later procurement, HR, sales and operations templates extend the same model. Web first; desktop/offline/self-hosted later subject to licensing, security and deployment feasibility.

| User/persona | Primary need | Success evidence |
| :--- | :--- | :--- |
| Organization owner / CEO | Control company account, access, policies, plans; approve appropriate outputs | Correct authority and package visibility; usable management report. |
| Tenant administrator | Invite and remove users; configure policy, branding, limits | Role and entitlement boundaries; revoke access without losing organizational files. |
| Finance analyst / data steward | Import, clean and reconcile data, define approved metrics, prepare report | Independent totals, exception review, repeatable recipe; no hidden correction. |
| Administration / editor | Compose letters, reports and decks in EN/KM, issue scoped voice commands | Editability, correct selection, preview, recovery, supported export. |
| Reviewer / manager | Inspect and approve exact artifact/package version | Sources, assumptions, exceptions and changes visible; approval invalidated on change. |
| Viewer | Read authorized published outputs and permitted dashboard detail | No write or extra data access; safe download if granted. |
| Billing administrator / auditor | Inspect scoped plan, usage or audit evidence | Does not inherit sensitive artifact content privileges. |
| Platform operator | Operate service, monitor incidents and restore | Tenant content access is separately authorized and audited; no standing broad access. |

Role names are proposed role templates, not universal permission grants. Combine role, tenant/workspace membership, resource grants, effective data scope, entitlement, data class and operation risk. Finance metric owner/steward and reviewer are scoped capabilities, not new unrestricted admins. No ordinary agent tool for role elevation, payment activation or unrestricted admin. Step-up and separation-of-duties for sensitive approval configurable within minimum security policy. Formalize detailed role/action/resource matrix in Stage 4/6.

### 13.2 Prioritized user journeys and MVP boundaries

| Workflow | Priority | Acceptance objective |
| :--- | :--- | :--- |
| WF-01 Monthly management reporting | P0 flagship | All linked outputs from prepared certified data; approval and history. |
| WF-02 Data cleaning and consolidation | P0 | Immutable input, repeatable recipe, exception/reconciliation evidence. |
| WF-03 Corporate document authoring | P0 | Bilingual text, editable supported format, contextual AI and review. |
| WF-04 Executive presentation | P0 | Editable slides and consistent sourced charts and figures. |
| WF-05 KPI dashboard | P0 | Permission-aware filters, verified results and snapshot. |
| WF-06 Budget review | P1 full workflow | Dedicated advanced workflows later; basic budget-versus-actual metric/comparison retained P0 as part of WF-01. |
| WF-07 Supplier quotations | P1 | Reusable comparison templates and workflows. |
| WF-08 Attendance reporting | P1 | Authorized summary, not payroll. |
| WF-09 Sales analysis | P1 | Richer standalone workflow; basic sales reporting remains P0. |
| WF-10 Recurring administration | P1 | Scheduled approved workflows; bounded triggers and policies. |
| WF-11 Inventory | P2 | Future workflow research, not inventory management system. |
| WF-12 Audit workflow | P2 | Future business audit automation; platform audit and access controls are already P0. |
| WF-13 Forecasting | P2 full workflow | P1 exploratory forecasting/what-if components evaluated first; no production forecasts in P0. |

### 13.3 Implementation scope versus release scope

| Delivery slice | Included | Not sufficient to claim |
| :--- | :--- | :--- |
| S0 existing local prototype and bounded feasibility | Preserve actual implementation. Inspect editor/formula/speech mock/live state; verify baseline, evaluate candidate engines, synthetic fixtures. | Secure SaaS, actual Khmer speech, full Office fidelity or production readiness. |
| S1 document-first vertical slice | Real editor save/reopen, scoped EN/KM text edit, operation preview/commit/undo, PTT and confirmed transcript, supported DOCX/PDF, actual relevant auth/versions/audit when foundation approved. | All studio capabilities; mocked speech is explicitly limited. |
| S2 governed numerical vertical slice | XLSX/CSV intake, profile/clean/join/validate, metric registry, accurate summaries, spreadsheet and document output with shared values. | Full Excel parity or autonomous agents. |
| S3 flagship integrated slice | Add editable deck, filter-aware dashboard, pinned report package, exact-revision approval, refresh/new version, same typed/voice plan, negative auth, failure/recovery. | All proposed P0 authoring breadth until supported profiles and tests pass. |
| P0 release baseline | Approved P0 catalog and supported-format/function/load envelopes; bilingual typed/voice workflows, ordinary manual editing, quotas, security, recoverability, accessibility, commercial operations and acceptance evidence. | Advanced P1/P2 features or enterprise service guarantees. |

This sequencing does not reclassify P0 requirements. Any reduction of the launch baseline requires formal founder change approval. A narrow private alpha may label missing functions and avoid unsupported claims; full P0 acceptance is required for general release. If actual repository has passed some phases, verify evidence and continue from the next approved dependency rather than rebuild. Do not initiate all slices simultaneously.

### 13.4 Explicit initial exclusions and controlled expansion

Excluded from MVP: ERP, accounting ledger, payroll, CRM, digital signature/legal certification, regulated records management, full Office/VBA/PBIX/Power Query parity, executing macros and external file links, unrestricted SQL/Python/shell/network agent tools, voice-as-authentication, always-listening/wake-word, custom voice cloning, autonomous publication or financial record changes, full real-time coediting and offline desktop/self-hosting, arbitrary external connectors, enterprise federation/provisioning, advanced forecasting/optimization. P1 includes advanced pivots, tracked changes/mail merge, richer models, scheduled refresh, real-time conversation/TTS and mixed-utterance recognition, advanced collaboration and separately approved commercial payment integration. P0 requires internal plan/entitlement/usage control even if payment processing is deferred. Do not convert later-phase features into immediate dependencies simply because a library offers them.

## 14. Consolidated logical SRS and shared engineering boundaries

### 14.1 Workstream inventory (FR-01–FR-13)

| ID | Responsibility | Retained baseline / refinement |
| :--- | :--- | :--- |
| FR-01 | Unified corporate workspace and reporting | WS-01–WS-15; shared navigation, identity, artifact catalog, data links, history, AI/voice, workflow, templates. Maps to PLT, INT, AI, VOC and studio parents. |
| FR-02 | Document Studio | DOC-01–05; existing D02-* and DOC-* refinements; P0 rich text, templates, sources, review, exports. |
| FR-03 | Spreadsheet Studio | SHT-01–06; core formulas, recalculation, types, data editing, supported XLSX/CSV; V1.1 handover. |
| FR-04 | Data Preparation | DAT-01–06; immutable raw/staging/prepared/certified data, profiling, transformations, joins, recipes, validation; V1.1. |
| FR-05 | Business Analysis | ANA-01–04; metric registry, financial/statistical results, provenance; FR-05 V0.1. |
| FR-06 | Presentation Studio | PPT-01–03; native objects, templates, notes, compatibility; V1.2. |
| FR-07 | Intelligence Studio | BI-01–03; dashboard builder, filters/drill detail, snapshots; V1.2. |
| FR-08 | Cross-module Integration | INT-01–04; linked objects, refresh, provenance, workflows and atomic publication; FR-08 V0.1. |
| FR-09 | AI Intelligence Core | AI-01–07; scoped proposals, bounded agents, tools, retrieval, security, routing, audit and budget; V1.3. |
| FR-10 | Voice Intelligence | VOC-01–03; EN/KM PTT, confirmed action, future realtime; V1.3. |
| FR-11 | Shared Platform Administration | PLT-01–06; tenant, version/file lifecycle, jobs, entitlements and quotas; V1.3. |
| FR-12 | Non-functional quality | NFR-01–04; 40 refinements and tests, Part A of this report. |
| FR-13 | Requirements consolidation | Parent RTM, priority resolution, validation, change control, Stage 3 exit/Stage 4 entry. No extra product parent ID. |

All 13 research milestones are now drafted at requirements level. Preserve detailed research identifiers where they already exist. Master V1.1 contains earlier D02-style refinement identifiers and WS refinements; the later DOC subrequirements are overlapping descriptions, not automatically replacements. Coder shall map their aliases and parent relationships and preserve prior traceability. If exact lower-level source unavailable, flag gap and request/retrieve source; do not guess a new ID. This report defines a parent-level RTM and NFR leaf mapping; it is not an exhaustive, approved leaf-level SRS or code-to-test matrix. Reconcile lower-level register in RC-00/QE-01 from the named handovers and actual code.

### 14.2 Ownership, authoritative state and interfaces

| System responsibility | Canonical owner | Key contract / invariant |
| :--- | :--- | :--- |
| Identity and access | PLT foundation / D2 | Actor from authenticated session, tenant/workspace membership, effective grants, policy version, resource check. Role and subscription are separate. |
| Artifact identity/version | FR-11 + FR-08 | ArtifactReference, ArtifactRevisionReference, immutable source/version, expected revision, staged/approved/published state. Specialized content stays in studio. |
| File ingest/storage | FR-11 + FR-04 | Quarantine/validate, immutable original, tenant-scoped object and checksum, bounded parsing, diagnostics. |
| Spreadsheet calculation | FR-03 | Workbook operations/formula dependencies and documented compatibility semantics. Not certified semantic engine by default. |
| Data preparation | FR-04 | Recipe version, schema and lineage, rejects/exception, reconcile, certification decision; no mutable overwrite of source. |
| Governed metrics | FR-05 | MetricDefinition/Version, AnalyticalQuery/Result, financial precision, period/currency/filter/grain, source version; exact result and validation state. |
| Shared visual specification | FR-03/06/07/08 | ChartSpec + authorized AnalyticalResultReference and presentation adapter; display styling independent of metric values. |
| Linked data and publication | FR-08 | LinkedMetricReference / LinkedObjectBinding, ReportingContext, dependency edge, refresh proposal, manifest digest, approval. Inspect existing definitions before adding. |
| AI context/plan | FR-09 | ContextEnvelope, provider adapter/model capability, typed proposal; context is minimized and untrusted retrieved content not instruction. |
| Speech | FR-10 | VoiceSession, utterance ID, original/final/corrected transcript, critical fields; confirmed text feeds same AI/manual operation path. |
| Tool execution | FR-09 + FR-11 | Versioned ToolDefinition, authorization/approval policy, schema and semantic validation, exact target revision, deterministic handler, outcome verifier. |
| Job orchestration | FR-08 + FR-11 | WorkflowRun, job/operation identity, leases/fencing, durable state, bounded retry, cancellation and truthful status. |
| Quota/usage | FR-11 + FR-09/10 | One entitlement + usage reservation/settlement ledger; atomic concurrent quotas, observed/reconciled cost. |
| Audit and observability | FR-11 + FR-12 | One material action and approval audit, protected scope; separate safe operational traces/metrics/logs. |

No studio writes another studio's private storage directly. Use stable references and validated contracts. Backend derives identity and policy, not LLM. Use schema migrations and versioning rather than incompatible copies of contracts. Proposed names are conceptual and may match or extend existing types. Distinguish operation proposal from trusted execution record; user confirmation/approval binds exact target, parameters, scope and manifest digest. The model cannot select arbitrary handler or increase permissions. Numerical results from approved analytics are read from engine outputs, not model estimates. External data retrieval and model failover are subject to current processing policy. Manual features independent of AI remain available during outages.

### 14.3 Critical cross-module lifecycle specification

The flagship request resolves authorized workspace, period (including fiscal calendar and complete/partial status), intended metric definitions and currency, template, language and audience. If missing/ambiguous, clarify. Input file is immutable; parse to staging with reject counts, profile, create ordered transformation proposal, preview/approve ambiguous changes, execute, reconcile and certify dataset. Metric engine uses approved versioned formulas/aggregation and appropriate grain; outputs include exact result and units/context. Insert into supported editable artifacts using source references. Staged generated documents and decks can be edited but certified values cannot silently be changed; numerical editing requires detach or new approved result. Use independent copy, refreshable link or pinned snapshot, with one-way synchronization initially. New source version offers explicit refresh proposal of drafts only; incompatibility, stale source or missing permission blocks required refresh/publication. Pin exact artifact revisions, dataset and metric versions, transformation versions, filter/units, checksums and evidence in reporting manifest; recheck authorization and approval digest before transactionally making package visible. Failed generation leaves last approved package and eligible drafts, not partial publication. A historical snapshot is intentionally pinned, not stale simply because newer data exists. Distribution/export is a separate disclosure action; downloaded external copies cannot reliably be revoked. Re-evaluate viewing/access policy for in-platform historical content. No background automatic refresh, recurrence or sharing until explicitly approved.

## 15. Priority conflicts and resolution register (proposed)

| Issue | Resolution proposed for consolidated baseline | Owner decision / impact |
| :--- | :--- | :--- |
| RSL-01 Master says English PTT only; later founder asked English and Khmer | Update VOC-01 and linked AI/voice/localization scope to both; preserve ID. EN/KM commands and output support are P0; Khmer real performance target must be verified. | Record already established language direction; do not silently waive release target. |
| RSL-02 Budget analysis P0 vs WF-06 P1 | Basic budget/actual metric comparison for monthly report P0; advanced budget planning, amendment/what-if workflow P1. | Approve fixture and accounting definition. |
| RSL-03 Forecasting ANA-04 P1 vs WF-13 P2 | P1 bounded scenarios/statistical forecast components; full dedicated forecasting workflow P2. Forecast not part of certified historical results. | Confirm separate feature plan. |
| RSL-04 P0 linked drafts vs scheduled refresh P1 | Manual authorized refresh and last-good/failed freshness P0; schedule/alerts and visual builder P1. | No always-on agent in MVP. |
| RSL-05 Editable charts and rich file support vs format limits | Native supported chart types/objects P0; exact supported profile to be frozen after reference tests. Complex charts/pivots/animations and unsupported structures later; detect and warn, preserve source. | Do not advertise universal Office compatibility. |
| RSL-06 Voice interaction scope | PTT dictation, command, selected-object and bounded workflow P0; TTS/realtime/barge-in/mixed within-utterance P1; always-listening/voice cloning excluded. Early mixed-speech research only. | Live Khmer STT remains mandatory target. |
| RSL-07 P0 prototype vs product | P0 is release requirement, not immediate sprint. S1 document-first then governed financial S2/S3. | Approve each next gate separately. |
| RSL-08 Platform admin vs shared core | D2/PA foundation owns identity/authorization/storage; FR-09/10 reuse it; INT owns orchestration/publication on shared jobs. | No duplicate service/contract. |
| RSL-09 Subscription vs actual payments | PLT-06 internal plan catalog, entitlements, seats, reservations, usage and clear quota behavior P0. Live payments adapter/webhooks commercial P1/launch business gate; commercial launch needs chosen payment/contract process. | Vendor/merchant availability and terms must be checked later, no charges now. |
| RSL-10 Recovery and availability targets | Distinguish normal durable save from catastrophic RPO/RTO; internal SLO vs contractual SLA; targets proposed in Part A and finalized after measurements. | Approve affordable pilot/GA objectives. |
| RSL-11 Parent IDs vs refined catalogs | Maintain 51 original parents, 46 P0/5 P1; P1 subrequirements under some P0 parents (e.g., BI alerts, redundancy, federation) are explicit expansion rather than elevating entire parent. Map WS/D02/DOC and shared AI/voice aliases. | Coder returns full leaf-level alias/delta register. |
| RSL-12 Linked copy vs authoritative data | One-way refresh for draft linked results; display formatting distinct from data, detach explicitly for independent edits; pinned publication immutable. | Preserve certified integrity. |
| RSL-13 Advanced model capabilities | Application-owned contracts with candidate providers, no fixed model/vendor until feasibility and privacy/license approval. P1 connectors/multi-step extensions remain restricted. | No unrestricted agents or external execution. |
| RSL-14 Security/quality assurance wording | Testable approved supported scope, no universal guarantees from mock/scanner/benchmark. Failure of hard blocker cannot be waived by composite score. | Evidence-based release only. |

## 16. Master Requirements Traceability Matrix (51 grouped parent entries)

This table preserves the original 51 IDs and original 46 P0/5 P1 priorities. The requirement descriptions are consolidated paraphrases of the baseline with approved-in-direction bilingual correction and clearly proposed detail. Representative acceptance links are named tests from the earlier reports and Part A, not full leaf-level coverage. P1 acceptance criteria are planned, not release requirements for P0; see section 17. Test ranges below use prefix compression (e.g., SHT-T01–T05 means SHT-T01 through SHT-T05). Implementation status for every row: unverified in this research; test status NOT RUN here. The coder must add actual code paths, commit, test evidence, applicability and reviewer per leaf requirement. Shared evidence may satisfy multiple parents if the actual assertions cover them.

| Parent ID | Priority | Consolidated requirement / release scope | Owner / main dependency | Representative verification IDs |
| :--- | :--- | :--- | :--- | :--- |
| DOC-01 | P0 | Create/edit/save rich-text documents, headings/lists/tables/images, EN/KM, persistent editable structure. | Document / PLT-02 | DOC-T02, DOC-T05, NFR-T21, E2E-06 |
| DOC-02 | P0 | Reusable styles, pages, headers/footers, corporate templates and branding. | Document / PLT-03 | DOC-T01, DOC-T05, DOC-T06, NFR-T33 |
| DOC-03 | P0 | Linked metrics/tables/charts with source, version and freshness; no invented values. | Document / ANA, INT | DOC-T12, INT-T01, INT-T02, NFR-T28 |
| DOC-04 | P0 | Review comments/revisions; supported editable DOCX import/export and PDF output. | Document / PLT-02, PLT-04 | DOC-T05, DOC-T06, DOC-T09, NFR-T10, NFR-T33, NFR-T36 |
| DOC-05 | P1 | Advanced track changes, mail merge and content controls; explicit fidelity scope. | Document / DOC-01–04 | RC-P1-01 |
| SHT-01 | P0 | XLSX/CSV, sheets, range edits, sort/filter and structured records. | Spreadsheet / PLT-04 | SHT-T01, SHT-T08, SHT-T13 |
| SHT-02 | P0 | Documented core arithmetic, logic, aggregation, conditional and lookup formulas. | Spreadsheet / formula engine | SHT-T02, SHT-T03, SHT-T18, NFR-T34 |
| SHT-03 | P0 | Recalculate dependencies; invalid/cyclic/unsupported formulas explicit; no fabricated zero. | Spreadsheet / formula engine | SHT-T02, SHT-T04, SHT-T14 |
| SHT-04 | P0 | Preserve IDs, dates, text, precision and currency intent. | Spreadsheet / locale & precision | SHT-T05, SHT-T13, DAT-T03, NFR-T27 |
| SHT-05 | P0 | Supported XLSX and CSV export, warning/restriction for unsupported features; original safe. | Spreadsheet / PLT-04 | SHT-T13, SHT-T14, SHT-T17, E2E-06 |
| SHT-06 | P1 | Advanced pivots, what-if, extended formula library. | Spreadsheet / SHT-02, ANA | RC-P1-02 |
| DAT-01 | P0 | Immutable source, mapping and import diagnostics. | Data Prep / PLT-03–04 | DAT-T01, DAT-T02, DAT-T13 |
| DAT-02 | P0 | Profile types/nulls/validity/duplicates/distributions, show sample scope. | Data Prep | DAT-T03–T05, DAT-T13; profile fixture RC-T01 |
| DAT-03 | P0 | Preview/approve trim, conversion, null/duplicate/filter/replace operations. | Data Prep / PLT-02 | DAT-T03–T05, DAT-T08, DAT-T11 |
| DAT-04 | P0 | Append/join by explicit keys and cardinality, unmatched and multiplication review. | Data Prep | DAT-T01, DAT-T06, DAT-T07 |
| DAT-05 | P0 | Ordered versioned recipes, deterministic semantic rerun and schema drift. | Data Prep / jobs | DAT-T09, DAT-T10, DAT-T15, DAT-T17 |
| DAT-06 | P0 | Reconcile record counts/totals and exceptions before certification. | Data Prep / ANA | DAT-T04–T07, DAT-T13–T14, DAT-T18 |
| ANA-01 | P0 | Named versioned metrics, aggregation, period, units, filters, precision and source. | Business Analysis / DAT | ANA-T01, ANA-T02, ANA-T06, ANA-T08–T11 |
| ANA-02 | P0 | Group summaries, comparisons, basic descriptive statistics, appropriate aggregation. | Business Analysis / ANA-01 | ANA-T02–T07, ANA-T09, RC-T02 |
| ANA-03 | P0 | Provenance, validated results and separation of measured fact vs generated interpretation. | Business Analysis / AI, INT | ANA-T10–T11, ANA-T16, ANA-T18, NFR-T27–T28 |
| ANA-04 | P1 | Advanced relationships, governed connectors, extended semantics, scenario/forecast/statistics. | Business Analysis / DAT, BI | RC-P1-03 |
| PPT-01 | P0 | Editable slides: text, shapes, images, tables and supported charts. | Presentation / ANA, INT | PPT-T01–T03, PPT-T05, PPT-T07–T09 |
| PPT-02 | P0 | Layout templates, corporate theme and speaker notes. | Presentation / shared theme | PPT-T04, PPT-T13, PPT-T19, RC-T03 |
| PPT-03 | P0 | Supported PPTX import/export, PDF and presentation mode. | Presentation / PLT-04 | PPT-T05–T06, PPT-T10, NFR-T35–T36, RC-T04 |
| BI-01 | P0 | Editable dashboards/reports with KPI, table, bar/line and supported filters. | Intelligence / ANA, INT | BI-T01–T06, BI-T08–T12 |
| BI-02 | P0 | Labels, dates, units, scoped filter context and authorized drill-to-detail. | Intelligence / ANA, PLT | BI-T03–T04, BI-T07, BI-T12–T13, BI-T17 |
| BI-03 | P0 | Access-controlled snapshots, refresh state, last-good/stale/error behavior. | Intelligence / INT, PLT | BI-T19–T25, BI-T23, INT-T07 |
| INT-01 | P0 | Shared dataset/metric versions and identical result contexts across all studios. | Integration / DAT, ANA | INT-T01–T04, INT-T12, X-VIS-01, E2E-01 |
| INT-02 | P0 | Explicit authorized draft refresh; preserve published snapshots and exact-revision approval. | Integration / PLT-02, jobs | INT-T05–T08, INT-T16–T17, INT-T23, E2E-02 |
| INT-03 | P0 | Detect missing links, stale data, incompatibility and failures; block invalid publication. | Integration / DAT, PLT | INT-T09–T11, INT-T13–T15, INT-T19–T22, INT-T24, E2E-05 |
| INT-04 | P1 | Scheduled refresh, richer interactions and approved advanced automation. | Integration / jobs, BI, AI | BI-T33–T34, RC-P1-04 |
| AI-01 | P0 | Text assistant scoped to selected object/artifact or authorized workspace; EN/KM retrieval/context. | AI Core / PLT | AI-T01–T02, AI-T05–T09, AI-T25, NFR-T29–T30 |
| AI-02 | P0 | Editable content/formula/chart proposals, preview/accept/reject and undo. | AI Core / studio handlers | AI-T01–T04, AI-T11, SHT-T12, PPT-T15, RC-T05 |
| AI-03 | P0 | Constrained calculation and verified source-grounded explanation, no invented certified values. | AI Core / ANA, SHT | AI-T03–T05, AI-T15, NFR-T27–T28 |
| AI-04 | P0 | Inspectable plan with bounded tools, inputs, risk/approval and workflow state. | AI Core / INT, PLT | AI-T12–T14, AI-T19, AI-T27, INT-T12, VOC-T25 |
| AI-05 | P0 | Per-call auth, schema/semantic checks, isolate untrusted content, privacy-aware routing. | AI Core + platform security | AI-T09–T14, AI-T17, GOV-T03–T05, E2E-03 |
| AI-06 | P0 | Material actor/action/approval/source/output/failure audit without secret leakage; model/version evidence. | AI Core + platform audit | AI-T23–T25, VOC-T29, PLT-T34 |
| AI-07 | P0 | Provider-independent bounded execution, permitted fallback, quota, cancel and idempotent recovery. | AI Core / PLT-05–06 | AI-T16–T22, AI-T28, GOV-T06, E2E-05 |
| VOC-01 | P0 | English and Khmer PTT, explicit microphone consent, visible state, editable final transcript and typed fallback. | Voice / AI | VOC-T01–T06, VOC-T08, VOC-T15–T18, VOC-T27–T28, NFR-T31 |
| VOC-02 | P0 | Confirm material fields and apply same policy/tool path as typed; no partial/dictation execution. | Voice / AI, INT, PLT | VOC-T07–T14, VOC-T20–T25, GOV-T01, E2E-04 |
| VOC-03 | P1 | Real-time two-way conversation, TTS and interruption/privacy controls; mixed speech evaluation. | Voice / VOC-01–02, AI | RC-P1-05 |
| PLT-01 | P0 | Tenant/workspace accounts, membership/roles and server enforcement for all access paths. | D2/Platform | PLT-T01–T14, NFR-T03–T04, E2E-03 |
| PLT-02 | P0 | Version history, review, exact approval, draft/published states and restore. | Platform / INT | PLT-T15–T18, INT-T17, INT-T23, NFR-T10 |
| PLT-03 | P0 | Source and output management, access/export, retention/deletion and audit. | Platform / storage | PLT-T19–T21, PLT-T34–T35, VOC-T26 |
| PLT-04 | P0 | Safe upload and bounded parse, detect types/limits, no macro execution. | Platform / worker | PLT-T22–T26, NFR-T05, E2E-06 |
| PLT-05 | P0 | Durable long jobs, truthful progress/error, cancel/retry/recovery. | Platform / INT | PLT-T27–T29, PLT-T36, NFR-T11–T12, E2E-05 |
| PLT-06 | P0 | Entitlements, usage visibility, seats/quotas, reservations; no unauthorized billing/data loss. | Platform / AI usage | PLT-T30–T33, NFR-T32, GOV-T06 |
| NFR-01 | P0 | Encrypt, isolate, enforce authorization and security/privacy controls. | Quality / Security & PLT | NFR-T01–T09, E2E-03 |
| NFR-02 | P0 | Reliability, backup/restore, observability and incident process. | Quality / Operations | NFR-T10–T17, NFR-T39, PLT-T35, E2E-05 |
| NFR-03 | P0 | Accessible keyboard/text/voice alternatives, English/Khmer quality and WCAG AA target. | Quality / UX | NFR-T18–T22, BI-T31, VOC-T28 |
| NFR-04 | P0 | Performance/capacity/cost, verified calculations and interoperability, reproducible engineering. | Quality / all modules | NFR-T23–T38, NFR-T40, E2E-01, E2E-06 |

Notes: the parent count is stable; the added RC-T tests below close specific representative coverage gaps without replacing existing suites. Some parent-level links are indirect, and some tests cover only part of a requirement; for example, NFR-T33 plus specific DOCX fixtures cover pagination and headers, while review workflows require platform revision tests and an actual editor integration. Coder must refine every applicable leaf into explicit assertions and show coverage; a linked ID is not proof that all its acceptance conditions are tested.

## 17. Integrated acceptance, additional targeted and P1 tests

### 17.1 Preserve original system-level tests (E2E-01–E2E-06)

| ID | Scenario and explicit expected result |
| :--- | :--- |
| E2E-01 | Import representative sales, expense and budget files, prepare/validate and calculate, generate linked management document, presentation and dashboard plus workbook summary. Match independently expected counts and amounts, metric/source versions, filters, units, currency, period, output editability and approval. |
| E2E-02 | Change source for new month, rerun approved recipe; detect schema drift, block incompatible updates, create new approved draft/package. Prior published artifacts remain exact historical versions. |
| E2E-03 | Attempt cross-tenant access via API/storage/cache/search/job, prompt injection, unauthorized export and agent privilege escalation. Deny, no unauthorized disclosure/effects, safe audit. |
| E2E-04 | Spoken instruction with ambiguous amount/target; confirm/correct transcript and exact parameters; EN and KM spoken results match equivalent typed operations under same policy. Live speech separately required. |
| E2E-05 | Interrupt multi-step job; simulate provider failure, retry/cancel/recover and restore previous draft. No duplicate material effect or partial publication; last good retained; audit accurate. |
| E2E-06 | Round-trip representative DOCX/XLSX/PPTX in authorized reference applications; preserve supported editable structure, values/layout, bilingual text and original bytes; explicit unsupported-feature diagnostics. PDF and CSV included in relevant NFR tests. |

### 17.2 Targeted new consolidation fixtures (RC-T IDs)

| ID | Gap addressed | Test and required outcome |
| :--- | :--- | :--- |
| RC-T01 | Profile correctness / DAT-02 | Synthetic dataset with fixed row count, known null/blank/invalid, duplicated composite keys, distributions and outliers; exact full-profile counts, sample label when sampled, no automatic destructive correction. |
| RC-T02 | Basic statistics / ANA-02 | Fixture [1, 2, 3, 4, 5] plus missing and grouped values. Under declared missing policy mean/median=3, sample SD=sqrt(2.5), min=1 max=5, count=5; define percentile method; compare within approved numerical tolerance; do not treat missing as zero. |
| RC-T03 | Speaker notes / templates / PPT-02 | Create themed deck with approved fonts/layout and notes, save/reopen/export supported PPTX; notes preserved when permitted and stripped/denied for restricted export. |
| RC-T04 | Presentation delivery / PPT-03 | Start full-screen supported deck, keyboard previous/next/exit, verify correct slide order, no corruption and accessible controls. |
| RC-T05 | Proposal rejection / AI-02 | Generate scoped edit and inspect diff; reject without state change; approve another valid proposal then undo/restore, verify unrelated content and approved snapshots unchanged. |
| RC-T06 | User journey/retention / PLT-03 | Remove membership, revoke access/search/cache, process authorized deletion with dependency/hold rules, verify tombstones and backup expiry; demonstrate no false external-file recall promise. |
| RC-T07 | Baseline traceability / FR-13 | Parse canonical register; exactly 51 preserved parents, 46 P0/5 P1, each linked to source and planned acceptance; no duplicate/orphan IDs; reconcile aliases and P0/P1 child scope. Actual implementation/evidence fields remain separate. |
| RC-T08 | Release evidence | Try to approve package/release with missing mandatory fixture, failed auth or stale approval. Block affected release/publication; mock-only does not pass real environment requirement. |

These are proposed additions, not previously executed tests. RC-T07 is a documentation consistency check; it must not be misreported as an application quality pass.

### 17.3 P1 expansion acceptance plans (do not execute production work now)

| ID | Parent | Planned acceptance criterion |
| :--- | :--- | :--- |
| RC-P1-01 | DOC-05 | Approved tracked changes/comment interchange, merge field/data binding and content-control profile; reference DOCX round-trip, revision/permission safety, no silent loss. |
| RC-P1-02 | SHT-06 | Supported pivot/what-if/extended formula fixtures, varied inputs, no aggregation drift, preserve original assumptions and interoperability profile. |
| RC-P1-03 | ANA-04 | Advanced relationship/grain tests, authorized connector, scenario isolation; forecast with time-ordered held-out evaluation, naive benchmark, error and uncertainty, insufficient-history behavior. |
| RC-P1-04 | INT-04 | Approved recurring refresh with scope, schedule, stale/failure state and deduplicated events, no automatic publication, revocation/cancellation and authorized recipients. |
| RC-P1-05 | VOC-03 | Real EN/KM conversational speech, native intelligibility and mixed-utterance tests; barge-in, separate playback vs business-operation cancellation, no partial-event mutation, privacy and session budget. |

P1 subrequirements of P0 parents (real-time coediting, federation, alerting, richer formats, connector/billing, advanced model workflows, enhanced redundancy) retain their original detailed IDs and require feature-specific tests before their own release. Do not use only a parent P0 test to assert an unimplemented P1 feature. The planned P1 criteria above cover the five original P1 parents, not all future child refinements.

### 17.4 Evidence record template (copy into actual test register)

```yaml
requirement_id: NFR-02.05
test_id: NFR-T14
source: FR-12 / Main Research Report V1.4
release_scope: pilot
fixture_version: TBD
expected: approved complete-service RPO/RTO plus integrity and permission checks
actual: null
status: NOT_RUN
environment: TBD
commit: TBD
command_or_procedure: TBD
evidence_uri: null
measured_at: null
blocker_or_defect: null
reviewer: null
approval: pending
```

Never fill actual values with targets. Retain logs, sanitized command output, fixture checksum, exported documents/render screenshots, benchmark samples, negative test assertion evidence, actual selected provider/model/config and recovery times. Map automated test file and test name to stable test ID. If source code or external prerequisite missing, BLOCKED with exact cause and next action. Never expose credentials or sensitive customer data in reports.

## 18. Technical decision register and Stage 4 evidence needs

Distinguish adopted product direction, proposed engineering candidate and owner-approved implementation. An ADR candidate is not permission to install, buy or deploy.

| Decision ID | Direction / candidate | Required Stage 4 evidence and approval |
| :--- | :--- | :--- |
| ADR-001 (retained) | One workspace, specialized engines, modular monolith plus isolated workers | Verify module interfaces and actual workload/isolation; revise only if demonstrated constraints. |
| TD-DOC-01 (retained) | Tiptap/ProseMirror existing prototype baseline; compare suitable integrated office editor; evaluate pagination/export separately | Actual rich editable structure, A4/Letter layouts, headers/footer, Khmer shaping, Word/PDF round trip, API/selection control, commercial terms. |
| TD-SHT-01 (retained) | Compare Univer, Handsontable/HyperFormula, integrated office engine and existing limited evaluator | Core supported functions and error semantics, dependency recalc, XLSX profiles, licensing obligations/cost, accessibility and realistic memory/latency. |
| TD-VOICE-01 (retained) | Local Faster-Whisper first; approved Azure/Google and other speech alternatives later | Actual hardware, model-weight license, exact locale/region/model/mode/status, consented EN/KM accuracy, critical fields, latency, data retention and cost. |
| TD-PLAT-01 (retained) | PostgreSQL candidate for production metadata; private versioned object storage; local SQLite only if bounded existing prototype | Real role/policy/tenant-isolation, concurrent quota, backup/recovery, migrations and operations; no live migration. |
| TD-GIT-01 (retained) | Reproducible local Git baseline and reviewed changes | Actual repo, branch/commit/status, passing baseline, excluded secrets and artifacts; remote push separately approved. |
| RC-DEC-01 | Shared data engine: DuckDB feasibility candidate vs Polars or appropriate alternatives | Same import/profile/join/recipe/reconcile fixtures; decimal division/overflow/rounding policy, isolation, cost, resource use, versioned output. |
| RC-DEC-02 | Business metric registry owned by app; no independent AI numerical authority | Golden values, multi-grain model and filter semantics, immutable results and lineage. |
| RC-DEC-03 | Presentation editor compare app-owned DOM/SVG/hybrid + PptxGenJS export vs Univer/ONLYOFFICE | Native objects, authoring/import/export separation, native Khmer, PPTX/PDF fidelity and commercial rights. |
| RC-DEC-04 | BI app-owned ChartSpec with ECharts/Vega-Lite candidates; evaluate embedded BI only if need demonstrated | Permission-aware queries, correct filters/drill, chart export mappings, accessibility, license and performance. |
| RC-DEC-05 | Application-owned AI/voice interfaces, direct adapters vs Vercel AI SDK candidate; cascaded PTT first | Structured proposals, state-based tests, provider policy/fallback, real language results, budget and privacy; managed gateway optional. |
| RC-DEC-06 | Shared identity, artifact storage, jobs, audit, entitlements; OIDC-compatible identity candidate | Two-tenant actual DB/object tests, revocation, session, approval, idempotent jobs and usage reservation. |
| RC-DEC-07 | Stage publication blobs then transactionally commit manifest and pointers | Fault injection, crash/retry, orphan cleanup, exact approval digest, historical retrieval and restore. |
| RC-DEC-08 | Pin supported Office/function/browser profiles and NFR envelope | Reference files, native review, performance/restore evidence, qualified test environment and limits. |
| RC-DEC-09 | Provider, commercial licensing, data-location/retention and legal obligations | Actual vendor terms/quotes, regional availability, customer policy and qualified review; no blanket compliance claims. |

Candidate scorecard: mandatory gates first (lawful commercial license, applicable security/privacy, core supported features, editability/accuracy and recoverability); reject or block candidates with unresolved mandatory failures rather than averaging them away. For surviving candidates compare integration effort, API control, compatibility, EN/KM, performance, maintainability/portability, operational cost and total cost of ownership. Suggested relative weights for discussion only: fidelity/correctness 25%, integration/customization 20%, operational simplicity/maintainability 15%, resource performance 15%, EN/KM/accessibility 15%, cost 10%. Use identical fixtures and clearly mark unavailable metrics; do not invent a winner or assign scores without evidence. Record rejected options, fallback and decision revisit triggers. License/security hard gates remain outside weighted scoring.

## 19. Consolidated risk register

All severities are preliminary impact judgments, not measured incident probabilities. Assess likelihood, residual risk and evidence owner during Stage 4/6; hard blockers cannot be accepted by a coding agent.

| Risk ID | Risk / impact | Initial severity | Mitigation / evidence owner and next gate |
| :--- | :--- | :--- | :--- |
| RISK-01 | Scope expansion across four studios delays a usable product | High | Product/founder: S1→S2→S3, fixed P0 profile; change control; RC-00. |
| RISK-02 | Khmer speech/intent recognition insufficient in real offices | High | Speech/AI + native reviewers: early held-out local/provider evaluation, critical confirmation, typed alternative; VI-00. |
| RISK-03 | Khmer shaping/layout and exported glyphs differ by renderer | High | Editor/QA: common bilingual fixture, fonts/licensing, Office reference rendering; D1/PS-00. |
| RISK-04 | Office round-trip or advanced structures lose content | High | Editor QA: supported-feature profile, immutable original, diagnostics and reference apps; G1/Stage 4. |
| RISK-05 | Incorrect financial aggregation, precision, period or FX | Critical | Data/analytics: independent golden values, grain checks, explicit money policy; DP-00/AN-00. |
| RISK-06 | Cross-tenant leakage via search/cache/jobs/blobs | Critical | Platform/security: object authorization, scoped keys and actual DB role, negative tests; PA-00/D2. |
| RISK-07 | AI prompt injection, excessive agency, unauthorized export | Critical | AI/security: narrow tools, untrusted content handling, per-step reauthorization, disclosure verification; AIC-00/Stage 6. |
| RISK-08 | Speech privacy or unapproved cloud fallback | High | Voice/privacy: PTT, retention, policy gate before audio transfer and native feedback; VI-00. |
| RISK-09 | Duplicate mutation or inconsistent publication after failure | High | Integration/platform: durable IDs, revision guard, staged manifest, fault injection; XI-00/D2. |
| RISK-10 | Data loss or inaccessible encryption keys | Critical | Operations: coordinated backup, isolated restore and revocation checks; QE-08. |
| RISK-11 | Resource exhaustion/noisy neighbor or unstable large files | High | Platform/QA: quotas, worker isolation, representative load tests; QE-06. |
| RISK-12 | Unprofitable AI/speech/provider costs or concurrency races | High | Commercial/platform: actual cost per approved task, atomic budget reservations, vendor quotes; Stage 4/10. |
| RISK-13 | Incompatible licensing or provider contractual restrictions | High | Technical/product/legal: exact edition/versions/weights and terms, written commercial review; G1. |
| RISK-14 | Model behavior regressions and provider availability | High | AI QA: version registry, held-out regression, approved fallback and disable strategy; AIC-00/QE-10. |
| RISK-15 | Inaccessible grid, slide or voice controls | High | UX/QA: WCAG criteria matrix and manual assistive tech, alternative interactions; QE-09. |
| RISK-16 | Unverified code/status or duplicated feasibility systems | High | Engineering: G0 baseline, canonical contracts, map accepted changes; RC-00. |
| RISK-17 | Security vulnerability or compromised dependency | Critical | Security: SBOM, license and security triage, version pinning, safe update review; QE-02/Stage 6. |
| RISK-18 | Prototype success mistaken for market validation | High | Product: SME interviews/pilot time, approved completion, repeat use and willingness to pay; Stage 10. |
| RISK-19 | Unsupported SLA/RPO/RTO or insufficient operating support | High | Operations/founder: measured targets, staffing, recovery and explicit scope; QE-08/12. |
| RISK-20 | Ambiguous requirements, aliases or orphan tests | High | Technical PM: 51-parent RTM, leaf/source/test mapping, formal change review; RC-00/QE-01. |

## 20. Unified engineering roadmap and authorization gates

Do not treat every named phase as a new team or independently developed subsystem. The earlier D0–D9 plan and module phases remain valid labels. Order by dependency and evidence, not by numerical phase name alone. Integrate quality from start.

| Gate / sequence | Work and prerequisites | Exit evidence / authority |
| :--- | :--- | :--- |
| G0 / D0 / RC-00 / QE-00 | Read-only inspect repo, docs, Git, existing mocks/real features, build/tests/locks/approved changes. Reconcile master and handovers; preserve dirty files. | Reproducible baseline, actual status and conflicts, current authorization register. Request local investigation permission if not established. |
| G1 / D1 | Close already authorized document editor/pagination, supported export and speech feasibility; local synthetic comparison. | Evidence and candidate decision; no license purchase or live provider activation. |
| Stage 4 bounded feasibility | Sequence SS-00, DP-00, AN-00, PS-00, BI-00, XI-00, PA-00, AIC-00, VI-00, QE activities based on missing evidence and existing work. PA/AIC/VI reuse contracts; avoid redundant prototypes. | Comparable fixtures, test logs, risks, actual costs/license status, proof of candidate capabilities and constraints. Explicit approval for each expansion. |
| G2 / D2 / PA-01–03 | Only after approved foundation architecture; identity/session, tenant/permissions, artifact storage/version, actual DB migration plan. | Real negative authorization and data isolation, durable state, tested migration/rollback. Separate authorization before production. |
| D3–D6 / S1 | Real document editing, AI operation pipeline, speech PTT, templates; D2/PA, AIC/VI dependencies. | Document-first vertical slice: actual EN/KM text, confirmed scoped operation, save/reopen, supported DOCX/PDF, audit/undo; real speech measured or clearly pending for limited prototype. |
| S2 / SS + DP + AN production phases | Approved core workbook and formula adapter, ingestion/staging/recipes, certified metric registry; reuse shared data and jobs. | Independent financial fixture, exact policy, rejects and lineage; safe XLSX/CSV and linked document. |
| S3 / PS + BI + XI + AIC/VI integration | Approved native slide objects and dashboard builder, filtered results, manifest publication, controlled reporting plan. | Full E2E-01–06, X-VIS/GOV/INT integration and actual supported outputs. |
| D7–D9 / PA/QE hardening and private alpha | Shared metrics, security and quality across actual integrations, support/restore, pilot readiness. | Approved scoped alpha, no critical blockers, explicit limitations and actual acceptance. |
| Private pilot → RC → GA | Customer validation, actual live EN/KM and interoperability, SLO/capacity/cost/restore and legal/commercial/support gates. | Founder approves release, not coder self-certification. P1/P2 separately prioritized. |

Suggested work-in-progress limit: finish one vertical slice and its evidence gate before opening more implementation tracks. Read-only/documented feasibility comparison may run alongside existing approved work; do not create production branches or concurrent experimental systems that cannot be maintained. This is a dependency plan, not a schedule or cost estimate; derive estimates from actual baseline and Stage 4 measurements.

## 21. Stage 3 exit assessment

| Original exit criterion | Current research status | Required action before formal baseline approval |
| :--- | :--- | :--- |
| Detailed P0 catalogue and explicit exclusions | Drafted across FR-01–12; parent register and exclusions consolidated | Founder review and sign-off, reconcile detailed child scope and conflicts. |
| User journeys and roles | Proposed in section 13 and prior research | Validate with representative SME stakeholders; finalize role/action matrix. |
| File and formula compatibility matrix | Candidate profile and prior detailed matrices | Freeze exact supported features/functions, versions, tolerances and licensing after feasibility; no full parity claim. |
| Sample datasets, edge cases and measurable envelope | Synthetic golden fixtures and candidate workload/latency/SLO/RPO/RTO targets | Establish independently verified fixtures, actual hardware/network and approved measured envelope. |
| Every P0 mapped to acceptance | 51-parent RTM (46 P0) and 40 NFR leaf-to-test links drafted | Reconcile all detailed aliases/leaf test coverage and actual implementation evidence; P1 expansion tests separate. |
| Open dependencies captured for Stage 4 | Decision/risk/feasibility register drafted | Approve feasibility scope, budget, test access and owner decisions. |

Stage 3 conclusion: 13/13 research workstreams drafted (100% of this research milestone list). Formal requirements baseline approval remains pending. The project is ready to plan and, when authorized, conduct Stage 4 technical feasibility; it is not ready for production implementation sign-off or public launch based on research alone. The exact MVP supported-format/function envelope, complete leaf-level traceability, actual repository status, live EN/KM evidence, commercial license terms and measured NFR thresholds remain outstanding. This conditional exit respects the original requirement that feasibility evidence informs final scope and acceptance.

---

# PART C — Stage 4 technical feasibility entry plan

## 22. Next research stage: evidence-driven technology selection

Stage 4 evaluates whether candidate technologies can actually deliver the approved-in-direction requirements. It is not authorization to build the full suite. Stage 5 architecture uses selected evidence; Stage 6 security architecture details the trust boundaries and threat model; Stage 7 UX/UI; Stage 8 development roadmap; Stage 9 software engineering; Stage 10 commercial readiness. Existing authorized early development may continue independently within its gate, but requirements and experiments must remain traceable.

| Proposed Stage 4 investigation ID | Topic | Output / common acceptance |
| :--- | :--- | :--- |
| TF-01 | Repository and technical feasibility baseline | Verify G0/RC-00/QE-00, actual stack, constraints, approvals, candidate evaluation protocol. |
| TF-02 | Document editing, pagination and conversion | Compare candidate editor/API/render/export with bilingual fixtures and licensing. |
| TF-03 | Spreadsheet editor, formula engine and interoperability | Core function/error/dependency/format matrix, native edit and export, performance/license. |
| TF-04 | Data preparation and analytical precision | DuckDB/Polars or justified alternatives, exact monetary policy, joins/rejects/lineage, 10k/100k/1m workloads. |
| TF-05 | Presentation authoring and export | App-owned or integrated editor, native objects, chart binding, Khmer, PPTX/PDF reference evidence. |
| TF-06 | Business intelligence and visualization | Shared ChartSpec, authorized filter/drill results, refresh/snapshot and render/performance. |
| TF-07 | Shared platform, identity, storage and jobs | Real two-tenant sandbox, DB/RLS if selected, file isolation, quota, manifests, backup/restore. |
| TF-08 | AI model adapters and agent execution | Structured outputs, policy, verification, retrieval, failover, bounded budgets and bilingual task evaluation. |
| TF-09 | Voice EN/KM, STT/TTS and local/cloud evaluation | Real consented speech, exact field/intent/task metrics, provider mode and retention, latency/cost; PTT first. |
| TF-10 | Integrated cross-module feasibility | Golden data, typed/voice-to-action, immutable publication, failure/recovery and reference exports. |
| TF-11 | NFR and operational economics | Reproducible load, security/accessibility and recovery protocol, measured resource and cost, documented limitations. |
| TF-12 | Technical decision consolidation | Evidence-based ADRs, supported profiles, rejected alternatives, residual risk and Stage 5 architecture entry review. |

TF identifiers are proposed research planning labels, not replacements for D1, SS-00, DP-00, AN-00, PS-00, BI-00, XI-00, PA-00, AIC-00, VI-00 and QE-00. Start with TF-01 and use actual existing work to reduce repeated experimentation. In each investigation, compare current implementation and feasible alternatives, state hypothesis and mandatory criteria, identify licenses and data policy, use common synthetic fixtures, record actual measurements and negative tests, explain gaps, and propose decision with revisit triggers. If dependency or vendor trial needs permission/payment, stop and request specific approval. No installation/deployment implied.

## 23. Immediate coder work package (proposed RC-00 + QE-00)

1. Read this complete report and prior named handovers; inspect existing project documents and actual code only within approved access. List baseline commit/status, lockfiles, current editor/formula/data/AI/speech/auth/job/storage/usage contracts, current mocks and live features, and tests. Preserve existing source and dirty changes. If no access, report blocked.
2. Reconcile 51 original parent IDs and 13 research workstreams; merge existing child requirements without duplicate IDs. Map WS and D02/DOC aliases, module-specific AI and voice requirements to shared parents, shared INT/PLT jobs/revisions/audit, and NFR control links. Preserve original source and historical status. Identify all unresolved scope or priority conflicts rather than silently replacing decisions. Return actual leaf-level RTM with code/test/evidence fields (NOT RUN if not proven).
3. Build the verification plan around prior module fixtures, E2E-01–06, X-VIS-01–08, GOV-T01–08, NFR-T01–40, RC-T01–08 and planned P1 cases. Reuse tests if assertions cover requirements. Independently specify expected numbers and state; no self-validating test oracle. Mark tests blocked by unavailable engines, licensed Office apps, real infrastructure, native reviews or live providers. Report exact actual commands/results and any regression.
4. Define benchmark fixtures/environments, exact supported-format/function profiles and policy requirements. Check existing feasibility reports before doing more work. Propose TF-01–12 order and concrete bounded experiments. Evaluate proposed targets in Part A; do not claim capacity, availability, security, fidelity, real speech or SLA without real evidence.
5. Update or propose documentation delta only as authorized. Report current defects, high-risk gaps, license/vendor restrictions, dependencies and recommended next limited work. Do not rewrite all architecture, create parallel auth/AI/voice/billing/audit systems, purchase services or begin D2+ without separate decision.
6. Stop at the review gate with a concise evidence-backed engineering response: baseline, approved vs proposed, changes made (if authorized), requirement/test coverage and status, actual tests and artifacts, untested assumptions, blockers, risk and recommended next action, rollback and explicit approval requests.

### 23.1 Required documentation deliverables

Use existing files/sections rather than create redundant documentation. Preserve original approved evidence. Suggested authoritative locations:

| Document | Content / owner |
| :--- | :--- |
| PROJECT_CONTEXT.md | Product vision, scope, stage, decisions and approved exclusions. |
| PRODUCT_REQUIREMENTS_SPECIFICATION.md | Consolidated business goals/personas/journeys and approved P0/P1 boundaries (section 13). |
| SOFTWARE_REQUIREMENTS_SPECIFICATION.md | Canonical functional/NFR contracts, failure semantics, supported scope. |
| REQUIREMENTS_REGISTER.md / REQUIREMENTS_TRACEABILITY_MATRIX.md | Stable parent/leaf IDs, source, dependency, test, code/evidence links, status, reviewer; maintain one canonical dataset with derived views. |
| MVP_SCOPE_AND_EXCLUSIONS.md | S0–S3 versus release scope; deferred P1/P2 and change procedure. |
| NON_FUNCTIONAL_REQUIREMENTS.md / QUALITY_ACCEPTANCE_MATRIX.md | FR-12 40 requirements/tests, targets, applicable standards and verification. |
| TEST_STRATEGY.md / PERFORMANCE_BENCHMARK_PLAN.md | Fixtures, independent expected outputs, test types and reproducible measurement protocol. |
| OFFICE_COMPATIBILITY_MATRIX.md | Consolidate existing DOCX/XLSX/PPTX/PDF/CSV and formula support profiles without losing details. |
| AI_TOOL_CONTRACTS.md / VOICE_BENCHMARK.md | Reuse shared AI/voice specifications; held-out real vs mock results. |
| SECURITY_MODEL.md / SECURITY_VERIFICATION_MATRIX.md | Shared trust boundaries, role/policy tests, provider and file controls, applicable ASVS checks. |
| SERVICE_LEVEL_OBJECTIVES.md / BACKUP_AND_DISASTER_RECOVERY_PLAN.md | SLI definitions, error budget, restore protocol and measured target status. |
| ACCESSIBILITY_AND_LOCALIZATION_TEST_PLAN.md | Applicable WCAG criteria, editor/voice keyboard/manual tests, Khmer native fixtures. |
| ARCHITECTURE_OVERVIEW.md / TECHNICAL_DECISIONS.md / RISK_REGISTER.md | Candidate decisions, selected evidence, risks, approval and revisit conditions. |
| TECHNICAL_FEASIBILITY_PLAN.md | TF-01–12 comparison and actual experiments, cost/license restrictions. |
| DEVELOPMENT_ROADMAP.md / DEVELOPMENT_STATUS.md / CHANGELOG.md | Actual work, dependencies, approved gates, test status, changes, next actions. |
| RELEASE_READINESS_CHECKLIST.md / STAGE_3_EXIT_REVIEW.md | Hard blockers, pending owner approvals, coverage and conditional Stage 4 entry. |

The consolidated report itself supplies draft PRS/SRS/parent RTM/NFR/exit review content; it is not a substitute for implementation-specific documentation and signed decisions. Where original docs already use other names, map and extend them. Do not count multiple files as progress by themselves.

### 23.2 Founder approval checklist (pending, not pre-authorized)

| ID | Decision to confirm |
| :--- | :--- |
| APPROVAL-01 | Confirm proposed consolidated P0 scope/exclusions and EN/KM requirement; any changed launch scope explicitly recorded. |
| APPROVAL-02 | Confirm RC-00/QE-00 read-only local assessment and permitted G1 work. |
| APPROVAL-03 | Approve bounded Stage 4 experiments individually, environment access, dependency/model download, consented audio and spending ceiling. |
| APPROVAL-04 | Approve actual technology/edition/license choices only after comparative evidence. |
| APPROVAL-05 | Approve measured compatibility profiles, capacity, security acceptance, RPO/RTO/SLO and cost targets. |
| APPROVAL-06 | Approve D2+ production design/implementation, migration or deployment separately after gates. |
| APPROVAL-07 | Authorize actual live external AI/speech/payment, data-processing settings, pilot customer data, public launch and contractual terms separately. |

## 24. Reference index

Research references are public standards/engineering guidance, not evidence of implementation. FR-13 new research reviewed ISO 29148 public abstract, NASA matrix guidance and SEBoK requirements management/definition excerpts; FR-12 references retained from prior research, with consequential claims tied to sources. Full paid standards, control-by-control compliance, vendor terms and customer legal obligations were not reviewed here. Verify versions and applicability during Stage 4/6. Some entries are earlier verified/reference URLs, not fresh full-text reads in this turn.

| Ref | Reference and purpose |
| :--- | :--- |
| R01 | ISO/IEC 25010:2023, product quality model (public abstract): https://www.iso.org/standard/78176.html |
| R02 | OWASP ASVS, security verification baseline: https://owasp.org/projects/asvs |
| R03 | NIST SP 800-218, SSDF: https://csrc.nist.gov/pubs/sp/800/218/final |
| R04 | NIST SP 800-218A, AI SSDF profile: https://csrc.nist.gov/pubs/sp/800/218/a/final |
| R05 | NIST AI RMF Generative AI Profile, NIST AI technical reports: https://airc.nist.gov/technical-reports/ |
| R06 | OWASP GenAI security risks and verification reference: https://genai.owasp.org/initiatives/top-10-for-llm-and-genai/ |
| R07 | W3C WCAG 2.2: https://www.w3.org/TR/WCAG22/ |
| R08 | Google SRE Workbook, Implementing SLOs: https://sre.google/workbook/implementing-slos/ |
| R09 | Core Web Vitals threshold methodology: https://web.dev/articles/defining-core-web-vitals-thresholds |
| R10 | ECMA-376 Office Open XML: https://ecma-international.org/publications-and-standards/standards/ecma-376/ |
| R11 | PostgreSQL row security policies and owner/bypass caveats: https://www.postgresql.org/docs/current/ddl-rowsecurity.html |
| R12 | OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html |
| R13 | PostgreSQL continuous archiving and point-in-time recovery: https://www.postgresql.org/docs/current/continuous-archiving.html |
| R14 | NIST SP 800-34 Rev. 1, contingency planning: https://csrc.nist.gov/pubs/sp/800/34/r1/final |
| R15 | DuckDB numeric types, decimal division behavior (reverify selected engine/version): https://duckdb.org/docs/stable/sql/data_types/numeric.html |
| R16 | W3C Khmer script resources: https://www.w3.org/International/sealreq/khmer/ |
| R17 | OpenTelemetry concepts/signals: https://opentelemetry.io/docs/concepts/signals/ |
| R18 | ISO/IEC/IEEE 29148:2018, requirements engineering (public abstract): https://www.iso.org/standard/72089.html |
| R19 | NASA Systems Engineering Handbook Appendix D, requirements verification matrix: https://www.nasa.gov/reference/appendix-d-requirements-verification-matrix/ |
| R20 | SEBoK Requirements Management, traceability and change control: https://sebokwiki.org/wiki/Requirements_Management |
| R21 | SEBoK System Requirements Definition: https://sebokwiki.org/wiki/System_Requirements_Definition |
| R22 | OWASP API Security broken object-level authorization: https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/ |
| R23 | Microsoft Azure Architecture Center, tenancy models: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models |
| R24 | Model routing reference, Vercel AI Gateway: https://vercel.com/docs/ai-gateway/models-and-providers/provider-options |
| R25 | Google Cloud Speech-to-Text supported languages (verify exact model/region): https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages |
| R26 | Azure Speech language and voice support: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support |
| R27 | Tau-bench original 2024 study, state-based and repeated-trial evaluation (historical evidence; abstract only in prior research): https://arxiv.org/abs/2406.12045 |

## 25. Final Stage 3 conclusion and limitations

FR-12 and FR-13 are consolidated in this report. The 51 parent IDs are retained and all 40 NFR subrequirements and 40 NFR test IDs appear in Part A. Parent RTM and consolidation tests are proposed; earlier detailed requirements remain governed by their source documents. The attached/available handovers were inspected for requirement/test identity and scope, not actual repository behavior. No full leaf-level implementation matrix or production benchmark has been independently completed. Numerical quality thresholds, additional RC tests, feasibility labels, prioritization resolutions, scorecard weights and development order are recommendations. Existing approval, license, infrastructure and live-service restrictions remain in force. Research is drafted, not signed off; actual software implementation progress remains unknown until coder's reproducible assessment. The next recommended milestone is Stage 4 / TF-01 technical feasibility baseline.

---

## Appendix A — Prior acceptance-case index for the consolidated RTM

The following table retains the lower-level scenario definitions from the earlier engineering handovers V1.1 (FR-03/04), V1.2 (FR-06/07) and V1.3 (FR-09/10/11). It is included for copy/paste continuity and does not supersede source documents or their specific requirements. All statuses here are NOT RUN/independent verification pending; tests of later capabilities remain planned. The complete FR-02, FR-05 and FR-08 scenario summaries follow in Appendix B. FR-12, original E2E and new RC tests are in the main body above.

| Test ID | Retained scenario / expected result (source wording consolidated) |
| :--- | :--- |
| SHT-T01 | Multi-sheet XLSX import; supported cells, formulas and structure preserved |
| SHT-T02 | Input edit updates dependent formulas correctly |
| SHT-T03 | Relative and absolute references copy correctly |
| SHT-T04 | Circular reference detected and reported |
| SHT-T05 | Khmer text and long IDs survive import/edit/export |
| SHT-T06 | EN voice command computes correct formula in intended range |
| SHT-T07 | Equivalent KM command gives equivalent validated outcome |
| SHT-T08 | Sort whole records; identifiers remain paired |
| SHT-T09 | Protected formula overwrite rejected without authorization |
| SHT-T10 | Malicious cell instruction cannot gain privileges or execute unauthorized action |
| SHT-T11 | Interrupt bulk operation; safe cancel/recovery |
| SHT-T12 | Undo AI change; original values, formulas and relevant metadata restored |
| SHT-T13 | XLSX export/reopen; supported formulas editable and independently correct |
| SHT-T14 | Unsupported Excel formula explicitly reported, not silently fabricated |
| SHT-T15 | Approved metrics published to Document Studio reconcile |
| SHT-T16 | AI outage leaves manual editing/calculation available |
| SHT-T17 | Unsafe CSV strings handled according to tested export policy |
| SHT-T18 | Generated formula succeeds on varied inputs and counterexamples |
| DAT-T01 | Different column order across files → correct mapping |
| DAT-T02 | Khmer text/IDs survive import and transformations |
| DAT-T03 | Ambiguous dates → explicit interpretation, no silent guess |
| DAT-T04 | Missing amounts → exception, no substitution with zero |
| DAT-T05 | Duplicate invoice lines → approved composite business key |
| DAT-T06 | Duplicate reference key → unexpected multiplication blocked |
| DAT-T07 | Unmatched customer keys → retained/reported per join policy |
| DAT-T08 | Cancel transform → original and approved outputs unchanged |
| DAT-T09 | Rerun pinned recipe → expected reproducible semantic output |
| DAT-T10 | Schema drift → incompatible execution blocked/reviewed |
| DAT-T11 | EN/KM equivalent commands → same validated transform |
| DAT-T12 | Malicious cell instructions → no unauthorized execution |
| DAT-T13 | Malformed CSV → recorded rejects and reconciliation |
| DAT-T14 | Critical exceptions remain → certification blocked |
| DAT-T15 | Refresh → historical approved versions preserved |
| DAT-T16 | Cross-tenant attempt → denied in API, storage and worker |
| DAT-T17 | Retry failed job → no duplicate/partial publication |
| DAT-T18 | Certified dataset → expected counts and financial totals match |
| PPT-T01 | Create multi-slide deck — Correct order, save/reopen |
| PPT-T02 | Edit one text box — Only target changes |
| PPT-T03 | Move/resize object — Correct geometry persists |
| PPT-T04 | Apply theme — Approved colors/fonts |
| PPT-T05 | Import supported PPTX — Native editable objects |
| PPT-T06 | Export/reopen PowerPoint — No silent loss of supported content; reference app test |
| PPT-T07 | Native chart — Exact approved data values |
| PPT-T08 | Change chart type — Unchanged data/units/filter context |
| PPT-T09 | Khmer slides — Correct shaped text and layout |
| PPT-T10 | Khmer PDF — Searchable text, no required clipping/broken glyphs |
| PPT-T11 | Translate financial deck — Figures, units, sources unchanged |
| PPT-T12 | Equivalent EN/KM command — Equivalent authorized operations |
| PPT-T13 | Excess text — Overflow detected; correction proposal |
| PPT-T14 | Refresh linked draft — New revision with correct updated bindings |
| PPT-T15 | Historical published deck — Original snapshot unchanged |
| PPT-T16 | Malicious imported instructions — No unauthorized execution |
| PPT-T17 | Unauthorized external export — Denied |
| PPT-T18 | Cancel generation — Original deck intact, safe recovery |
| PPT-T19 | Confidential notes/hidden chart data — Complete-package disclosure controls |
| PPT-T20 | AI unavailable — Manual authoring remains functional |
| BI-T01 | Create/save/reopen dashboard — Same editable visual configuration and revision |
| BI-T02 | Add KPI with certified metric — Matches FR-05 reference and definition |
| BI-T03 | Add bar and line charts — Correct group/order/unit/series, no invented points |
| BI-T04 | Filter report/page/visual — Exact effective scope and expected results |
| BI-T05 | Cross-filter selected department — Dependent visuals update only as configured |
| BI-T06 | Reset/All/empty selection — Approved default or permitted population; no policy bypass |
| BI-T07 | Drill into permitted records — Correct predicates, authorized rows/columns, back restores view |
| BI-T08 | Overall profit margin — Ratio of totals, not average of group margins |
| BI-T09 | Distinct customers across departments — Recompute distinct count, no double-count |
| BI-T10 | Join budget and actual at common grain — No duplicated budget amounts |
| BI-T11 | Zero denominator, null and no matches — Distinct explicit states, no fabricated zero |
| BI-T12 | Mixed currencies or ambiguous period — Block or clarify, approved conversion/calendar only |
| BI-T13 | Create dashboard with Khmer labels — Correct typography and locale; stable underlying IDs |
| BI-T14 | Equivalent EN/KM instructions — Equivalent authorized plan and verified result |
| BI-T15 | Change chart type via AI — Same data and scope unless reviewed change |
| BI-T16 | Unauthorized tenant/resource ID — Reject access to visual, result, job, source and export |
| BI-T17 | Restricted role views same dashboard — Correct scoped totals and no forbidden rows/columns |
| BI-T18 | Cache reused across different roles — No leakage; correct per-policy result |
| BI-T19 | Revoked access to historical snapshot — Deny future retrieval; no cached bypass |
| BI-T20 | Refresh succeeded — New approved manifest for new draft only |
| BI-T21 | Refresh fails or is cancelled — Last good state remains visible with stale/error flag |
| BI-T22 | Rapid filter changes and out-of-order responses — Only newest matching context displayed |
| BI-T23 | Retry same refresh/publication job — No duplicate publication or partial replacement |
| BI-T24 | Publish with invalid mandatory metric — Block approval/publication |
| BI-T25 | Historical publication reopened — Exact pinned source/model/revision, current access enforced |
| BI-T26 | Export filtered summary — Exact displayed authorized scope, safe values, provenance |
| BI-T27 | Attempt export of unauthorized underlying data — Deny/sanitize according to policy |
| BI-T28 | Malicious AI/query/visual config — Reject invalid operations and external/code execution |
| BI-T29 | Create linked management presentation — Figures, labels, period and scope match dashboard |
| BI-T30 | AI service unavailable — Manual report/view/filter functions still available |
| BI-T31 | Keyboard/screen-reader view — Accessible controls and textual data alternatives |
| BI-T32 | Bounded expensive query — Limit/cancel safely; visible status, no unsafe partial result |
| BI-T33 | Threshold alert (P1) — Fresh authorized metric; deduplication, cooldown, recipient checks |
| BI-T34 | Scheduled refresh (P1) — Validated new input, history, failure and policy handling |
| X-VIS-01 | Same approved metric in worksheet/report/dashboard/deck — Identical value, unit, dataset/metric version, period and filter scope |
| X-VIS-02 | User filters Sales + Services — Values match scoped fixture; exported title/scope correct |
| X-VIS-03 | Sales-only user tries All/detail/export — No data outside authorized scope |
| X-VIS-04 | Refresh with new source version — New draft manifest only; historical publication unchanged |
| X-VIS-05 | Change visualization appearance — Unchanged metric values and provenance |
| X-VIS-06 | Translate presentation/dashboard narrative — Same authoritative figures and approved terminology |
| X-VIS-07 | Imported malicious text or visual config — No unrestricted tool, query, network or code action |
| X-VIS-08 | Cancel/retry generation or refresh — No partial overwrite or duplicate publication |
| AI-T01 | Select paragraph and rewrite — Only intended paragraph changes |
| AI-T02 | Change selection during execution — Detect stale selection/revision; no wrong target |
| AI-T03 | Request formula in English — Correct formula and destination |
| AI-T04 | Repeat equivalent request in Khmer — Equivalent validated operation |
| AI-T05 | Ambiguous financial metric — Resolve approved definition or clarify |
| AI-T06 | Ask about corporate policy — Supporting authorized evidence |
| AI-T07 | Conflicting sources — Identify conflict explicitly |
| AI-T08 | Unavailable information — No fabricated result or source |
| AI-T09 | Cross-tenant retrieval — Deny before data exposure |
| AI-T10 | Malicious document instructions — No unauthorized execution |
| AI-T11 | Invalid model parameters — Reject or bounded safe correction |
| AI-T12 | Unauthorized tool proposal — Policy rejects |
| AI-T13 | Modify approved plan — Require renewed approval |
| AI-T14 | Permission revoked during execution — Block later unauthorized operations |
| AI-T15 | Certified financial report — Figures reconcile with independent analytical fixture |
| AI-T16 | Provider outage — Only compatible approved fallback |
| AI-T17 | Fallback violates privacy policy — No transfer; safe stop |
| AI-T18 | Repeated tool calls — No duplicate business effects |
| AI-T19 | Cancel active workflow — Stop eligible work; preserve committed state |
| AI-T20 | Worker restart — Resume/recover from durable state |
| AI-T21 | Authorized task budget reached — Stop additional spending |
| AI-T22 | Concurrent budget-consuming tasks — Atomic shared reservations |
| AI-T23 | Inspect audit — Reconstruct material actions without secret leakage |
| AI-T24 | Change configured model version — Regression evaluation before activation |
| AI-T25 | Delete or revoke knowledge source — No unauthorized stale retrieval |
| AI-T26 | Repeat benchmark task — Measure actual-state repeatability |
| AI-T27 | Approve linked reporting workflow — Exact source and approval context preserved |
| AI-T28 | Disconnect all AI providers — Manual editing remains operational |
| VOC-T01 | Deny microphone permission — Typed interaction available |
| VOC-T02 | Activate PTT — Recording begins only after deliberate activation |
| VOC-T03 | Stop recording — Finalize intended utterance |
| VOC-T04 | Cancel unsubmitted recording — No operation executes |
| VOC-T05 | English editing instruction — Correct validated operation |
| VOC-T06 | Equivalent Khmer instruction — Equivalent authorized result |
| VOC-T07 | Dictate imperative sentence — Insert content; never execute instruction |
| VOC-T08 | Correct misrecognized transcript — Only confirmed instruction executes |
| VOC-T09 | Khmer monetary amount — Exact numerical meaning preserved |
| VOC-T10 | Ambiguous currency — Clarify |
| VOC-T11 | Misheard cell reference — Prevent wrong-target execution |
| VOC-T12 | Selection changes during recognition — Resolve original context or block conflict |
| VOC-T13 | Partial transcription — No protected mutation |
| VOC-T14 | Corporate term — Resolve approved terminology |
| VOC-T15 | Khmer input, English output — Requested output language |
| VOC-T16 | Silence/background noise — No unintended business action |
| VOC-T17 | Microphone disconnect — Safe termination/recovery |
| VOC-T18 | Network failure during recording — Safe failure without duplicate effects |
| VOC-T19 | Speech provider unavailable — Approved fallback or text |
| VOC-T20 | Fallback violates data policy — No audio transfer |
| VOC-T21 | Repeated final utterance event — No duplicate business effects |
| VOC-T22 | Unauthorized spoken operation — Shared policy rejects |
| VOC-T23 | Revoke permissions mid-workflow — Block subsequent unauthorized steps |
| VOC-T24 | Voice budget reached — Stop additional chargeable operations |
| VOC-T25 | Cross-module report request — Correct context, plan and approvals |
| VOC-T26 | Audio/transcript deletion — Enforce documented retention/deletion policy |
| VOC-T27 | Close voice UI/sign out — Stop or safely terminate microphone capture |
| VOC-T28 | Keyboard operation — Accessible controls and feedback |
| VOC-T29 | Voice audit record — Material action reconstructible without unnecessary audio |
| VOC-T30 | All speech providers disconnected — Manual editing and typed AI available |
| PLT-T01 | Create two tenants and switch authenticated context — Isolated membership and UI/session state; PLT-01 |
| PLT-T02 | Invite user with scoped role and expiry — Correct one-time membership, no excess privilege; PLT-01 |
| PLT-T03 | Reuse expired/revoked/accepted invite — Reject replay, no duplicate seat; PLT-01/06 |
| PLT-T04 | Try unauthorized role assignment — Deny escalation; audit safe reason; PLT-01 |
| PLT-T05 | Remove sole owner — Block until approved transfer/recovery; PLT-01 |
| PLT-T06 | Suspend/offboard user during job — Revoke session/grants, block later protected step; PLT-01/05 |
| PLT-T07 | Swap another tenant's object ID in API — Deny read/write/search without existence leak; PLT-01 |
| PLT-T08 | Query metadata using real app DB role — Cross-tenant rows denied, pooling scope not retained; PLT-01 |
| PLT-T09 | Try cross-tenant foreign-key relationship — Reject reference; PLT-01/03 |
| PLT-T10 | Viewer attempts edit/AI mutation — Same deny for UI, typed, voice, API; PLT-01 |
| PLT-T11 | Billing admin opens restricted finance content — Deny content; scoped usage still accessible; PLT-01/06 |
| PLT-T12 | Revoke access then query search/cache/download — No unauthorized new retrieval/URL issuance; PLT-01/03 |
| PLT-T13 | Session expiry/logout/tenant switch — Reject stale request; terminate voice capture; PLT-01 |
| PLT-T14 | Privileged change without required MFA — Block and request approved step-up; PLT-01 |
| PLT-T15 | Two editors commit same expected revision — Conflict, no silent overwrite; PLT-02 |
| PLT-T16 | Approve revision then modify content — New draft, old approval invalid; PLT-02 |
| PLT-T17 | Restore older revision — New revision, previous history unchanged; PLT-02 |
| PLT-T18 | Publish complete and incomplete package — Only exact approved validated package visible; PLT-02/05 |
| PLT-T19 | Retrieve file using guessed key/expired URL — Deny unauthorized access; PLT-03 |
| PLT-T20 | Export chart/notes with unauthorized hidden data — Strip allowed subset or deny disclosure; PLT-03/04 |
| PLT-T21 | Delete referenced source with retention/hold — Enforce impact/hold/retention policy, no silent loss; PLT-03 |
| PLT-T22 | Upload invalid MIME, extension or signature — Reject/quarantine with safe diagnostic; PLT-04 |
| PLT-T23 | Upload oversized or decompression-bomb fixture — Bounded reject, no worker escape; PLT-04 |
| PLT-T24 | Import macro/external links/malformed OpenXML — No macro/network execution; explicit unsupported result; PLT-04 |
| PLT-T25 | Attempt traversal or active-content preview — Reject/sanitize; no arbitrary file or script access; PLT-04 |
| PLT-T26 | Upload canceled between blob and metadata commit — No invalid artifact; safe orphan cleanup; PLT-04/05 |
| PLT-T27 | Worker crash and lease expiry/retry — Recover once; old lease cannot commit; PLT-05 |
| PLT-T28 | Cancel running export/AI operation — Stop eligible work, truthful status, preserve prior outputs; PLT-05 |
| PLT-T29 | Exhaust tenant concurrency/storage quota — Bounded denial; other tenant remains usable; PLT-05/06 |
| PLT-T30 | Two requests compete for remaining seat/budget — Atomic reservation; no oversubscription; PLT-06 |
| PLT-T31 | Feature disabled despite permitted role — Entitlement deny; authorized existing work follows grace policy; PLT-06 |
| PLT-T32 | Duplicate usage events and uncertain provider charge — Deduplicated settlement, correct pending/reserved/observed balance; PLT-06 |
| PLT-T33 | Mock unsigned/duplicate/out-of-order billing events — Invalid rejected; idempotent state reconciliation, no charge; PLT-06 |
| PLT-T34 | Read audit records as another tenant/unauthorized user — Deny; authorized auditor sees safe metadata and actual operation; PLT-03 |
| PLT-T35 | Restore consistent DB/object backup in isolated environment — Verify references, checksum, history, revoked grants, tombstones; measure RPO/RTO; PLT-03/NFR-02 |
| PLT-T36 | Simulate DB/worker/provider degradation — Visible health/error, no unauthorized fallback, last good outputs and permitted manual interaction; PLT-05 |
| GOV-T01 | Same English typed, Khmer typed and Khmer spoken/mocked intent — Same permitted target/parameters and expected state; real speech separately measured |
| GOV-T02 | Approved finance summary in all four studios — Exact fixture reconciliation; source scope and revision visible |
| GOV-T03 | Malicious spreadsheet cell requests export — AI proposal denied by central policy; no egress or unauthorized logs |
| GOV-T04 | Local speech and model outage with confidential data — Block unapproved cloud fallback; typed/manual alternative |
| GOV-T05 | Revoke membership or provider policy after approval and during worker job — Reauthorization blocks protected work, stale approval unusable |
| GOV-T06 | Two voice/AI runs share last budget; repeated final event and failed response — Atomic reservations, one operation effect, correct cost ledger |
| GOV-T07 | Publish manifest after content changes or partial output failure — No inconsistent publication; new approval required |
| GOV-T08 | Isolated recovery after backup including completed operations and removed user — Exact version integrity, no duplicate job/publication, no restored revoked access |

## Appendix B — Earlier research acceptance scenarios retained for traceability

These compact scenario summaries reconstruct the test identifiers and intended behavior from the FR-02, FR-05 and FR-08 research drafts in project conversation context. They are not verbatim transcriptions of separate authoritative test files. Reconcile exact wording and fixture definitions against the existing detailed register in RC-00; do not overwrite a previously approved test or its evidence. All independent verification remains pending.

| Test ID | Scenario / expected result |
| :--- | :--- |
| DOC-T01 | Khmer spoken instruction generates intended English business letter using approved template; clarify missing material fields. |
| DOC-T02 | Edit selected paragraph only; preserve unrelated content and correct revision. |
| DOC-T03 | Correct recognized name before execution; retain exact confirmed name. |
| DOC-T04 | Translate supported content while preserving all material amounts, dates, currencies and identifiers. |
| DOC-T05 | Bilingual DOCX round-trip: preserve supported editable structure, text and layout, report unsupported features. |
| DOC-T06 | Bilingual searchable PDF: inspect Khmer shaping, no required clipping and extractable supported text. |
| DOC-T07 | Ambiguous spoken quantity: clarify and confirm exact parameter before protected operation. |
| DOC-T08 | Attempt editing locked/protected content: deny or route to authorized proposal. |
| DOC-T09 | Interrupt editing/generation: retain committed version and safe recovery. |
| DOC-T10 | Untrusted document contains malicious instruction: no unauthorized tool call/disclosure. |
| DOC-T11 | AI/speech provider unavailable: supported manual document editing remains usable. |
| DOC-T12 | Linked report figures reconcile with approved metrics and exact source versions/filters. |
| ANA-T01 | Compute revenue and costs/profits: independently specified reference totals. |
| ANA-T02 | Aggregate departmental margins as ratio of combined totals, not average of ratios. |
| ANA-T03 | Zero denominator returns explicit unavailable result. |
| ANA-T04 | Distinct customer count does not double-count across groups. |
| ANA-T05 | Compare actuals with monthly budget at common grain; no join multiplication. |
| ANA-T06 | Fiscal-year-to-date uses correct calendar boundaries. |
| ANA-T07 | Partial period vs complete period warns or calculates comparable periods. |
| ANA-T08 | Multiple currencies without approved conversion blocked or clarified. |
| ANA-T09 | Monetary calculation and rounding match approved precision policy. |
| ANA-T10 | Missing material amounts block certification when required. |
| ANA-T11 | Change metric definition; historical metric and result versions preserved. |
| ANA-T12 | Equivalent English and Khmer commands yield equivalent validated operation/result. |
| ANA-T13 | Ambiguous profit question resolves approved definition or clarifies. |
| ANA-T14 | Other tenant's analytical result access rejected. |
| ANA-T15 | Unsafe analytical operation rejected by trusted policy. |
| ANA-T16 | Report, slide and dashboard figures independently reconcile. |
| ANA-T17 | Retry failed analytical job without duplicate publication or corruption. |
| ANA-T18 | Historical report retains original metric and dataset versions. |
| INT-T01 | Insert certified metric across studios; same result under same context. |
| INT-T02 | Insert filtered analytical table; correct filters, units and source. |
| INT-T03 | Convert dashboard chart to supported editable presentation chart with matching values. |
| INT-T04 | Rename source workbook; stable resource links remain valid. |
| INT-T05 | New dataset version marks eligible draft links update available. |
| INT-T06 | Refresh report draft creates new revision with visible differences. |
| INT-T07 | Older published package retains original approved values. |
| INT-T08 | Change metric definition; identify authorized affected dependencies. |
| INT-T09 | Remove required source column; block incompatible refresh. |
| INT-T10 | Unauthorized source access denied without protected metadata/content leak. |
| INT-T11 | Revoke access during workflow; later unauthorized steps blocked. |
| INT-T12 | Multi-artifact reporting package reconciles correct sources and revisions. |
| INT-T13 | Presentation generation failure does not publish incomplete package. |
| INT-T14 | Interrupted workflow retry causes no duplicate business effects. |
| INT-T15 | Cancel active workflow; preserve approved state and recover safely. |
| INT-T16 | Concurrent artifact edits detect revision conflict. |
| INT-T17 | Material change after approval invalidates previous approval. |
| INT-T18 | Equivalent English/Khmer workflow instructions yield equivalent authorized plan/result. |
| INT-T19 | Unauthorized external export blocked. |
| INT-T20 | Dependency graph scoped; no unauthorized metadata leakage. |
| INT-T21 | Embedded chart export contains no unauthorized source records. |
| INT-T22 | Publication failure leaves no inconsistent published package visibility. |
| INT-T23 | Restore prior revision as new recoverable revision; history retained. |
| INT-T24 | Permission change prevents unauthorized cached result retrieval. |

## Appendix C — Founder-to-coder execution note (use only if you approve the proposed scope)

Act as the senior software engineering team for AI Office Suite. Read Main Research and Engineering Report V1.4 completely and reconcile it with the existing master context, previous handovers and actual implementation. Preserve approved work, shared contracts, all stable requirement and acceptance IDs, existing passing tests and the current authorization boundaries. I authorize only the bounded local RC-00 and QE-00 baseline/reconciliation assessment, within any already approved G0/G1 scope. Return the actual evidence-backed requirements register, traceability matrix, quality baseline, blockers and proposed Stage 4 feasibility investigations. Do not treat a P0 requirement, candidate technology, unverified test or research recommendation as permission to begin production development. Do not purchase or activate paid resources, transfer confidential data or audio externally, install machine-wide dependencies, migrate live data, push code or deploy without separate authorization. Stop at the applicable review gate and provide exact next decisions requiring approval. Distinguish proposed, approved, reported, verified, pending and blocked items. No fabricated test results, readiness claims, or code status.
