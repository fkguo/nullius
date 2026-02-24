# evals/

This directory contains the regression evaluation suite.

Recommended layout:
- `evals/cases/<CASE_ID>/case.json`: single eval case config (schema: `specs/eval_case.schema.json`)
- `evals/README.md`: how to run the eval suite and interpret results

Notes:
- An eval case is only a “spec + acceptance criteria”; execution entrypoints (Orchestrator/scripts/CI) can be added later.
