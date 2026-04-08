# Auto Relay User Guide

## 1. Install / Layout

Place this skill at:

- `~/.codex/skills/auto-relay/`

Expected key files:

- `SKILL.md`
- `scripts/relay.py`
- `templates/next_prompt.md.j2`
- `schemas/profile.schema.json`
- `templates/profile.template.yaml`
- `tests/test_auto_relay.py`

## 2. Configure Profile

Start from:

- `templates/profile.template.yaml`

Profile is the only place for project differences. Core orchestrator logic remains generic.

Required top-level fields:

- `project_id`
- `repos`
- `tracker`
- `board`
- `queue`
- `gates`
- `push_policy`
- `stop_conditions`
- `output_contract`
- `permissions`

Optional tuning fields:

- `gates.command_retries.execute_max_retries`
- `gates.command_retries.verify_max_retries`
- `gates.command_retries.backoff_seconds`
- `output_contract.strict` (`true` by default)

## 3. Run Modes

```bash
python scripts/relay.py --profile /path/to/profile.yaml --mode plan --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode run --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode resume --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode dry-run --state-dir /tmp/relay
python scripts/relay.py --profile /path/to/profile.yaml --mode handoff-only --state-dir /tmp/relay
```

## 4. Output / Audit Artifacts

Per run (`--state-dir`):

- `relay_state.json`
- `relay_trace.jsonl`
- `next_prompt.md`
- `handoff_payload.json`
- `verification_log.txt`
- `review_meta.json`
- `blocker_report.json` (only on blocker)

`relay_trace.jsonl` can be replayed for post-mortem and timeline reconstruction.

## 5. Resume / Recovery

1. Inspect blocker or pending handoff:

```bash
cat /tmp/relay/relay_state.json
cat /tmp/relay/blocker_report.json
cat /tmp/relay/handoff_payload.json
```

2. Fix the external cause (permissions/commands/board/tracker/etc).
3. Continue:

```bash
python scripts/relay.py --profile /path/to/profile.yaml --mode resume --state-dir /tmp/relay
```

## 6. Session Handoff Strategy

Priority order:

1. Launcher available and succeeds: auto handoff.
2. Launcher missing/failing: degrade to one-click `launch_command` + `awaiting_launcher=true`.
3. Launcher command denied by `allow_commands`: degrade to manual handoff with `degraded_reason=launcher_permission_denied`.
4. Never silent-fail: always write degraded reason to `handoff_payload.json` and `relay_trace.jsonl`.

## 7. Troubleshooting

### YAML profile fails to parse

Install PyYAML:

```bash
pip install pyyaml
```

### Command blocked by permissions

Check:

- `permissions.allow_commands`
- `permissions.deny_commands`
- `permissions.allow_paths`
- `permissions.deny_paths`

### Verification failed

Inspect:

- `verification_log.txt`
- `blocker_report.json`

`blocker_report.json` now includes:

- `failure_count`
- `max_failures`
- `max_failures_exceeded` (`true` when `failure_count >= max_failures`)
- `requires_human_intervention` (driven by `stop_conditions.require_human_on`)

### Board/tracker mismatch

In `run/resume`, board is reconciled to tracker SSOT before continuing.

### Unsupported review strategy

Unknown `gates.review.strategy` no longer hard-blocks the run.
Relay degrades review to `stub`, records warning metadata in `review_meta.json`, and continues.

### Retry transient failures

Use `gates.command_retries`:

- `execute_max_retries`
- `verify_max_retries`
- `backoff_seconds` (exponential backoff base)

This applies to transient command failures in `EXECUTE` and `VERIFY`.

### Output contract strictness

`output_contract.strict` controls missing field behavior:

- `true` (default): missing required fields block in `SYNC`.
- `false`: missing required fields are logged to trace/history as non-blocking warnings.

## 8. Test

```bash
pytest -q tests/test_auto_relay.py
```

Evidence logs:

- RED: `evidence/red/pytest_red.log`
- GREEN: `evidence/green/pytest_green.log`
