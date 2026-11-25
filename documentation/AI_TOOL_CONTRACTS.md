# AI Tool & Operation Contracts — AI Office Suite

**Phase:** D1 / D4.01 & SS-00 Baseline  
**Invariant:** AI models never mutate database, filesystem, or DOM state directly. They emit structured, schema-validated proposals checked against revision locks, selection hashes, RBAC, and explicit user approval.

## 1. Document Operation Proposal (`DocumentOperationProposal`)

Validated by Zod schema in `packages/validation/src/index.ts` and executed deterministically in `engines/document/src/documentEngine.ts`:

```json
{
  "operationId": "op_uuid",
  "documentId": "doc_uuid",
  "expectedRevision": 2,
  "selection": {
    "blockId": "blk_exec_summary",
    "startOffset": 0,
    "endOffset": 145,
    "selectedText": "...",
    "selectionHash": "a1b2c3d4e5f60718"
  },
  "action": "replace_selection",
  "params": { "replacement": "..." },
  "requestedBy": "user_editor_1",
  "riskLevel": "medium",
  "requiresApproval": true,
  "source": "voice_command",
  "inputLanguage": "km",
  "outputLanguage": "km",
  "originalCommand": "បកប្រែកថាខណ្ឌនេះជាភាសាខ្មែរ",
  "explanation": "Translate the selected paragraph into Khmer and preserve its corporate meaning.",
  "previewDiff": {
    "blockId": "blk_exec_summary",
    "beforeText": "...",
    "afterText": "...",
    "summary": "Replace selected content in block blk_exec_summary."
  },
  "createdAt": "2026-11-26T00:00:00.000Z"
}
```

### Supported D1.04 Actions (English & Khmer Commands)
1. `insert_text` — snaps offset to Khmer `Intl.Segmenter` grapheme boundaries (never splits `U+17D2` coeng clusters).
2. `replace_selection` — verifies `selectionHash`; throws `409 SELECTION_MISMATCH` if block text drifted.
3. `set_heading` — converts paragraph/heading between normal (`0`) and `H1..H3`.
4. `toggle_bold` — applies or removes bold formatting.
5. `set_alignment` — `left | center | right | justify`.
6. `insert_table` — bounded `1..20` rows × `1..10` cols; parses both Arabic (`3x3`) and Khmer (`៣x៣`) numerals.
7. `undo_last` — creates a new non-destructive revision restoring the previous revision's snapshot.

## 2. Spreadsheet Operation Proposal (`SpreadsheetOperationProposal`, FR-03 SS-00)

```json
{
  "operationId": "sop_uuid",
  "workbookId": "wb_finance_demo",
  "expectedRevision": 1,
  "sheetName": "Finance",
  "targetRange": "D2:D4",
  "action": "set_range_formula",
  "formula": "=B2-C2",
  "fillMode": "adjust_relative_references",
  "requiresApproval": true,
  "inputLanguage": "km",
  "source": "voice_command",
  "originalCommand": "គណនាប្រាក់ចំណេញ ដោយយកចំណូលដកចំណាយ",
  "explanation": "Insert editable formula =B2-C2 across D2:D4 with relative row adjustment."
}
```

### Guardrails
- **Formula over hardcoded values:** Calculation proposals insert editable formulas evaluated by `recalculateWorkbook()`.
- **Protected cells:** Targets marked `protected: true` fail with `403 PROTECTED_CELL`.
- **Format vs Conversion:** `"Format as USD"` changes `numberFormat` only; `"Convert to USD"` returns `blockedReason: "EXCHANGE_RATE_REQUIRED"` until rate, source, and effective date are supplied.
