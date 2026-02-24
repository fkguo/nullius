# Orchestrator state contract (persistence + recovery)

Goal: make `pause/resume/status/approve` **resumable, auditable, and rollbackable**, not dependent on chat memory.

This document defines the minimal state machine + persistence format + crash recovery semantics (M1 hard dependency).

Chinese version (legacy / detailed notes): `docs/ORCHESTRATOR_STATE.zh.md`.

## 1) Minimal persisted state (MVP)

Write under project root:
- `.autopilot/state.json`: current state (single file; debuggable; can later be replaced by sqlite)
- `.autopilot/ledger.jsonl`: append-only event ledger (every gate/execution/failure writes an event)

Ledger is for audit; `state.json` is for recovery.

## 2) Minimal state machine (MVP)

Suggested `run_status` enum:
- `idle`
- `running`
- `paused`
- `awaiting_approval`
- `completed`
- `failed`
- `needs_recovery`

Key transitions:
- `running -> awaiting_approval` (gate triggers)
- `awaiting_approval -> running` (approve)
- `awaiting_approval -> paused` (reject or manual pause)
- `running -> needs_recovery` (watchdog detects stale checkpoints / crash)
- `needs_recovery -> running|paused|failed` (human chooses)

## 3) `.autopilot/state.json` schema (v1)

Recommended minimal fields:

```json
{
  "schema_version": 1,
  "run_id": "M1-r1",
  "workflow_id": "W1_ingest",
  "run_status": "awaiting_approval",
  "current_step": {
    "step_id": "W1.S3",
    "title": "Expand literature search",
    "started_at": "2026-02-01T00:00:00Z"
  },
  "plan": {
    "schema_version": 1,
    "created_at": "2026-02-01T00:00:00Z",
    "updated_at": "2026-02-01T00:00:00Z",
    "run_id": "M1-r1",
    "workflow_id": "W1_ingest",
    "current_step_id": "W1.S3",
    "steps": [
      {
        "step_id": "W1.S3",
        "description": "Expand literature search",
        "status": "in_progress",
        "expected_approvals": ["A1"],
        "expected_outputs": ["artifacts/runs/M1-r1/ingest/<refkey>/manifest.json"],
        "recovery_notes": "",
        "started_at": "2026-02-01T00:00:00Z",
        "completed_at": null
      }
    ]
  },
  "plan_md_path": ".autopilot/plan.md",
  "checkpoints": {
    "last_checkpoint_at": "2026-02-01T00:00:00Z",
    "checkpoint_interval_seconds": 900
  },
  "pending_approval": {
    "approval_id": "A1-0003",
    "category": "A1",
    "requested_at": "2026-02-01T00:00:00Z",
    "timeout_at": "2026-02-02T00:00:00Z",
    "on_timeout": "block",
    "packet_path": "artifacts/runs/M1-r1/approvals/A1-0003/packet.md"
  },
  "budgets": {
    "max_network_calls": 200,
    "max_runtime_minutes": 60,
    "network_calls_used": 17,
    "runtime_minutes_used": 12
  },
  "artifacts": {
    "run_card": "artifacts/runs/M1-r1/run_card.json",
    "run_card_sha256": "<sha256>",
    "latest_manifest": "artifacts/runs/M1-r1/manifest.json",
    "latest_summary": "artifacts/runs/M1-r1/summary.json",
    "latest_analysis": "artifacts/runs/M1-r1/analysis.json"
  },
  "notes": "Human-readable status line"
}
```

Constraints:
- `state.json` must be written atomically (write temp file then `rename()`).
- Mutating commands should hold an advisory lock at `.autopilot/state.lock` to avoid concurrent write races (POSIX `flock`; on platforms without it, concurrent writers are unsupported).
- `packet_path` must point to a reviewable approval packet (see `docs/APPROVAL_GATES.md`).
- `plan` must conform to `specs/plan.schema.json` (SSOT), and `plan_md_path` is a deterministic derived view.
- `artifacts.run_card` must point to a per-run run-card (`artifacts/runs/<run_id>/run_card.json`), and `run_card_sha256` binds approvals/manifests to the intended execution (SHA256 of canonical JSON payload, not `sha256sum` of the on-disk pretty-printed bytes).

## 4) Timeout semantics (no “silence = approval”)

Every `pending_approval` must define `on_timeout` and satisfy:
- forbid `auto_approve`
- default `on_timeout = block` (remain awaiting approval, status shows “timed out”)
- optional future: `reject` / `escalate` (must be logged)

## 5) Crash recovery semantics (MVP)

On Orchestrator start:
- if `run_status == running` and `now - last_checkpoint_at > 2 * checkpoint_interval_seconds`:
  - automatically set `run_status = needs_recovery`
  - require a human to choose:
    - `resume` (continue from last checkpoint)
    - `pause` (remain paused)
    - `abort` (mark failed with reason)

Plan semantics:
- `current_step.step_id` MUST be a `plan.steps[*].step_id`.
- `plan.current_step_id` mirrors `current_step.step_id` (resume semantics are state-driven, not chat-driven).
- `plan_md_path` is derived (rewrite deterministically on each plan update).
- `plan.branching` (optional) records alternative approaches (“branch candidates”) for safe backtracking:
  - One active branch at a time: `plan.branching.active_branch_id`.
  - `plan.branching.active_branch_id` is a composite id: `"<decision_id>:<branch_id>"` (e.g., `"W2.S1:b3"`).
  - `branch_decision.active_branch_id` is the bare branch id within that decision (e.g., `"b3"`).
  - Cap branch explosion by default: `plan.branching.max_branches_per_decision = 5` (raising caps must be explicit and recorded in the Plan SSOT + ledger).

## 6) Ledger (append-only) minimal fields (v1)

Each event should include:
- `ts` (UTC)
- `event_type`: `run_started|step_started|step_completed|approval_requested|approval_approved|approval_rejected|paused|resumed|checkpoint|failed|recovered|branch_candidate_added|branch_switched`
- `run_id` / `workflow_id` / `step_id` (where applicable)
- `details` (small object: reason, budgets, artifact pointers, hashes)

Avoid large payloads in the ledger; keep large data in artifacts and reference them.
