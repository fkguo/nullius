# Approval gates (default human approval points)

**Default: REQUIRED.** Unless the user explicitly opts into “full-auto / self-assumed risk”, the orchestrator must stop and request human approval before high-risk / high-cost / high-externality actions.

This document defines the project policy so that the Orchestrator/CLI can enforce it as a hard gate (not just “a suggestion in docs”).

Chinese version (legacy / detailed notes): `docs/APPROVAL_GATES.zh.md`.

## 1) Why approval gates are default

Research automation failures are rarely “the model can’t write”. They are usually:
- running expensive jobs that should not have been run (time/compute cost),
- editing files that should not have been edited (especially manuscripts and core logic),
- pulling from untrusted or non-compliant network sources (credibility/privacy/compliance),
- emitting conclusions/novelty claims too early (hallucination → reputation risk).

So the default is: **plan → human approve → execute**.

## 2) Default approval categories (A1–A5)

| Category | Examples | Approval required? | Why |
|---|---|---:|---|
| A1 mass_search | query expansion, citation expansion, cross-domain general search | yes | control noise and confirm scope/budget |
| A2 code_changes | modify `src/` / `toolkit/` / scripts; change compute logic | yes | avoid “writing a lot in the wrong direction”; approve an implementation plan first |
| A3 compute_runs | parameter scans, fits, event generation, GPU training | yes | budget control; require toy/audit-slice first |
| A4 paper_edits | edit `paper/` or a user-specified LaTeX repo | yes | prevent accidental edits; require diff + compile gate + citation/evidence gate |
| A5 final_conclusions | “we discover…”, “we explain discrepancy…” | yes | conclusions are high-risk outputs; must be evidence-backed and pass independent review convergence |

### 2.1 Timeout semantics (no “silence = approval”)

When a gate is triggered, the Orchestrator must persist `pending_approval` and write an approval packet. It must also define:
- `timeout_at` (or `timeout_seconds`)
- `on_timeout`

Safe defaults:
- **FORBID** `auto_approve` (silence is not approval)
- default `on_timeout = block` (stay paused; status must clearly show “timed out”)
- optional `on_timeout = reject` (auto-cancel and return to Planner; reason must be persisted)
- optional `on_timeout = escalate` (raise priority/notifications, but still paused)

Recommended default timeouts (configurable; `safe` profile):

| Gate | Suggested timeout | Suggested `on_timeout` |
|---|---:|---|
| A1 mass_search | 24h | block |
| A2 code_changes | 48h | block |
| A3 compute_runs | 48h | block |
| A4 paper_edits | 7d | block |
| A5 final_conclusions | 7d | block |

Config entry points (planned; enforced by Orchestrator):
- Schema: `specs/approval_policy.schema.json`
- Example: `templates/approval_policy.safe.example.json`

State semantics: `docs/ORCHESTRATOR_STATE.md` (EN) / `docs/ORCHESTRATOR_STATE.zh.md` (Chinese).

### 2.2 Failure + recovery (MVP)

Define this explicitly to avoid “undefined state machine” failures:

- **Timeout** (safe default):
  - on timeout, append `approval_timeout` to the ledger
  - keep `run_status = awaiting_approval` (or `paused`) and visibly show “timed out”
  - do **not** continue execution
- **Crash / restart**:
  - `pending_approval` must be persisted in `.autopilot/state.json`
  - on restart, it must remain `awaiting_approval` (must not flip to approved)
- **Human abort**:
  - mark the run `failed` (or `aborted`) with reason and rollback pointer (when applicable)

Suggested testable acceptance points (minimum 3):
- G-T1: kill orchestrator while awaiting approval → restart still `awaiting_approval`
- G-T2: after timeout, do not execute; ledger shows `approval_timeout`
- G-T3: reject/abort must not execute the action; return to Planner or fail the run

### 2.3 Actions allowed without approval (low risk)

Default allow:
- read files, summarize, plan, static lint checks (links/schema/format), generate TODO lists
- small, reversible writes (e.g. add reading notes only under `knowledge_base/`) can be allowed, but should be disclosed the first time (“will write to these paths…”).

### 2.4 A5 trigger heuristics (default; configurable later)

Trigger A5 (or force `UNVERIFIED`) for outputs that contain:
- “first / novel / new discovery / best to our knowledge / better than prior work / we have solved …”
- any strong attribution claim about other work (e.g. “they are wrong because…”) without explicit citations + artifact pointers.

### 2.5 Adapter run-card gate resolution (union/policy_only/run_card_only)

For adapter workflows (for example `ADAPTER_shell_smoke`), gate resolution is controlled by run-card field:

- `gate_resolution_mode: union` (default; safe-compatible)
  - effective gates = `run_card.required_gates ∪ policy floor ∪ CLI --gate`
- `gate_resolution_mode: policy_only`
  - effective gates = `policy floor ∪ CLI --gate`
  - ignores `run_card.required_gates`
- `gate_resolution_mode: run_card_only`
  - effective gates = `run_card.required_gates ∪ CLI --gate`
  - suppresses policy floor gates

Safety note:

- `run_card_only + required_gates=[]` emits a highlighted warning to stderr and records a trace entry indicating policy-floor suppression.
- `hepar run --strict-gate-resolution` upgrades this case to a hard error.

Auditability:

- Adapter `manifest.json` records both:
  - `gate_resolution_mode`
  - `gate_resolution_trace`
- Approval packets include a `## Gate resolution trace` section when approvals are requested.

`gate_resolution_trace` entry shape:

- `gate_id: string`
- `triggered_by: policy | run_card | both | workflow_default | cli_override`
- `reason: string`
- `timestamp_utc: date-time`

## 3) Overrides (explicit “full-auto”)

Recommended `approval_policy.json` modes:
- `safe` (default): A1–A5 require approval
- `interactive`: approve only A3/A4/A5; A1/A2 can auto-run within budget caps
- `full_auto`: auto-run as much as possible, but keep stop files and hard budgets

Even in `full_auto`, require explicit per-category opt-in to avoid “one toggle disables safety”:
- `full_auto.mass_search=true/false`
- `full_auto.code_changes=true/false`
- `full_auto.compute_runs=true/false`
- `full_auto.paper_edits=true/false`
- `full_auto.final_conclusions=true/false`

Even in `full_auto`, you must:
- log all bypassed gates (bypass logging)
- keep rollback mechanisms (`docs/EVAL_GATE_CONTRACT.md` / `docs/EVAL_GATE_CONTRACT.zh.md`)

“Constitutional protection” (recommended):
- Any change to core policy/contract files must enter a delay window (e.g. 24h) and require explicit human review. No `--force-immediate` bypass.
  - `specs/approval_policy.schema.json`
  - `docs/APPROVAL_GATES.md` / `docs/APPROVAL_GATES.zh.md`
  - `docs/EVAL_GATE_CONTRACT.md` / `docs/EVAL_GATE_CONTRACT.zh.md`
  - any `*_CONTRACT.md` / `*_GATES.md` policy files

## 4) Gates must be testable

Approval gates are not “real” unless they are validated by tests/evals:
- positive cases: must trigger when they should
- negative cases: must not trigger when they shouldn’t
- bypass attempts: batching/splitting/prompt injection must not bypass

Minimal test plan (early milestone exit criteria; can be scripted eval cases):

- General:
  - G0-1: every gate trigger appends to the run ledger (append-only)
  - G0-2: once a run starts, gate category boundaries are frozen (agents cannot redefine A1–A5 mid-run)

- A1 (mass search):
  - G1-1: predicted results > N (e.g. 100) triggers A1
  - G1-2: 10 split queries of “50 results” still trigger A1 by cumulative counting

- A2 (code changes):
  - G2-1: writing into `toolkit/` / `src/` / scripts triggers A2
  - G2-2: write elsewhere then move/copy must still trigger A2 (semantic write)

- A3 (heavy compute):
  - G3-1: predicted runtime/resources exceed threshold triggers A3 (threshold configurable)
  - G3-2: splitting a large job into many small jobs must still trigger A3 by cumulative budget

- A4 (paper edits):
  - G4-1: writing into `paper/` or user-specified LaTeX repo triggers A4

- A5 (final conclusions / novelty claims):
  - G5-1: novelty-language outputs must trigger A5 or be explicitly marked `UNVERIFIED`

- full_auto:
  - GA-1: full-auto must be per-category opt-in; non-opted-in categories still require approval
  - GA-2: any bypassed gate must be logged

Keep as always-on safety levers:
- stop files: `.stop` / `.pause`
- hard budgets: `max_runtime_minutes` / `max_network_calls`
- “audit slice first, then expand” tiered execution strategy
