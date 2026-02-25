# Review Packet R2: Phase 1 Batch 2 — Fixes for R1 Blocking Issues

## R1 Blocking Issues (Codex) — Resolved

### Issue 1: `parseHepArtifactUri` URIError on malformed percent-encoding
**Fix:** Wrapped `decodeURIComponent` calls in try/catch, returns `null` on decode failure.
**Test added:** Malformed percent-encoding test (`%E0%A4%A`).

### Issue 2: Missing `rejected` legacy mapping in run-state.ts
**Fix:** Added `rejected: 'failed'` to `LEGACY_TO_RUN_STATE` map (orchestrator uses `rejected` as terminal state for approval gate timeout/rejection).
**Test added:** `mapLegacyToRunState('rejected')` → `'failed'`.

## R1 Advisory Issues — Addressed

### Gate Registry "compile-time" comment (Codex + Gemini)
**Fix:** Renamed to "module-load uniqueness check" for accuracy.

### Mapping table invertibility (Gemini)
**By design:** The mapping is one-way (legacy → canonical). Inverse mapping is not needed since we're migrating forward with no backward compat obligation.

### ArtifactRefV1 field validation (Codex)
**Not addressed:** Adding full Ajv/Zod validation would be over-engineering for a construction helper. The generated type + sha256 regex validation provide sufficient runtime safety. Consumers doing full schema validation should use the generated Zod schema from codegen pipeline.

## Evaluation Criteria (unchanged from R1)
1. Type definitions: sufficient domain semantics?
2. Naming: consistent with existing codebase (snake_case IDs, prefixes)?
3. Cross-component boundary contracts: clear, unambiguous?
4. Mapping tables (H-03): complete?
5. Over-engineering: unnecessary abstraction or config?

## Changed files since R1

### `packages/shared/src/artifact-ref.ts`
```diff
- export function parseHepArtifactUri(uri: string): { ... } | null {
-   ...
-   return {
-     runId: decodeURIComponent(match[1]),
-     artifactName: decodeURIComponent(match[2]),
-   };
+ export function parseHepArtifactUri(uri: string): { ... } | null {
+   ...
+   try {
+     return {
+       runId: decodeURIComponent(match[1]),
+       artifactName: decodeURIComponent(match[2]),
+     };
+   } catch {
+     return null;
+   }
```

### `packages/shared/src/run-state.ts`
```diff
  FAILED: 'failed',
+ // orchestrator extended
+ rejected: 'failed',
```

### `packages/shared/src/gate-registry.ts`
```diff
- // Compile-time uniqueness check
+ // Module-load uniqueness check
```
