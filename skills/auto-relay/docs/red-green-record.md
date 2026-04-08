# RED -> GREEN Record

## Scope

Skill: `auto-relay`

Goal: general cross-session relay orchestration with profile-driven configuration.

## RED (failing baseline)

Command:

```bash
pytest -q tests/test_auto_relay.py | tee evidence/red/pytest_red.log
```

Result:

- `7 failed`
- Primary failure: missing orchestrator entrypoint `scripts/relay.py`

Evidence:

- `evidence/red/pytest_red.log`

## GREEN (implementation complete)

Command:

```bash
pytest -q tests/test_auto_relay.py | tee evidence/green/pytest_green.log
```

Result:

- `7 passed`
- Additional hardening pass kept all tests green (`7 passed`)
- Relaxed blocker policy pass kept all tests green (`18 passed`)

Evidence:

- `evidence/green/pytest_green.log`

## Fix Summary

Implemented:

- Profile-driven orchestrator: `scripts/relay.py`
- Prompt template: `templates/next_prompt.md.j2`
- Profile schema: `schemas/profile.schema.json`
- Profile template: `templates/profile.template.yaml`
- Skill docs: `SKILL.md`, `docs/auto-relay.md`
- Hardening updates:
  - `stop_conditions` observability fields in `blocker_report.json`
  - safer path permission checks (`is_relative_to`)
  - explicit `review_meta.fallback_reason == null` assertion
- Continuity updates:
  - HANDOFF `permission_denied` now degrades to manual handoff payload
  - unsupported `review.strategy` degrades to `stub` with audit metadata
  - `output_contract.strict=false` enables non-blocking missing-field warnings
  - configurable EXECUTE/VERIFY retries with exponential backoff

Validated behaviors:

1. queue order progression
2. milestone next prompt generation
3. blocker stop + minimal human decision request
4. resume continuation
5. board/tracker reconciliation
6. no-launcher degradation
7. audit artifact completeness
