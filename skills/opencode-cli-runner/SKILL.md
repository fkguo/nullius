---
name: opencode-cli-runner
description: Run the local `opencode` CLI in one-shot mode for arbitrary prompts; supports file-based system/user prompts, JSON event parsing into plain text output, and safe fallback to the CLI default model when a model alias is unavailable.
---

# OpenCode CLI Runner

Use this skill when you need to invoke `opencode` from shell scripts (review, drafting, synthesis, etc.) without entering TUI mode.

## Preconditions

- `opencode` is installed: `command -v opencode`
- `python3` is available: `command -v python3`
- You are authenticated/configured for your target model provider in OpenCode.

## Recommended: runner script (JSON parsing + fallback + retries)

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/opencode-cli-runner/scripts/run_opencode.sh" \
  --model openai/gpt-5 \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Dry-run (no `opencode` call):

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/opencode-cli-runner/scripts/run_opencode.sh" \
  --model openai/gpt-5 \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```

## Notes

- The runner calls `opencode run --format json` and feeds prompt text via stdin, so large prompt files avoid shell argument-size limits.
- The runner supports OpenCode's official headless attach flow:
  - `--attach URL` passes through to `opencode run --attach URL`
  - `--start-server` starts a local `opencode serve` process and attaches the run to it
- If `--system-prompt-file` is provided, it is prepended to stdin before `--prompt-file` (separated by a blank line).
- Workspace visibility is now explicit:
  - Default is `--tool-mode none`, which runs OpenCode in an isolated temp directory.
  - Use `--tool-mode workspace` to expose a workspace via `--workspace-dir DIR` (defaults to the current cwd).
- `--start-server` is useful when repeated one-shot runs would otherwise keep paying OpenCode backend/MCP cold-start costs; it follows the official `serve` + `run --attach` pattern.
- The runner parses JSON events and writes only assistant text (`type=text`) to `--out`.
- The runner treats JSON `type=error` events as failures even when `opencode` exits with code `0`.
- If a response includes any `type=error` event, partial text chunks are not emitted to `--out`.
- If OpenCode exits non-zero but valid text events were extracted, the runner preserves that output and returns success.
- If a specific `--model` fails with model-not-found, the runner can retry with OpenCode's default model by omitting `-m` (disable with `--no-fallback`).
- Retry behavior uses `--max-attempts` (legacy alias: `--max-retries`) and `--sleep-secs`.
- Guardrails: `--model` must use `provider/model`, `--max-attempts` must be `1..20`, and `--sleep-secs` must be `1..300`.
- Current OpenCode `run` mode does not expose a built-in read-only tool allowlist like Claude/Gemini. `--tool-mode workspace` is explicit workspace access, not a hard no-mutation guarantee by itself.

## Exit Codes

- `0`: Success (including non-zero OpenCode exit when valid text output was extracted)
- `1`: Run failed after retry/fallback policy
- `2`: Invalid arguments or missing prerequisites/files

## Review-Swarm Compatibility

`run_opencode.sh` mirrors the file-based runner interface used by other swarm runners:

- `--model`
- `--system-prompt-file` (optional)
- `--prompt-file`
- `--out`
- `--dry-run`

This keeps future `review-swarm` integration low-friction.
