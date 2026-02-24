---
name: review-swarm
description: Run clean-room multi-agent loops across Claude/Gemini/Codex/OpenCode with strict review-contract checks, fallback policy, and convergence gates.
---

# Review Swarm (multi-backend)

This skill provides a reusable clean-room swarm harness for independent reviewers/analysts.

Core capabilities:
- Run **N agents** with `run_multi_task.py`.
- Mix backends: OpenCode, Claude CLI, Codex CLI, Gemini CLI.
- Enforce strict review output contract (optional).
- Apply fallback policy when a target backend fails/returns invalid output.
- Record deterministic artifacts (`trace.jsonl`, `meta.json`, outputs).
- Gate on convergence (optional Jaccard similarity).

## Canonical entrypoint

Use `scripts/bin/run_multi_task.py` for all new workflows.

Primary public skill name: `review-swarm`.
Use `review-swarm` consistently in documentation and automation references.

`run_dual_task.py` is **deprecated** and now a compatibility forwarding shim to `run_multi_task.py`.
It is kept only for existing callers and legacy argument compatibility.

## Requirements

Install runner skills for any backends you plan to use:
- `opencode-cli-runner` (for OpenCode backend)
- `claude-cli-runner` (for `claude/...` models)
- `codex-cli-runner` (for `codex/...` models)
- `gemini-cli-runner` (for `gemini/...` models)

CLIs should be available in `PATH` according to the chosen backends.

## Quick start (multi-agent)

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/multi_review \
  --system /path/to/system.md \
  --prompt /path/to/task.md \
  --agents 3
```

## Quick start (dual review: Claude + Gemini)

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/dual_review \
  --system /path/to/reviewer_system_claude.md \
  --prompt /path/to/packet.md \
  --models claude/default,gemini/default \
  --backend-prompt gemini=/path/to/gemini_prompt.txt \
  --backend-system gemini=none \
  --backend-output claude=claude_output.md \
  --backend-output gemini=gemini_output.md \
  --check-review-contract
```

## Backend overrides

`run_multi_task.py` supports per-backend overrides:
- `--backend-prompt backend=/path/to/prompt`
- `--backend-prompt @/path/to/overrides.json` (batch mode)
- `--backend-system backend=/path/to/system` or `backend=none`
- `--backend-output backend=relative_or_absolute_path`

Notes:
- These flags are repeatable.
- `--backend-prompt @json` supports:
  - shorthand prompt map: `{"gemini": "/path/to/gemini_prompt.txt"}`
  - batch object: `{"prompt": {...}, "system": {...}, "output": {...}}`
- Relative `--backend-output` paths are resolved under `--out-dir`.
- `claude=none` for `--backend-system` is rejected (Claude runner requires a system prompt file).
- For a single run, `--backend-output` does not allow one path for repeated same-backend agents (to avoid output clobbering).

## Model selection

- `--agents N`: rotate through available OpenCode config models.
- `--models a,b,c`: explicit model specs.
- `--model default`: one OpenCode agent, CLI default model.
- Mixed backends supported: `claude/...`, `codex/...`, `gemini/...`, OpenCode `provider/model`.

### Default-model policy (hard rule)

When model is omitted or set to `default`, **do not inject historical model names**.
Always delegate to each backend CLI's configured default model.

This rule applies to all backends:
- OpenCode
- Claude CLI
- Codex CLI
- Gemini CLI

## Fallback policy

Fallback can be enabled for target backends (default target: `gemini`):

- `--fallback-mode off` (default)
- `--fallback-mode ask` (exit code `4`, asks for rerun decision)
- `--fallback-mode auto` (tries `--fallback-order`, default `codex,claude`)

Example:

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/dual_review \
  --system /path/to/system.md \
  --prompt /path/to/prompt.md \
  --models claude/default,gemini/default \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-order codex,claude
```

## Prompt-size guardrail (optional)

- `--max-prompt-bytes N` or `--max-prompt-chars N`
- `--max-prompt-overflow fail|truncate`

When enabled, guardrails apply to global inputs and backend override inputs.

## Convergence check

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/multi_review \
  --system /path/to/system.md \
  --prompt /path/to/task.md \
  --models claude/opus,gemini/default \
  --check-convergence \
  --convergence-threshold 0.8
```

## Project config

Place `meta/review-swarm.json` in the git root to set project-wide defaults.
Auto-discovered from CWD (walks up to git root, checks `meta/review-swarm.json`).

```json
{
  "models": "codex/gpt-5.3-codex,gemini/gemini-3.1-pro-preview",
  "fallback_mode": "auto",
  "fallback_order": "codex,claude",
  "check_review_contract": true,
  "backend_system": { "gemini": "none" }
}
```

- CLI args always override config values.
- Use `--config /path/to/file.json` for an explicit config path.
- Set `REVIEW_SWARM_NO_AUTO_CONFIG=1` to disable auto-discovery.

Supported config keys: `models`, `model`, `agents`, `output_prefix`, `fallback_mode`,
`fallback_order`, `fallback_target_backends`, `fallback_codex_model`, `fallback_claude_model`,
`check_review_contract`, `check_convergence`, `convergence_threshold`, `max_prompt_bytes`,
`max_prompt_chars`, `max_prompt_overflow`, `gemini_cli_home`, `backend_system`,
`backend_prompt`, `backend_output`.

## Standalone contract checker

```bash
python3 scripts/bin/check_review_output_contract.py /tmp/dual_review/claude_output.md
```

## Outputs

- `{out-dir}/agent_*_*.txt` (or backend output override paths)
- `{out-dir}/trace.jsonl`
- `{out-dir}/meta.json`

## Skill name note

Use `review-swarm` as the canonical external name.
Use `review-swarm` consistently during migration and in new integrations.
