# Review Packet R2: REDESIGN_PLAN v1.8.0 — Post-R1 Fix Verification

## R1 Blocking Issues — Fixes Applied

| R1 Issue | Description | Fix |
|----------|-------------|-----|
| **B1** | `EVO-13.depends_on` references dangling `NEW-05a` (should be stage IDs) | Updated tracker: `EVO-13.depends_on` now references `NEW-05a-stage3` |
| **B2** | H-17 under Phase 1 (noted deferred P2), M-22 under Phase 1 (noted deferred P3) | Moved H-17 to Phase 2, M-22 to Phase 3 in tracker JSON |
| **B3** | `AutoresearchErrorEnvelope` still in SSOT table; H-05/H-09/trace-jsonl/NEW-R15-impl deps say "AutoresearchError"; Phase 1 checklist says "AutoresearchError 映射表"; NEW-R03b titled "AutoresearchError 迁移" | 9 edits applied: SSOT row struck through with explanation; all dependency lines updated to "McpError"; Phase 1 checklist updated; NEW-R03b retitled to "Python 异常处理规范化" with updated strategy (domain-specific Python exceptions, not AutoresearchError subtypes) |
| **B4** | UX-02 claims computation outputs "兼容 `EvidenceCatalogItemV1` JSONL" — contradicts parallel-schema decision | Rewritten: computation outputs go into `ComputationEvidenceCatalogItemV1` (parallel schema, NEW-CONN-03). Explicit note that EvidenceCatalogItemV1 requires paper_id + LatexLocatorV1, semantically incompatible with computation. Lossy conversion handled by NEW-CONN-03 if needed. |

## R1 Non-Blocking Suggestions — Status

| R1 Suggestion | Status |
|---------------|--------|
| N1: Define Pipeline A/B explicitly | Already present in dependency topology section (Phase 2 → 2B → 3 → 4 timeline) |
| N2: Standardize schema-path wording | Deferred (cosmetic; `meta/schemas/` vs `autoresearch-meta/schemas/` both appear; will unify in implementation) |
| N3: Add 12 gaps → CONN mapping table | Deferred (pipeline-connectivity-audit.md already provides this mapping) |
| N4: UX-04 dependency duplication | Deferred (cosmetic) |
| N5: ComputationLocatorV1.json_pointer semantics | Deferred to NEW-CONN-03 implementation |

## What to Verify in R2

1. **B1 fix**: Check `meta/remediation_tracker_v1.json` → `EVO-13.depends_on` = `["NEW-05a-stage3"]` (no dangling `NEW-05a`)
2. **B2 fix**: Check tracker Phase placement — H-17 in Phase 2, M-22 in Phase 3
3. **B3 fix**: Grep `AutoresearchError` in `meta/REDESIGN_PLAN.md` — all remaining occurrences are negation ("不创建", "已取消", "不引入"); no positive references assuming its existence
4. **B4 fix**: UX-02 now explicitly states `ComputationEvidenceCatalogItemV1` (not EvidenceCatalogItemV1)
5. **No regressions**: SSOT table, dependency topology, Phase summary table, acceptance checklists remain consistent

## Context Files (same as R1)
- `meta/REDESIGN_PLAN.md` (修改后, ~2610 行)
- `meta/remediation_tracker_v1.json` (修改后, 135 items)
- `meta/docs/scope-audit-converged.md`
- `meta/docs/scope-audit-dual-mode-converged.md`
- `meta/docs/pipeline-connectivity-audit.md`

Please review both files carefully and produce your verdict.
