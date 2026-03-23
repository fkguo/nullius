# Eval gate contract

Evals are deterministic checks over project files and artifacts.
They exist to prevent silent regressions, weak review loops, and drift between claimed policy and actual behavior.

## Minimal expectations

- Keep exact tests for touched logic.
- Keep at least one higher-level smoke or integration check for each critical workflow entrypoint.
- Treat bypass attempts as first-class failures, not as edge cases.

## Working rule

- If a change weakens a gate, the change must explain why and add coverage for the new boundary.
- If a change adds a new project surface or template, add an anti-drift check so the authority cannot split again.
- A green diff is not enough; the gated behavior must remain reproducible from the checked-in tests.
