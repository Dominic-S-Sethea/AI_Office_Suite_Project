# BI Refresh, Manifest & Publication Policy (`FR-07` / `BI-00`)

**Implementation:** `engines/intelligence/src/intelligenceEngine.ts` (`requestDraftRefresh`, `publishSnapshot`)

---

## 1. Separated Lifecycle Timestamps

- `sourceAsOfTimestamp`: Business cutoff timestamp of underlying transactions (`2026-11-30T23:59:59.000Z`).
- `lastSuccessfulRefreshAt`: Time when the current certified dataset manifest successfully bound to the draft report.
- `lastComputedAt`: Time when query results were computed for the viewer's filter/policy scope.
Manual refresh **never** fabricates fresher source data when `datasetVersion` has not advanced.

## 2. Atomic Manifest Transitions & Failure Recovery (`BI-T20`–`BI-T25`, `X-VIS-04`, `X-VIS-08`)

- **Report Lifecycle:** `draft -> in_review -> approved -> published -> superseded`.
- **Refresh Job States:** `queued -> running -> [succeeded | failed | cancelled]`.
- **Failure / Cancellation Preservation (`BI-T21`):** Failed or cancelled refresh jobs leave `datasetVersion` on `previousGoodManifestVersion`, set an explicit `staleWarning` (`STALE_MANIFEST_RETAINED`), and never partially overwrite certified visuals.
- **Publication Gate (`BI-T24`):** `publishSnapshot()` blocks (`422 INVALID_MANDATORY_METRIC`) if any mandatory visual is `error` or `suppressed`, requires `policy.canPublish = true`, deduplicates retries via `idempotencyKey` (`BI-T23`), and freezes `snapshotSha256` (`BI-T25`).
- **Draft-Only Refresh (`BI-T20`, `X-VIS-04`):** Updating a report draft to dataset `v2` leaves previously published `v1` `PublishedBiSnapshot` records intact.
- **P1 Planned Additions (Not Implemented in `BI-00`):** Scheduled refresh (`BI-03.10`) and governed threshold alerts (`BI-03.11`, `BI-T33`, `BI-T34`) remain gated for P1 authorization.
