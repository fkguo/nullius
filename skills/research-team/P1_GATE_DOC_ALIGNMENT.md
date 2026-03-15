# P1 — Gate↔Docs Semantic Alignment Spot-Check

This file is a maintainer-facing checklist to keep documentation promises aligned with gate behavior and regression tests.

Contract reference: [FULL_VALIDATION_CONTRACT.md](FULL_VALIDATION_CONTRACT.md) (P1.1).

## Spot-check sample (>= 5 gates)

For each row:
- Docs: where the promise is made (human-facing)
- Gate: the implementation (deterministic)
- Tests: at least one deterministic test that shows both pass and fail behavior

| Gate (concept) | Docs | Gate implementation | Deterministic tests (pass+fail) |
|---|---|---|---|
| Reproducibility Capsule (mandatory) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_reproducibility_capsule.py](scripts/gates/check_reproducibility_capsule.py) | [smoke_test_capsule_gate.sh](scripts/dev/smoke/smoke_test_capsule_gate.sh) |
| Project Charter (goal drift prevention) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_project_charter.py](scripts/gates/check_project_charter.py) | [smoke_test_project_charter_gate.sh](scripts/dev/smoke/smoke_test_project_charter_gate.sh) |
| Knowledge layers (KB minimums) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_knowledge_layers.py](scripts/gates/check_knowledge_layers.py) | [smoke_test_knowledge_layers_gate.sh](scripts/dev/smoke/smoke_test_knowledge_layers_gate.sh) |
| Problem Framing Snapshot (research_preflight.md) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_problem_framing_snapshot.py](scripts/gates/check_problem_framing_snapshot.py) | [smoke_test_problem_framing_snapshot_gate.sh](scripts/dev/smoke/smoke_test_problem_framing_snapshot_gate.sh) |
| Toolkit profile DoD (toolkit_extraction) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_milestone_dod.py](scripts/gates/check_milestone_dod.py) | [smoke_test_toolkit_profile.sh](scripts/dev/smoke/smoke_test_toolkit_profile.sh) |
| References section (clickable + provenance) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_references_section.py](scripts/gates/check_references_section.py) | [smoke_test_references_gate.sh](scripts/dev/smoke/smoke_test_references_gate.sh) |
| Notebook integrity (math/link hygiene) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_notebook_integrity.py](scripts/gates/check_notebook_integrity.py) | [smoke_test_notebook_integrity_gate.sh](scripts/dev/smoke/smoke_test_notebook_integrity_gate.sh) |
| Markdown math hygiene (global scan) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_markdown_math_hygiene.py](scripts/gates/check_markdown_math_hygiene.py) | [smoke_test_markdown_math_hygiene_gate.sh](scripts/dev/smoke/smoke_test_markdown_math_hygiene_gate.sh) |
| Double-backslash math (global scan) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_double_backslash_math.py](scripts/gates/check_double_backslash_math.py) | [smoke_test_double_backslash_math_gate.sh](scripts/dev/smoke/smoke_test_double_backslash_math_gate.sh) |
| Pointer lint (code pointers) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_pointer_lint.py](scripts/gates/check_pointer_lint.py) | [smoke_test_pointer_lint_gate.sh](scripts/dev/smoke/smoke_test_pointer_lint_gate.sh) |
| Scan dependency (rules-file driven) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_scan_dependency.py](scripts/gates/check_scan_dependency.py) | [smoke_test_scan_dependency_gate.sh](scripts/dev/smoke/smoke_test_scan_dependency_gate.sh) |
| Branch completeness (multi-root contract) | [SKILL.md](SKILL.md), [RUNBOOK.md](RUNBOOK.md) | [check_branch_completeness.py](scripts/gates/check_branch_completeness.py) | [smoke_test_branch_completeness_gate.sh](scripts/dev/smoke/smoke_test_branch_completeness_gate.sh) |
| Team convergence (mandatory) | [SKILL.md](SKILL.md), [FULL_VALIDATION_CONTRACT.md](FULL_VALIDATION_CONTRACT.md), [RUNBOOK.md](RUNBOOK.md) | [check_team_convergence.py](scripts/gates/check_team_convergence.py) | [smoke_test_run_team_cycle_convergence_gate.sh](scripts/dev/smoke/smoke_test_run_team_cycle_convergence_gate.sh) |
| Sidecar warn-only (non-blocking) | [FULL_VALIDATION_CONTRACT.md](FULL_VALIDATION_CONTRACT.md), [RUNBOOK.md](RUNBOOK.md) | [run_team_cycle.sh](scripts/bin/run_team_cycle.sh) | [smoke_test_convergence_gate_sidecar.sh](scripts/dev/smoke/smoke_test_convergence_gate_sidecar.sh) |

## Notes for maintainers

- The tests above are the “evidence” that the doc promises are enforced deterministically.
- When adding or changing a gate:
  - update [RUNBOOK.md](RUNBOOK.md) with a “what failed / how to fix / rerun” entry
  - add a smoke test demonstrating both fail and pass (prefer local temp projects)
  - add/update at least one row in this table
