# review-swarm (agent skill)

Runs clean-room, multi-backend review loops across Claude / Gemini / Codex /
OpenCode / Kimi with strict review-contract checks, a fallback policy, and
convergence gates. Use it to add reviewers from model families OTHER than the one
you run as — your own family reviews natively in-host; the swarm brings in the
other families so each reviewer is independent of you (see the host-aware
execution notes in `SKILL.md`). Do not list your own family in `--models`.

Designed to be driven by a tool-using agent; the commands below are what the agent
runs, and you can run them yourself for reproducibility and debugging.

## Requirements

- `python3` — the runner itself
- Runner skills for whichever backends you use, with their CLIs on `PATH`:
  - `claude-cli-runner` (for `claude/...` models)
  - `gemini-cli-runner` (for `gemini/...` models)
  - `codex-cli-runner` (for `codex/...` models)
  - `kimi-cli-runner` (for `kimi/...` models)
  - `opencode-cli-runner` (for the OpenCode backend)

## Quick start

Single reviewer, one command — no hand-written prompt files. A single reviewer
is one model family, so its verdict is **advisory only**; final verdicts require
cross-family review:

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --artifact /path/to/notes.md \
  --role correctness
```

Cross-family review with contract checking — list only families OTHER than your
own; your own family reviews natively in-host, the other families go through the
launcher (example driven from a Claude host: three non-Claude reviewers):

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/reviewer_system.md \
  --prompt /path/to/packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-review-contract
```

Per-reviewer outputs, the convergence check, and contract status land under `--out-dir`.

## Docs

- `SKILL.md` — canonical entrypoint, host-aware execution, the single-reviewer
  entry, backend/model selection, fallback + convergence gates, and the opt-in
  two-phase review protocol.

## Repository layout

- `scripts/bin/run_multi_task.py` — canonical multi-reviewer entrypoint
- `scripts/bin/review_one.py` — one-command single-reviewer entry (advisory)
- `templates/` — reviewer role system prompts + the user-packet skeleton
- `scripts/bin/review_contract.py`, `scripts/bin/check_review_output_contract.py` — review-contract checks
- `scripts/bin/smoke_run_multi_task_real.py` — real-backend smoke runner
- `tests/` — runner and contract tests
