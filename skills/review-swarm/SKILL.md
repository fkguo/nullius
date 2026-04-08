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
  --backend-tool-mode claude=review \
  --backend-tool-mode gemini=review \
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
- `--backend-tool-mode backend=mode`
- `--timeout-secs N`

Notes:
- These flags are repeatable.
- `--backend-prompt @json` supports:
  - shorthand prompt map: `{"gemini": "/path/to/gemini_prompt.txt"}`
  - batch object: `{"prompt": {...}, "system": {...}, "output": {...}}`
- Relative `--backend-output` paths are resolved under `--out-dir`.
- `claude=none` for `--backend-system` is rejected (Claude runner requires a system prompt file).
- For a single run, `--backend-output` does not allow one path for repeated same-backend agents (to avoid output clobbering).
- `--timeout-secs` is a per-backend hard timeout. Default: `900` seconds. Use `0` to disable.
- `--backend-tool-mode` is explicit and backend-specific:
  - `claude=none|review`
  - `gemini=none|review`
  - `opencode=none|workspace`

## Reviewer Tool Modes

Default behavior is explicit:
- Claude, Gemini, and OpenCode now receive an explicit tool mode from `review-swarm`.
- The default mode is `none` for all three backends.
- Tool access must be opted into per backend with `--backend-tool-mode`.

Reviewer-safe modes:
- `claude=review`: maps to a read-only built-in tool profile (`Read,Glob,Grep`).
- `gemini=review`: maps to Gemini CLI `--approval-mode plan` plus local CLI execution (`--no-proxy-first`), sandboxing, and `--extensions none`, which is Gemini's read-only review path.
- When Gemini is in `review` mode and `--gemini-cli-home` was not explicitly set, `review-swarm` now synthesizes an isolated `GEMINI_CLI_HOME` under the run output directory and writes a minimal user settings file there (`mcpServers={}`, `mcp.allowed=[]`) to avoid inheriting reviewer-external user MCP state by default.
- Gemini `review` is a headless review path, not the same interaction mode as the Gemini TUI `/mcp` session. If this path emits MCP discovery noise or does not yield a usable source-grounded verdict on a large packet, prefer a same-model rerun with an embedded-source packet and `gemini=none` rather than assuming TUI MCP health guarantees headless review stability.

OpenCode caveat:
- `opencode=workspace` explicitly grants workspace visibility by passing `--workspace-dir`.
- For formal workspace reviews, prefer OpenCode's official headless-server flow (`opencode serve` + `opencode run --attach ...`) rather than relying only on repeated direct `run --dir ...` cold starts.
- Current `opencode run` CLI does not expose a built-in read-only tool allowlist comparable to Claude/Gemini, so `workspace` is explicit workspace access, not a hard no-mutation guarantee.
- For `opencode=workspace`, prefer workspace-relative file paths in prompts/packets. Large prompts that enumerate absolute workspace paths or globs can push the model into `external_directory` permission requests even when the repo itself is mounted as the workspace.
- Treat `OpenCode workspace` and `OpenCode embedded-source` as two different review roles:
  - `workspace`: packet-challenge / discovery reviewer. Best when blast radius or hidden front-door / consumer drift is still uncertain.
  - `none` + embedded-source packet: verdict-normalization / formal gate reviewer. Best when scope is already narrowed and you need a stable closeout artifact.
- Do not treat an OpenCode workspace pass as "failed" just because the output includes exploratory text or lacks a clean final JSON block. If it still contains source-grounded, current-worktree findings, keep that review signal and only rerun same-model to normalize the gate artifact.
- For formal reviewer use, prefer Claude/Gemini for source-grounded read-only review guarantees; treat OpenCode workspace mode as discovery-strong but gate-fragile, and reserve embedded-source OpenCode passes for final formal-verdict stabilization once packet scope is adequate.
- When packet scope touches public/package/CLI/workflow/default-entry surfaces, also follow the `Front-door Surface Audit` requirement in `AGENTS.md`; runner setup does not replace packet widening.

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
| Gemini | Default headless Gemini CLI mode | Review-safe tool access is opt-in via `--backend-tool-mode gemini=review` |
| Claude | `--tools` parameter | Review-safe tool access is opt-in via `--backend-tool-mode claude=review` |
| OpenCode | Workspace exposure is explicit | `--backend-tool-mode opencode=workspace` exposes the workspace, but not with a hard read-only allowlist |

### Implications for review weight

- Codex reviews may reference specific files/lines thanks to sandbox access — treat as higher-confidence for implementation details.
- Gemini reviews now default to standard headless mode unless review-safe tools are explicitly enabled.
- Claude reviews now default to no built-in tools unless review-safe tools are explicitly enabled.
- OpenCode reviews default to isolated, prompt-driven runs unless workspace access is explicitly enabled.
- System prompt parity ensures all backends share the same review criteria (BLOCKING/HIGH/LOW taxonomy, output format).

## Skill name note

Use `review-swarm` as the canonical external name.
Use `review-swarm` consistently during migration and in new integrations.
