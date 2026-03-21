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

## Contract checking (informational)

`--check-review-contract` validates output format compliance and records results in `meta.json`.
**Contract failures are informational only** — they never trigger fallback. Content matters more than format.

If you want models to output a specific format, include format instructions in your system/user prompt.

Standalone checker:

```bash
python3 scripts/bin/check_review_output_contract.py /tmp/dual_review/claude_output.md
```

Contract auto-detects output format:
- **Markdown**: `VERDICT: READY/NOT_READY` first line + required headers (`## Blockers`, etc.)
- **JSON**: Valid JSON object with `blocking_issues` (array), `verdict` (`PASS`/`FAIL`), `summary`

JSON outputs wrapped in markdown code fences (`` ```json ... ``` ``) are automatically unwrapped.

## Outputs

- `{out-dir}/agent_*_*.txt` (or backend output override paths)
- `{out-dir}/trace.jsonl`
- `{out-dir}/meta.json`

## Runner parity notes

### System prompt delivery

All backends now receive the system prompt by default. However, the delivery mechanism differs:

| Runner | Delivery | True system role? |
|--------|----------|-------------------|
| claude-cli-runner | `--system-prompt` native arg | Yes |
| codex-cli-runner | Merged into stdin (`=== System Instructions ===` + `=== Task ===`) | No — prepended to user message |
| gemini-cli-runner | Concatenated into stdin (`system + \n\n + prompt`) | No — prepended to stdin |
| opencode-cli-runner | Concatenated into stdin (same as gemini) | No — prepended to stdin |

Only Claude CLI uses a true system role with elevated priority. The other three runners prepend the system prompt as a user-message prefix. This is a CLI limitation, not a bug.

### File access

| Runner | File access | Notes |
|--------|-------------|-------|
| Codex | `--sandbox read-only` | Can browse the codebase |
| Gemini | Default headless Gemini CLI mode | `--no-proxy-first` is always passed to ensure the local Gemini CLI path is used (not the generateContent API fallback); `--approval-mode plan` is now opt-in rather than the default |
| Claude | `--tools` parameter | Depends on configuration |
| OpenCode | Agent-dependent | Depends on agent configuration |

### Implications for review weight

- Codex reviews may reference specific files/lines thanks to sandbox access — treat as higher-confidence for implementation details.
- Gemini reviews now default to Gemini CLI's standard headless mode with clean `stdout`/`stderr` separation, and still can read local files in common review flows. `--approval-mode plan` remains available as an opt-in, but should not be assumed as the default review path.
- Claude reviews can be either, depending on `--tools` configuration.
- OpenCode reviews are prompt-only — stronger on high-level reasoning, weaker on code-level specifics.
- System prompt parity ensures all backends share the same review criteria (BLOCKING/HIGH/LOW taxonomy, output format).

## Skill name note

Use `review-swarm` as the canonical external name.
Use `review-swarm` consistently during migration and in new integrations.
