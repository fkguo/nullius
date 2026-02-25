# Review Packet: Phase 1 Batch 2 — Core Abstraction Layer

## Review Scope
Cross-component type definitions: H-15a (EcosystemID), H-18 (ArtifactRef), H-03 (RunState), H-04 (Gate Registry)

## Evaluation Criteria
1. Type definitions: sufficient domain semantics?
2. Naming: consistent with existing codebase (snake_case IDs, prefixes)?
3. Cross-component boundary contracts: clear, unambiguous?
4. Mapping tables (H-03): complete, invertible?
5. Over-engineering: unnecessary abstraction or config?

---

## File 1: `packages/shared/src/ecosystem-id.ts` (H-15a)

### Design Decisions
- Format: `{prefix}_{opaque}` (Stripe-inspired)
- Prefixes are registered in `ECOSYSTEM_ID_PREFIXES` const object
- Opaque part: `[a-zA-Z0-9._-]{1,200}`, no `..`, no path separators
- Branded type `EcosystemId` for type safety
- `EcosystemIdError` for validation failures

### Key Types & Functions
```typescript
export const ECOSYSTEM_ID_PREFIXES = {
  proj: 'proj', run: 'run', art: 'art', evt: 'evt',
  sig: 'sig', gate: 'gate', step: 'step', camp: 'camp',
} as const;

export type EcosystemIdPrefix = keyof typeof ECOSYSTEM_ID_PREFIXES;
export type EcosystemId = string & { readonly __brand: 'EcosystemId' };

export interface ParsedEcosystemId {
  prefix: EcosystemIdPrefix;
  opaque: string;
  raw: EcosystemId;
}

export function parseEcosystemId(raw: string): ParsedEcosystemId;
export function isValidEcosystemId(raw: string): raw is EcosystemId;
export function makeEcosystemId(prefix: EcosystemIdPrefix, opaque: string): EcosystemId;
export function isValidOpaque(opaque: string): boolean;
```

### Test Coverage: 18 tests
- Parse valid/invalid IDs, unknown prefix, path separators, `..`, empty
- Construction round-trip
- Opaque validation

---

## File 2: `packages/shared/src/artifact-ref.ts` (H-18)

### Design Decisions
- `RunArtifactRef` (lightweight: name + URI + mimeType) — moved from hep-mcp to shared
- `ArtifactRefV1` (full content-addressed: from generated type, requires sha256) — SSOT is `meta/schemas/artifact_ref_v1.schema.json`
- `hep://runs/{runId}/artifact/{name}` URI format validation and parsing
- hep-mcp's `RunArtifactRef` re-exported from shared for backward compatibility

### Key Types & Functions
```typescript
export interface RunArtifactRef {
  name: string;
  uri: string;
  mimeType?: string;
}

export function makeRunArtifactUri(runId: string, artifactName: string): string;
export function createRunArtifactRef(runId: string, artifactName: string, mimeType?: string): RunArtifactRef;
export function createArtifactRefV1(opts: CreateArtifactRefV1Options): ArtifactRefV1;
export function isHepArtifactUri(uri: string): boolean;
export function parseHepArtifactUri(uri: string): { runId: string; artifactName: string } | null;
```

### Test Coverage: 13 tests
- URI construction, encoding, parsing
- ArtifactRefV1 creation with valid/invalid sha256
- Round-trip validation

---

## File 3: `packages/shared/src/run-state.ts` (H-03)

### Design Decisions
- Run-level: `pending | running | paused | awaiting_approval | done | failed | needs_recovery`
- Step-level: `pending | in_progress | done | failed` (distinct from run-level `running`)
- Terminal states: `['done', 'failed']` — matches SkillBridgeJobEnvelope
- `created` → `pending` migration in hep-mcp (breaking, per "no backward compat" policy)
- Legacy mapping table covers: orchestrator, adapter, idea-core, plan steps, branches

### Key Types & Functions
```typescript
export const RUN_STATES = {
  pending: 'pending', running: 'running', paused: 'paused',
  awaiting_approval: 'awaiting_approval', done: 'done',
  failed: 'failed', needs_recovery: 'needs_recovery',
} as const;

export type RunState = (typeof RUN_STATES)[keyof typeof RUN_STATES];
export const TERMINAL_RUN_STATES: readonly RunState[] = ['done', 'failed'];

export const RUN_STEP_STATES = {
  pending: 'pending', in_progress: 'in_progress', done: 'done', failed: 'failed',
} as const;
export type RunStepState = (typeof RUN_STEP_STATES)[keyof typeof RUN_STEP_STATES];

export function isTerminalRunState(state: RunState): boolean;
export function isActiveRunState(state: RunState): boolean;
export function isTerminalStepState(state: RunStepState): boolean;
export function mapLegacyToRunState(legacy: string): RunState | undefined;
```

### Legacy Mapping Table
```
pending ← pending, created, idle, NOT_STARTED, candidate
running ← running, in_progress, RUNNING, active
paused ← paused
awaiting_approval ← awaiting_approval, blocked
done ← done, completed, DONE, early_stopped, skipped, abandoned
failed ← failed, FAILED, exhausted
needs_recovery ← needs_recovery
```

### Test Coverage: 17 tests
- All canonical values, terminal states, active states
- SkillBridgeJobEnvelope compatibility
- Legacy mapping (all directions)

---

## File 4: `packages/shared/src/gate-registry.ts` (H-04)

### Design Decisions
- `GateType = 'approval' | 'quality' | 'budget'`
- `GateSpec` includes `name`, `type`, `description`, `required_risk_level` (links to H-11a)
- Static registry with compile-time uniqueness check (Map size vs array length)
- 8 built-in gates: 5 approval, 2 quality, 1 budget
- No execution logic (Phase 2 H-11b)

### Key Types & Functions
```typescript
export type GateType = 'approval' | 'quality' | 'budget';

export interface GateSpec {
  name: string;
  type: GateType;
  description: string;
  required_risk_level: ToolRiskLevel;
}

export const GATE_REGISTRY: readonly GateSpec[];
export function getGateSpec(name: string): GateSpec | undefined;
export function getRegisteredGateNames(): string[];
export function validateGates(gates: string[]): void;
export function isRegisteredGate(name: string): boolean;
```

### Registered Gates
| Name | Type | Risk Level |
|------|------|-----------|
| approval_run_start | approval | write |
| approval_paperset | approval | write |
| approval_outline | approval | write |
| approval_draft | approval | write |
| approval_export | approval | destructive |
| quality_compile | quality | write |
| quality_originality | quality | write |
| budget_token | budget | read |

### Test Coverage: 13 tests
- Unique names, snake_case names
- Valid types and risk levels
- Lookup, validation, error cases

---

## Design References
- `meta/REDESIGN_PLAN.md` §H-15a, §H-03, §H-04
- `meta/schemas/artifact_ref_v1.schema.json`
- `meta/docs/design-h11a-tool-risk-levels.md`
