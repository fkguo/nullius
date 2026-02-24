---
name: auto-relay
description: Use when orchestrating multi-task work across sessions with auditable state, automatic handoff prompt generation, and profile-driven project configuration.
---

# Auto Relay

`auto-relay` is a general skill for cross-session task orchestration. It does not bind to a specific repository or schema; all project differences are injected by profile.

## Capabilities

- Reads tracker/board/queue state from a profile.
- Runs one task through a strict state machine:
  `IDLE -> PREFLIGHT -> EXECUTE -> VERIFY -> REVIEW -> SYNC -> HANDOFF`.
- Generates `next_prompt.md` for relay handoff.
- Selects model per next task via optional `model_routing` rules and writes selection to prompt/payload.
- Attempts automatic next-session launch when a launcher is configured.
- Degrades safely to one-click launch command + handoff payload when launcher is unavailable.
- Degrades unsupported review strategies to `stub` instead of hard-blocking.
- Supports configurable retries for EXECUTE/VERIFY transient failures.
- Stops on blocker and emits minimal human decision request (`blocker_report.json`).
- Supports `resume` from saved state.

## Files

- `scripts/relay.py`: main orchestrator
- `templates/next_prompt.md.j2`: handoff prompt template
- `schemas/profile.schema.json`: profile schema
- `examples/profile.example.yaml`: reusable sample profile
- `tests/test_auto_relay.py`: unit/integration tests

## Modes

- `plan`: parse status + generate `next_prompt.md` only
- `run`: execute tasks with automatic handoff logic
- `resume`: continue from `relay_state.json`
- `dry-run`: simulate state machine, no external side effects
- `handoff-only`: emit handoff command/payload only

## Run

```bash
python scripts/relay.py --profile /path/to/profile.yaml --mode plan --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode run --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode resume --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode dry-run --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode handoff-only --state-dir /tmp/relay
```

## Required Artifacts

Each run writes to `--state-dir`:

- `relay_state.json`
- `relay_trace.jsonl`
- `next_prompt.md`
- `handoff_payload.json`
- `verification_log.txt`
- `review_meta.json`
- `blocker_report.json` (only when blocked)

## Fail-safe Contract

- Any unrecoverable failure enters `BLOCKED`.
- Relay stops immediately and writes `blocker_report.json`.
- Report always includes `minimal_decision_request` with one clear question + options.

## Profile-Driven Boundary

General logic lives in `scripts/relay.py`; project specifics must stay in profile:

- `project_id`, `repos`
- `tracker`, `board`, `queue`
- `model_routing` (optional), `preferred_models` (optional)
- `gates`, `push_policy`
- `stop_conditions`, `output_contract`, `permissions`
