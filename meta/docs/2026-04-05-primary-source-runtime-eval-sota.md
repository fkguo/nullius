# 2026-04-05 Primary-Source Runtime / Eval SOTA Audit

## Why this memo exists

This memo records the 2026-04-05 primary-source SOTA pass for autoresearch runtime / evaluation planning.

The immediate trigger was a source-grounded correction: summary-level reads and README-level repo inspection were not sufficient for current planning. In particular, `claude-code-sourcemap` and `claw-code` could not be treated as the same evidence layer, and recent 2026 agent-eval / harness papers needed full-text reading rather than abstract-only synthesis.

This memo is intentionally narrow:

- record what the current evidence actually supports
- state which existing redesign priorities are confirmed rather than overturned
- name the next planning gaps without silently promoting them into tracker items

It does **not** ratify new remediation item ids by itself.

## Public-surface note

References below to `REDESIGN_PLAN`, tracker items, or next-batch candidates are preserved as historical planning context only.
Current public authority comes from live code, tests, contracts, and front-door docs rather than deleted maintainer-only planning files.

## Evidence scope

### Paper corpus actually read from source / full text

- `arXiv:2603.28407` — `MiroEval: Benchmarking Multimodal Deep Research Agents in Process and Outcome`
- `arXiv:2603.25158` — `Trace2Skill`
- `arXiv:2603.15401` — `SWE-Skills-Bench`
- `arXiv:2601.22129` — `SWE-Replay`
- `arXiv:2602.02475` — `AGENTRX`
- `arXiv:2602.01611` — protocol/interface perturbation paper (`PIPE`)
- `arXiv:2604.02022` — `ATBench`

The most important reads were performed from LaTeX/source-first local copies under:

- `<local_sota_probe_root>/arxiv-2603.28407/`
- `<local_sota_probe_root>/arxiv-2603.25158/`

### Codebases actually inspected from source

- `codex`:
  - `codex-rs/execpolicy/src/parser.rs`
  - `codex-rs/config/src/requirements_exec_policy.rs`
  - `codex-rs/core/src/config/types.rs`
  - `codex-rs/core/src/mcp_tool_call.rs`
  - `codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`
- `claude-code-sourcemap`:
  - `extract-sources.js`
  - `restored-src/src/Tool.ts`
  - `restored-src/src/tools.ts`
  - `restored-src/src/bootstrap/state.ts`
- `claw-code`:
  - `rust/Cargo.toml`
  - `rust/crates/rusty-claude-cli/src/main.rs`
  - `rust/crates/runtime/src/lib.rs`
  - `rust/crates/compat-harness/src/lib.rs`
  - `src/main.py`
  - `src/port_manifest.py`

### Autoresearch surfaces checked against the external evidence

- `packages/orchestrator/src/tool-execution-policy.ts`
- `packages/orchestrator/src/mcp-client.ts`
- `packages/orchestrator/src/team-execution-permissions.ts`
- `packages/orchestrator/src/agent-runner-ops.ts`
- `packages/orchestrator/src/run-manifest.ts`
- `packages/shared/src/generated/research-event-v1.ts`
- `packages/shared/src/tracing.ts`
- `packages/hep-mcp/src/tools/ingest-skill-artifacts.ts`

## Source-grounded conclusions

### 1. The current runtime-first sequencing remains correct

The current ratified order

- `NEW-RT-08`
- `NEW-RT-09`
- `NEW-RT-10`
- broader `M-22` rollout / wider delegated runtime

is still the truthful order after the deeper SOTA pass.

Reason:

- recent codebase audits reinforce the value of separating tool visibility from call-time approval / mutation policy
- recent papers reinforce traceability, replay, and process-grounded evaluation
- none of the new evidence justifies reopening the already-landed bounded runtime slices before the remaining runtime seams are finished

So this audit **confirms** the existing runtime-first sequence; it does not overturn it.

### 2. `claude-code-sourcemap` and `claw-code` must not be conflated

The evidence role split is now clear:

- `claude-code-sourcemap` is best treated as released Claude Code implementation evidence for the reconstructed shipped bundle surface
- `claw-code` current `main` is best treated as a Rust-first clean-room rewrite with parity / mirror scaffolding still present in Python

This is not a cosmetic distinction. Future SOTA audits that compare “what upstream Claude Code did” versus “what a rewrite project currently does” must keep those evidence layers separate.

### 3. Autoresearch already has the right substrate in several places

The audit does **not** support a rewrite-from-scratch conclusion.

In particular, autoresearch already has meaningful live substrate for:

- execution-time tool visibility / permission enforcement
- checkpoint / replay / recovery
- event / trace artifacts
- skill-artifact ingestion

This means the next gains should come from completing and extending those substrates, not replacing them with a new architecture because of surface-level SOTA churn.

### 4. The main post-runtime gap is evaluation richness, not basic loop existence

The strongest consistent signal across `MiroEval`, `SWE-Skills-Bench`, `SWE-Replay`, `AGENTRX`, `PIPE`, and `ATBench` is that evaluation must go beyond “did the final answer look good”.

Three gaps are especially clear:

- outcome evaluation should separate `task_success`, `partial_progress`, and `cost/time/token` overhead
- trajectories should support failure localization / violation-style diagnostics, not just success/failure
- harnesses should test protocol/interface robustness so we can detect tool-surface overfitting

This does not invalidate current runtime work. It says the next serious quality step after the current runtime slices is an evaluation / diagnostics expansion.

### 5. Skill evolution should continue to prefer trajectory-grounded, many-to-one distillation

`Trace2Skill` strengthens the earlier direction already associated with `EVO-12a`:

- many-to-one consolidation beats naive sequential patching in the cited setting
- conflict-safe hierarchical merging matters
- portable skill directories remain a first-class artifact surface

This supports continuing the current skill-artifact / trajectory-evidence direction rather than pivoting back toward bloated monolithic prompts or ad hoc memory-bank-only designs.

### 6. For paper ingestion, source/LaTeX remains the preferred authority

This audit also reinforced an operational rule already emerging in development:

- when LaTeX/source is available, it should remain the preferred authority surface
- raw PDF should not be promoted back into a first-class generic authority path

Recent multimodal-eval papers do reinforce attachment-aware evaluation, but that is an evaluation requirement, not a reason to restore raw-PDF-as-authority in the main research evidence path.

## Autoresearch-specific implications

### Confirmed, not changed

- keep `NEW-RT-08 -> NEW-RT-09 -> NEW-RT-10 -> broader M-22 rollout`
- do not reopen the bounded runtime slices simply because recent agent papers discuss harnesses or safety
- continue to treat source / LaTeX as preferred paper authority when available

### Likely next-batch candidates, but not yet ratified tracker items

These should be treated as the next planning input after the current runtime batch, not as silently adopted item ids:

1. multi-axis eval contract
   - separate `task_success`, `partial_progress`, and `cost/time/token`
2. trajectory-level failure diagnostics
   - structured failure localization / violation-log-style artifacts
3. protocol / interface perturbation harness
   - detect tool-interface shortcutting and overfitting

## Current code-structure fit

### 1. Multi-axis eval should extend the existing `hep-mcp` eval substrate first

The current repository already has a live typed eval substrate in:

- `packages/hep-mcp/src/eval/schema.ts`
- `packages/hep-mcp/src/eval/runner.ts`
- `packages/hep-mcp/src/eval/metrics.ts`
- `packages/hep-mcp/src/eval/baseline.ts`

That substrate is already sufficient for fixture-driven evals, case-level reports, aggregate metrics, and baseline comparison. The real gap is that it still flattens outcome judgment into:

- untyped `metrics: Record<string, number>`
- untyped `aggregateMetrics: Record<string, number>`
- a summary that still collapses the top-line outcome to `passed/failed`

So the source-grounded next move is to extend this existing substrate with typed multi-axis outcome semantics, rather than invent a parallel `packages/orchestrator/src/eval/*` layer that does not currently exist.

### 2. Failure diagnostics should bridge runtime artifacts and shared event contracts

The runtime already emits meaningful low-level evidence:

- `packages/orchestrator/src/run-manifest.ts` provides durable step checkpoints
- `packages/orchestrator/src/tracing.ts` writes `spans.jsonl`
- `packages/orchestrator/src/agent-runner-runtime-state.ts` emits structured runtime markers such as `context_overflow_retry`, `truncation_retry`, `low_gain_turn`, and `diminishing_returns_stop`

The shared schema layer also already has partial diagnostic/event vocabulary:

- `meta/schemas/research_event_v1.schema.json`
- `packages/shared/src/generated/research-event-v1.ts`

But today that shared layer stops short of a typed trajectory-level failure-localization / violation-log artifact that can summarize why a run degraded, stalled, overfit, or required recovery.

So the code-structure-aligned next step is not a third observability silo. It is a bridge layer that converts runtime markers / spans / eval-case failures into explicit diagnostic artifacts or event payloads that stay auditable and replay-friendly.

### 3. Protocol perturbation should start as a package-local eval harness, not a new core runtime

The current test/eval layout keeps robustness checks close to domain behavior under `packages/hep-mcp/tests/eval/**`, and the current eval substrate already lives in `packages/hep-mcp/src/eval/*`.

That makes protocol/interface perturbation a poor candidate for immediate promotion into new generic core runtime authority. The first bounded implementation should instead be a package-local eval harness that:

- mutates tool-surface phrasing / parameter layout / protocol affordances
- reuses the existing eval fixtures/report flow
- consumes the already-landed orchestrator execution-policy and runtime-artifact surfaces as evidence inputs

Only after that contract stabilizes would there be evidence to promote any part of it into shared/orchestrator generic schema or runtime policy.

### 4. This mapping narrows, rather than broadens, the post-runtime plan

The current code structure therefore supports a narrow follow-up sequence:

1. finish the already-ratified runtime queue
2. extend the existing eval substrate with typed multi-axis outcome semantics
3. add an explicit diagnostics bridge from runtime artifacts into violation-style evidence
4. add a package-local perturbation harness before considering any genericization

### What this audit does not support

- no evidence that current runtime sequencing should be reordered
- no evidence that broader `M-22` rollout should jump ahead of the remaining runtime work
- no evidence that raw PDF should return as a generic first-class research evidence authority
- no evidence that `claw-code` should be treated as a direct implementation twin of `claude-code-sourcemap`

## SSOT disposition

- Historical plan/tracker naming in older materials is context only; it is not current authority.
- Current live disposition: **front-door docs update may be required**
  - add a short runtime/eval SOTA ratification note and memo reference in active status/architecture docs when adopted
- Current live disposition: **no machine-readable completion-state update required**
  - this audit does not change truthful execution status in live source/tests/contracts
- Candidate next-batch work: **not ratified in this memo**
  - propose explicitly in a later planning pass rather than smuggling into status surfaces
