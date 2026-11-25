# Presentation Model & Operation Specification (`FR-06` / `PS-00`)

**Shared Contracts:** `packages/shared-contracts/src/index.ts`  
**Implementation:** `engines/presentation/src/presentationEngine.ts`

---

## 1. Canonical Presentation Domain Model

- **`StudioPresentation`:** `presentationId`, `tenantId`, `workspaceId`, `title`, `language` (`en | km | bilingual`), `revision`, `status` (`draft | in_review | approved | published`), `theme`, ordered `slides[]`, explicit `scopeLabel`, `publishedSnapshotHash?`.
- **`PresentationSlide`:** `slideId`, `order`, `layoutId`, `title`, ordered `elements[]`, `speakerNotes`, `hidden?`, explicit `readingOrder[]`, and `sourceRefs[]` (`LinkedMetricReference`).
- **`SlideElement` (Discriminated Union):** `text`, `shape` (`rect | round_rect | arrow`), `connector`, `image` (base64 PNG/JPEG + altText), `table`, `chart` (`ChartSpec`), `metric` (`LinkedMetricReference`).

## 2. Geometry & OOXML EMU Conversion

- Slide canvas defaults to **16:9 widescreen** (`13.333 in × 7.5 in`, CSS `1280×720 px` at `96 DPI`).
- `EMU_PER_INCH = 914400`: `inchesToEmu` / `emuToInches` and `inchesToPx` / `pxToInches` convert cleanly between canonical inches, browser pixels, and PowerPoint DrawingML EMU coordinates, validated against `validateSlideGeometry()`.

## 3. Controlled Presentation Operations (`PresentationOperationProposal`)

Supported bounded operations: `add_slide`, `replace_text`, `move_resize_element`, `apply_theme`, `insert_metric`, `change_chart_type`, `translate_narrative`, `undo_last`.  
Every mutation enforces `assertCanPerform`, `assertTenantWorkspaceAccess`, `expectedRevision` optimistic concurrency (`409 REVISION_CONFLICT`), `requiresApproval`, exact target `elementId`, immutable `sourceRefs` preservation on `change_chart_type` (`PPT-T08`) and `translate_narrative` (`PPT-T11`), and `scanForPromptInjection()` across both commands and slide text.
