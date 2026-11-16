---
name: opencode-cli-runner
description: Run the local `opencode` CLI in one-shot mode for arbitrary prompts; supports file-based system/user prompts, JSON event parsing into plain text output, and safe fallback to the CLI default model when a model alias is unavailable.
---

# OpenCode CLI Runner

Use this skill when you need to invoke `opencode` from shell scripts (review, drafting, synthesis, etc.) without entering TUI mode.

> **If you are already running as OpenCode, don't use this runner to re-invoke yourself.** Keep the call
> in-host: OpenCode's native subagents, else inline in your own loop. The `opencode` CLI hop adds latency,
> a separate session, and context loss for zero gain. This runner is for reaching OpenCode from a
> DIFFERENT host (Claude / Codex / …) for cross-model work. Pick the model / reasoning depth by task
> difficulty (quality first, not token thrift).

## Preconditions

- `opencode` is installed: `command -v opencode`
- `python3` is version 3.10 or newer. Older runtimes are rejected before model invocation because the shared monotonic deadline must use the same reference across processes.
- You are authenticated/configured for your target model provider in OpenCode.

The runner uses the first `opencode` on `PATH`. Its `run` and `serve` options were checked with OpenCode 1.18.18 and 1.19.5. Model aliases can change their upstream routing; preserve the requested alias and require provider evidence for an exact executed-model claim. [OpenCode CLI reference](https://opencode.ai/docs/cli/)

## Recommended: runner script (JSON parsing + fallback + retries)

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/opencode-cli-runner" ] && echo "$r/skills/opencode-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_opencode.sh" \
  --model openai/gpt-5 \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Dry-run (no `opencode` call):

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/opencode-cli-runner" ] && echo "$r/skills/opencode-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_opencode.sh" \
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
  - Use `--tool-mode workspace` to expose a workspace via `--workspace-dir DIR` (defaults to the current cwd). This sets `opencode run --dir DIR`. Keep required inputs inside that directory; external-directory access can be rejected by the configured permissions. Permission refusal is distinct from a provider failure and must not trigger an identical retry.
  - `--skip-permissions` adds the current exposed `opencode run --auto` flag. Use it only for actions already explicitly authorized; workspace selection alone is not an authorization grant.
  - For a file deliverable: have the agent WRITE it to a file in DIR and read that file back (do not rely on stdout capture), and prefer INCREMENTAL writes (append each finding as it is established) so a token-cut run still leaves partial results on disk.
- **Reasoning-heavy models can exhaust the PER-RESPONSE output/reasoning token cap** before emitting any text or writing any file — the last JSON `step_finish` event carries `reason:"length"` (observed: a hard review burned >30k reasoning tokens in a single step and died silently; the symptom is again `No text events found`, NOT a model failure). The runner now auto-continues such cuts: `--continue-on-length N` (default 2) resumes the SAME session via `opencode run -s <sessionID>` — the headless analog of an interactive "continue". Mitigate at the prompt level too: scope the task tightly (a few named focus points) and ask for terse output.
- `--start-server` is useful when repeated one-shot runs would otherwise keep paying OpenCode backend/MCP cold-start costs; it follows the official `serve` + `run --attach` pattern.
- The runner parses JSON events and writes only assistant text (`type=text`) to `--out`.
- The runner treats JSON `type=error` events as failures even when `opencode` exits with code `0`.
- If a response includes any `type=error` event, partial text chunks are not emitted to `--out`.
- Blank text, nonzero exit, explicit errors, and a final `reason:length` cannot produce a completed `--out`. Usable interrupted text is retained as `OUT.partial`; raw events and diagnostics for every call are retained under `OUT.attempts/run.*` (override the parent with `--trace-dir DIR`). A parseable review or completed invocation does not establish substantive acceptance.
- If a specific `--model` fails with model-not-found, the runner can retry with OpenCode's default model by omitting `-m` (disable with `--no-fallback`).
- `--max-attempts` (alias `--max-retries`) is a total CLI run-call cap: continuations, retries and model fallback share it. `--continue-on-length N` is an additional continuation ceiling, never extra calls beyond the total cap. `--timeout-secs` is a total deadline (default 900; 0 explicitly disables it), including startup and backoff. Timeout/cancellation terminate locally created process groups and descendants; cancellation of remote server/provider jobs is not attested by this local cleanup.
- Each call has a budget receipt with its requested model. Actual provider model identity remains unknown unless independently attested; a configured alias or default-model fallback is not an exact model-version claim.
- Deterministic failures (usage/auth/region-ineligibility errors and similar, detected from the runner's error/stderr diagnostics) fail immediately with the diagnostic instead of burning the retry backoff; model-not-found keeps its default-model fallback.
- Guardrails: `--model` must use `provider/model`, `--max-attempts` must be `1..20`, and `--sleep-secs` must be `1..300`.
- Current OpenCode `run` mode does not expose a built-in read-only tool allowlist like Claude/Gemini. `--tool-mode workspace` is explicit workspace access, not a hard no-mutation guarantee by itself.

## Exit Codes

- `0`: Completed nonblank output, clean execution, no error event or final length truncation
- `1`: Run failed after retry/fallback policy
- `2`: Invalid arguments or missing prerequisites/files

Quota exhaustion, usage/auth failures and deterministic permission refusals stop without an identical retry. Preserve their diagnostics separately from transient rate limiting, empty output, length truncation and timeout.

## Review-Swarm Compatibility

`run_opencode.sh` mirrors the file-based runner interface used by other swarm runners:

- `--model`
- `--system-prompt-file` (optional)
- `--prompt-file`
- `--out`
- `--dry-run`

This keeps future `review-swarm` integration low-friction.
