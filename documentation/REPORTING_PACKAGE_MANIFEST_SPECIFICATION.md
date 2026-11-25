# Reporting Package Manifest & Atomic Publication Specification (`FR-08` / `XI-00`)

**Contracts:** `ReportingPackageManifest`, `PublicationApproval`, `PublicationValidationCheck` (`packages/shared-contracts/src/index.ts`)  
**Persistence:** `xi_reporting_packages`, `xi_package_approvals`, `xi_artifacts`, `audit_logs`, `xi_outbox_events` (`engines/integration/src/pgPersistence.ts`)

---

## 1. Manifest Structure & Digest Binding

Each `ReportingPackageManifest` binds together:
- `packageId`, `packageVersion`, `tenantId`, `workspaceId`, `title`, `reportingPeriod`
- `sourceVersions: DatasetVersionReference[]` & `metricVersions: MetricReference[]`
- `resultReferences: AnalyticalResultReference[]` (verified FR-05 values, provenance IDs, policy scopes)
- `artifactRevisions: ArtifactRevisionReference[]` (Workbook, Document, Dashboard, Presentation exact revisions)
- `fileChecksums`: SHA-256 hashes of exported `.docx` and `.pptx` package binaries (byte integrity only; not a substitute for numerical validation)
- `validationChecks: PublicationValidationCheck[]` + `allValidationsPassed`
- `classification`, `audiencePolicy`, `themeVersion`, `manifestDigestSha256`

---

## 2. Digest-Bound Approval & Invalidation (`INT-T17`)

- `approveReportingPackage()` records a `PublicationApproval` row tied strictly to `(packageId, packageVersion, manifestDigestSha256)`.
- Any material mutation after approval (`modifyStagedPackageAfterApproval`) recomputes `manifestDigestSha256`, flips `approval.status = "invalidated"`, and blocks publication with `409 APPROVAL_INVALIDATED` until re-validated and re-approved.

---

## 3. Two-Stage Publication & Transactional Outbox (`INT-T22`)

1. **Stage & Validate Out-of-Transaction:** Compute FR-05 results, reconcile all 4 studio artifacts, generate DOCX/PPTX artifacts & SHA-256 digests, and persist staged manifest metadata. Long rendering operations never hold database locks.
2. **Short Atomic Commit (`commitPackagePublicationTx`):** Inside one PostgreSQL transaction under `SET LOCAL ROLE app_runtime`:
   - Re-verify approval status `'approved'` & matching `manifest_digest_sha256`
   - Re-verify each `artifactRevisions` entry matches `xi_artifacts.current_revision`
   - Update `xi_reporting_packages.lifecycle_status = 'published'` and `xi_artifacts.published_revision`
   - Append immutable record to `audit_logs` and insert `reporting_package.published` into `xi_outbox_events`
3. **Failure Rollback Proof:** Simulated error before commit (`simulateFailureBeforeCommit: true`) rolls back every table update cleanly with `0` partial publication visibility and `0` stray outbox events.
4. **Publication vs. External Export:** Platform publication snapshots internal revisions; external export (`exportPackagePresentationPptx`) checks `export:export` RBAC plus `ExportDisclosurePolicy` (`includeSpeakerNotes`, `includeHiddenSlides`, policy-scoped series).
