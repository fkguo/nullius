# Approval gates (A1-A5)

Default: require human approval before high-risk or high-cost actions.

## Categories

| Gate | Scope | Default policy |
|---|---|---|
| A1 | broad search / large discovery expansions | pause for approval |
| A2 | code or workflow logic changes | pause for approval |
| A3 | heavy compute / long-running jobs | pause for approval |
| A4 | manuscript or paper edits | pause for approval |
| A5 | final conclusions / novelty claims | pause for approval |

## Working rule

- Silence is never approval.
- Any pending approval must stay visible in project state until a human resolves it.
- High-risk actions should carry a short plan, expected outputs, and rollback notes before execution starts.

## Project note

If this project later adopts a looser policy, record the exact override in the project configuration and keep the default categories intact for auditability.
