# Reviewer output contract (strict)

- First line exactly: `VERDICT: READY` or `VERDICT: NOT_READY`
- Required Markdown headers (exact):
  - `## Blockers`
  - `## High-severity`
  - `## Non-blocking`
  - `## Real-research fit`
  - `## Robustness & safety`
  - `## Specific patch suggestions`
- `READY` allowed only if Blockers is empty and acceptance criteria are met.

