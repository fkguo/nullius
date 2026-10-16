# Review swarm: fallback, outage handling and prompt-size guardrail

## Fallback policy

Fallback can be enabled for explicitly chosen target backends:

- `--fallback-mode off` (default)
- `--fallback-mode ask` (exit code `4`, asks for rerun decision)
- `--fallback-mode auto` (tries `--fallback-order`, default `codex,claude`)
- `--fallback-target-backends a,b` — **required whenever fallback is enabled**.
  There is no default target list: enabling `ask`/`auto` without naming targets
  is an input error, so a substitute reviewer can never be swapped in for a
  backend you did not explicitly nominate.

Example:

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/system.md \
  --prompt /path/to/prompt.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-target-backends gemini \
  --fallback-order codex,claude
```

## Backend outage handling (retry + availability report)

Backend infrastructure failures are classified and handled distinctly from
review content, so a degraded run is legible as "backend down" rather than
mistaken for reviewer disagreement:

- Every agent result carries a `failure_class`: `infrastructure` (timeout,
  crash exit, empty output — the backend never delivered reviewable content) or
  `content` (the backend answered but the answer failed a protocol check, e.g.
  an invalid two-phase criteria block). Successes carry `null`.
- `--retry-empty-output N` (default `0` — disabled, so existing callers of the
  launcher keep their behavior; `review_one.py` passes `1` explicitly for its
  delegated run): an agent whose runner exited 0 but wrote an empty output file
  is re-run at the orchestrator level up to N times — before fallback is
  considered and before the agent is recorded as `empty_output`. Retried agents
  record `empty_output_retries` in `meta.json`. In two-phase mode a phase-1
  empty output (`phase1_empty_output`) is classified infrastructure but is NOT
  auto-retried by this flag, and `--two-phase` rejects fallback — recover it
  with a manual same-model rerun (see the two-phase section).
- Empty-output retries and outer fallback stop when the seat's attempt cap or deadline is exhausted. Failure reasons `attempt_budget_exhausted` and `deadline_exhausted` record this limit separately from content disagreement.
- `meta.json` always includes `unavailable_backends`: the requested model specs
  whose runs ALL failed at the infrastructure level this invocation (a
  fallback-recovered run counts by its original failure). Read entries there as
  backend outages; never fold them into a review verdict.

## Prompt-size guardrail (optional)

- `--max-prompt-bytes N` or `--max-prompt-chars N`
- `--max-prompt-overflow fail|truncate`

When enabled, guardrails apply to global inputs and backend override inputs.
