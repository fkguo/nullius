# GLM Formal Review — idea-generation V0

Verdict: **SHIP**

Worktree: `/Users/fkg/Coding/Agents/nullius/.claude/worktrees/idea-generation-v0`
HEAD: `aec3e5e9` (4 commits in `36bc0132..HEAD`; prompt said 5, actual is 4 — verified `git log --oneline`)
Baseline: `36bc0132`

## Summary

The implementation is thorough, source-grounded, and faithful to design.md §5/§6/§7/§9. All 87 engine tests, 26 skill tests, 154 sibling-skill tests, and the shell-boundary anti-drift check pass. The build is clean. Every documented rejection reason in the OpenRPC description has a pinning negative test. Every §9 acceptance clause (a–f) is exercised. The hardening batch (commit `aec3e5e9`) resolved the prior 33-finding review comprehensively; the newest code (file-lock reclamation, torn-line healing, import-specific recovery) is sound on the reachable paths.

No BLOCKING findings. Five NON-BLOCKING findings below — all are bounded documentation/anti-drift/edge-case gaps, none break correctness or the contract.

---

## NON-BLOCKING findings

### N1. OpenRPC + schema description under-enumerate reserved trace keys
**Where**: `idea_runtime_rpc_v1.openrpc.json` (node.import_generated description) and `generation_pack_v1.schema.json` line 156 (`trace_inputs.description`).
**Defect**: Both descriptions say engine-owned trace_input keys are `trigger / pack_artifact / parent_revisions`. The executor's `RESERVED_TRACE_INPUT_KEYS` (`import-generated-executor.ts:55-62`) actually rejects **six**: the three documented plus `target_admission_route`, `dedup`, `novelty_delta`.
**Scenario**: A reader of the contract doc believes only 3 keys are reserved and writes a generator that puts (e.g.) a `dedup` key inside `trace_inputs` for debugging. The pack is rejected with `trace_key_reserved`, which surprises them because the description didn't list it.
**Impact**: Low — the three undocumented keys are required **top-level** candidate fields per the schema, so any schema-valid pack already has them elsewhere; putting them in `trace_inputs` is a mistake, not a normal path. The error message itself is explicit (`trace_inputs.X is engine-owned`).
**Fix**: Extend the description to list all six: `trigger / pack_artifact / parent_revisions / target_admission_route / dedup / novelty_delta`.

### N2. `campaign_not_active` (-32015) untested on the import path
**Where**: `packages/idea-engine/tests/import-generated.test.ts`.
**Defect**: The OpenRPC lists `-32015 campaign_not_active` as an import error, and `ensureCampaignRunning` (`campaign-state.ts:30-32`) throws it for paused/completed campaigns, but no import_generated test imports into a paused or completed campaign.
**Scenario**: A future refactor weakens `ensureCampaignRunning`'s ordering relative to the budget check; the import path silently misbehaves for non-running campaigns and the suite doesn't catch it.
**Impact**: Low — the shared code IS tested via `node-rpc.test.ts` for `set_posterior`/`set_lifecycle` (3 occurrences of `campaign_not_active` there), so the gate itself is covered; only the import-specific wiring is unexercised.
**Fix**: Add one test that pauses/completes a campaign and asserts `-32015/campaign_not_active` on import.

### N3. `NON_NOVEL_DELTA_TYPES` mirror is not anti-drift-locked against the engine
**Where**: `skills/idea-generation/scripts/build_pack.py:69` vs `import-generated-executor.ts:73`.
**Defect**: `test_enum_mirrors_match_engine_generation_pack_contract` locks `DELTA_TYPES` against the schema enum, and `test_enabled_triggers_and_family_table_match_engine_executor` locks enabled triggers/families/arity/`DEDUP_AUTO_DROP_BOUND`/placeholder against the executor source. But the `NON_NOVEL_DELTA_TYPES` subset (`parameter_tweak`, `rewording`) — which the executor's `Set` (`import-generated-executor.ts:73`) is the authority for — has no test reading the engine source. `build_pack.NON_NOVEL_DELTA_TYPES` is only checked by its own unit test.
**Scenario**: Engine adds `'cosmetic_relabeling'` to its non-novel `Set`; `build_pack.py` doesn't know and lets the pack through; the engine then rejects it — a wasted round-trip that the fail-fast mirror was supposed to catch.
**Impact**: Low — the engine still rejects; only the local fail-fast benefit is weakened.
**Fix**: Add a regex extraction of the engine's `NON_NOVEL_DELTA_TYPES` set and assert equality with `build_pack.NON_NOVEL_DELTA_TYPES`, alongside the existing arity/enabled locks.

### N4. Narrow lock race on attempt-1 EEXIST surfaces as `schema_validation_failed`, not `store_locked`
**Where**: `packages/idea-engine/src/store/file-lock.ts:80-89` (`withLock`).
**Defect**: If attempt-0 sees EEXIST and `reclaimStaleLockOrThrow` removes the stale lock, but a concurrent acquirer re-creates the lock before attempt-1's `openSync('wx')`, attempt-1 throws a **raw** EEXIST (the `attempt === 1` short-circuit at line 84). That raw fs error is not a `StoreLockedError`, so `toSchemaError` (`service-contract-error.ts:9-29`) falls through to `schemaValidationError`, producing `-32002/schema_validation_failed` — exactly the misleading error the hardening batch aimed to eliminate.
**Scenario**: Two processes contend on the same campaign; P1 crashes, P2 reclaims and re-acquires in the narrow window between P-retry's reclaim and its second open. P-retry gets `-32002/schema_validation_failed` and may try to "fix" a valid request.
**Impact**: Very low — requires multi-process contention with microsecond-scale interleaving; the engine is single-user by design. The caller recovers by retrying. The dead-code `if (fd === null) throw new StoreLockedError(...)` at line 91 is unreachable because attempt-1 throws first.
**Fix**: Wrap the attempt-1 catch to test `code === 'EEXIST'` and throw `new StoreLockedError(lockFilePath, null)` instead of the raw error.

### N5. Empty lock file from a crash-in-openSync delays recovery by up to 10 minutes
**Where**: `file-lock.ts:44-74` (`reclaimStaleLockOrThrow`).
**Defect**: `withLock` opens with `'wx'` (creating an empty file) then calls `writeFileSync(fd, ...)` to write the pid JSON. A crash between `openSync` and `writeFileSync` leaves a 0-byte lock. On the next acquire, `JSON.parse('')` throws → `holderPid = null` → the age check applies. Since the file is brand-new, `age < STALE_LOCK_MAX_AGE_MS` → `StoreLockedError(null)`. The campaign is stuck for up to 10 minutes even though the holder is provably dead (empty file = never finished writing = crashed).
**Scenario**: Hard kill (SIGKILL/power loss) in the ~microsecond window between file creation and pid write. Recovery stalls for 10 minutes instead of proceeding.
**Impact**: Low — the stall self-resolves at the 10-minute mark, and the window is extremely narrow. Conservative behavior is intentional (an unreadable lock from a LIVE process shouldn't be reclaimed). Not a correctness issue.
**Fix** (optional): Treat an empty/0-byte lock as reclaimable regardless of age (no pid was ever written = the lock was never fully acquired).

---

## What I verified and how

### Tests run (all green)
- `pnpm -C packages/idea-engine test` → **87 passed** (11 files; `import-generated.test.ts` 33 tests, 3.67s)
- `python3 -m pytest skills/idea-generation/tests/` → **26 passed** (0.44s)
- `python3 -m pytest skills/idea-allocation/tests/ skills/idea-pairwise-match/tests/` → **154 passed** (3.39s)
- `node scripts/check-shell-boundary-anti-drift.mjs` → **ok** ("locked")
- `pnpm -C packages/idea-engine build` → **clean tsc** (no errors)

### Source read (line-level)
- **Engine**: `import-generated-executor.ts` (664L, full), `import-generated-recovery.ts` (222L, full), `generated-node.ts` (134L, full), `idempotency.ts` (209L, full), `file-lock.ts` (104L, full), `file-io.ts` (66L, full), `node-shared.ts` (141L, full), `seed-node.ts` (148L, full), `node-service.ts` (78L, full), `service-contract-error.ts` (30L, full), `campaign-state.ts` (43L, full), `engine-store.ts` (130L, full).
- **Schemas**: `generation_pack_v1.schema.json` (264L, full), `import_generated_result_v1.schema.json` (66L, full), `idea_runtime_rpc_v1.openrpc.json` (node.import_generated entry, full description), `idea_node_v1.schema.json` (required + island_id spot check).
- **Tests**: `import-generated.test.ts` (1005L, full — 33 tests incl. 10 crash-recovery drills), `test_generation_scripts.py` (700L, full — 26 tests incl. anti-drift locks and real-bridge integration).
- **Skill**: `SKILL.md` (248L, full), `dedup_check.py` (240L, full), `build_pack.py` (516L, full), `submit_pack.py` (118L, full), `conftest.py` (120L), `mock_rpc.py` (64L).
- **Docs/registration**: full diff of README.md, docs/README_zh.md, docs/ARCHITECTURE.md, docs/PROJECT_STATUS.md, docs/URI_REGISTRY.md, CHANGELOG.md, packages/idea-engine/README.md, packages/idea-mcp/README.md, packages/skills-market/packages/{idea-generation.json,index.json}, meta/compatibility-matrix/ecosystem-manifest.json, scripts/lib/front-door-boundary-authority.mjs. Skills-market `source.repo`/`subpath`/`include` pattern matches siblings (idea-allocation/pairwise-match/posterior).

### Spec clauses checked against code (design.md §5/§6/§7/§9)
- §5 Explain-then-Formalize split: generator authors rationale+card_fields; engine derives thesis (`generated-node.ts:38-43`, same rule as `seed-node.ts:56-58`), computes `formalization` trace engine-side (`generated-node.ts:92-99`), promote-gate compatible by construction (test lines 323-350 verifies end-to-end promote succeeds). ✓
- §5 engine-owned trace keys: 6 reserved keys rejected (`executor.ts:55-62, 254-270`); engine injects them (`generated-node.ts:75-88, 92-100`). ✓ (N1: description lists only 3.)
- §5 novelty-delta-as-claim: delta statement injected as `llm_inference` card claim (`generated-node.ts:50-57, 64`); `evidence_uris` populated only for URI-shaped closest_prior; `verification_plan` always present. ✓
- §5 family gating: only `LiteratureMining`+`FailureRouting` enabled (`executor.ts:53`); others `operator_family_not_enabled` (`executor.ts:183-190`); test lines 389-405. ✓
- §5 trigger gating: 3 enabled kinds (`executor.ts:22`); non-manual requires `artifact_ref` (`executor.ts:461-467`); test lines 473-482. ✓
- §5 receipts-before-URIs: every URI in claims/refs/URI-shaped-closest-prior must be in `evidence_uris_used` AND have a `{uri, source}` receipt (`executor.ts:283-311`); test lines 484-500, 625-650. ✓
- §5 placeholder ban deep-scan: `collectStrings` walks entire candidate tree (`executor.ts:122-135, 272-281`); test lines 502-510, 608-623. ✓
- §5 gap re-anchoring: gap anchor requires non-empty `resolved_refs`, each receipted (`executor.ts:357-376`); test lines 522-549. ✓
- §5 survey pinning: LiteratureMining requires `survey_artifact_ref`+`survey_content_hash` (`executor.ts:326-335`); test lines 652-660. ✓
- §5 intra-pack twin refusal: normalized title+rationale duplicate key (`executor.ts:146-151, 487-500`); test lines 669-675. ✓
- §5 dedup self-consistency: `decision=unique` at `nearest_similarity >= 0.95` refused (`executor.ts:316-324`); test lines 677-680. ✓
- §5 prompt-snapshot verification: snapshot content hashed and compared; declared hashes must be backed (`executor.ts:505-529`); test lines 683-705. ✓
- §6 parent revision validity: recorded revision must be ≤ parent's current revision (`executor.ts:241-251`); test lines 449-456. ✓
- §6 batch-atomic nodes budget: `currentCount + candidates.length > maxNodes` → `budget_exhausted` (`executor.ts:531-544`); test lines 759-777. ✓
- §6 steps not consumed: `plannedCampaign.usage.nodes_used` bumped, steps untouched (`executor.ts:597-601`); test lines 315-320 (`steps_used === 0`). ✓
- §6 pack archival verbatim: `structuredClone(pack)` in archive (`executor.ts:616-624`); test lines 298-305. ✓
- §6 import-specific recovery: probes 4 effect classes (`recovery.ts:127-222`); completion from archived pack (`recovery.ts:164-188`); immutable-projection-only node comparison (`recovery.ts:17-39, 180`); zero-effects fresh re-execution (`recovery.ts:147-152`); conflict refusals (`recovery.ts:153-156, 158-162, 169-172, 180-184`); 10 crash drills (test lines 779-1003). ✓
- §6 stale-lock reclamation: dead-pid reclaim + live-pid `store_locked` (`file-lock.ts:44-74`); `StoreLockedError → -32603/store_locked` (`service-contract-error.ts:13-25`); test lines 729-748. ✓ (N4: narrow attempt-1 race.)
- §6 torn-line healing: `appendJsonLine` opens `a+`, reads last byte, prepends `\n` if torn (`file-io.ts:41-65`); test lines 948-981. ✓
- §7 provenance: `origin` carries real model/temp/prompt_hash/timestamp/role; `operator_trace.inputs` carries trigger+pack_artifact+parent_revisions+anchor+receipts+dedup+novelty_delta+target_admission_route; `operator_trace.params` carries formalization; `evidence_uris_used` exactly the resolved URIs; `prompt_snapshot_hash` optional but verified (`generated-node.ts:102-112`). ✓
- §9 acceptance (a)–(f): all covered by tests as enumerated above. ✓

### Anti-drift locks verified real
- `test_enum_mirrors_match_engine_generation_pack_contract`: reads schema, locks trigger enum, delta_type enum, admission routes, campaign_id pattern. ✓
- `test_enabled_triggers_and_family_table_match_engine_executor`: regex-parses executor TS source, locks ENABLED_TRIGGER_KINDS, ENABLED_OPERATOR_FAMILIES, FAMILY_ARITY values (not just names), DEDUP_AUTO_DROP_BOUND, PLACEHOLDER_EVIDENCE_URI in node-shared.ts. ✓ (N3: NON_NOVEL_DELTA_TYPES subset not locked.)
- `test_submit_reaches_the_real_engine_bridge`: end-to-end through `bin/idea-rpc.mjs` + built dist, creates a real campaign, imports a real pack, verifies the generated node lands in nodes_latest.json. Skipped when node/dist absent. Meaningful integration (not theater). ✓

### Governance checks
- `operator_family` stays a free string in `idea_node_v1.schema.json` (no enum); the arity table lives in the executor, not the schema. ✓
- No `v2`/`new_*`/`legacy_*` naming introduced. ✓
- Skill scripts are Python 3.9 stdlib-only (`from __future__ import annotations`, no third-party imports in dedup_check/build_pack/submit_pack). ✓
- Domain-neutral wording throughout (no project-specific nouns in SKILL.md, schemas, or prompts). ✓
- No MCP exposure (`packages/idea-mcp/README.md` explicitly lists `node.import_generated` as engine-only). ✓
- Opt-in posture (no auto-invocation, no daemon). ✓

---

## Verdict

SHIP. The five non-blocking findings are documentation/anti-drift/edge-case polish — worth addressing in a follow-up but none rise to a contract, correctness, or design breach. The crash-recovery design (completion from the archived pack on the immutable projection, zero-effects fresh re-execute, conflict refusal on value mismatch) is sound; the write order in the executor matches the drills; the hardening batch closed every prior finding without introducing new reachable defects.
