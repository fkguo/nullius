---
name: qwen-cli-runner
description: Run the local `qwen` CLI (Qwen Code) in one-shot headless mode for arbitrary prompts; supports file-based system/user prompt inputs fed via stdin, batch-JSON result parsing, isolated default working directory, optional workspace exposure, retries, default-model fallback, and writing parsed assistant text to a target file.
---

# Qwen CLI Runner

Use this skill when you need to call the Qwen Code CLI from the command line without entering the TUI (review, drafting, synthesis, etc.).

> **If you are already running as Qwen Code, don't use this runner to re-invoke yourself.** Keep the
> call in-host. This runner is for reaching Qwen from a DIFFERENT host (Codex / OpenCode / Kimi / Gemini / …)
> for cross-model work. Pick the model by task difficulty (quality first, not token thrift).

## Preconditions

- `qwen` is installed: `command -v qwen`. The official package is `@qwen-code/qwen-code` and the executable is `qwen`.
- `python3` is version 3.10 or newer. Older runtimes are rejected before model invocation because the shared monotonic deadline must use the same clock reference across processes.
- You are authenticated/configured for Qwen Code. On Qwen Code >= 0.27 the `qwen auth` subcommand is removed: configure providers interactively via `/auth` inside `qwen`, or for CI/headless set provider environment variables (e.g. `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL`) or the CLI's own settings. This runner never reads or copies the credential store; authentication stays with the installed CLI configuration.

The exposed command interface was checked against local Qwen Code **0.27.4** (`qwen --help` plus the installed bundle's non-interactive executor) on 2026-11-16, re-verified after an upgrade from 0.13.1. This metadata check does not establish account readiness or successful inference. Headless mode uses:

```bash
qwen -o json --approval-mode plan --safe-mode < prompt.txt
```

Verified interface facts the runner relies on:

- Piped stdin text becomes the prompt in non-interactive mode (no positional query needed). The CLI caps stdin at **8 MiB** and truncates beyond it, so the runner refuses oversized inputs before exec instead of dispatching a silently truncated prompt.
- `-o json` prints **one JSON array** of CLI messages; the final `type:"result"` element carries `is_error`, `subtype` (`success` / `error_during_execution` / …), the final `result` text, `session_id` and usage. The runner parses this batch document — it is not JSONL.
- `--system-prompt` overrides the session system prompt for the run (official flag; the file content is passed as one argument).
- `--approval-mode plan` is analyze-only ("do not modify files or execute commands"). It is the runner default in isolated mode. Qwen Code >= 0.27 also offers `auto` (LLM-classified approval); the runner accepts it as an explicit override only.
- `--safe-mode` (Qwen Code >= 0.27) disables context files, hooks, extensions, skills and MCP servers, and clears hierarchical memory/context loading. It is the runner's isolation mechanism in isolated mode; `--no-safe-mode` opts out. Requires Qwen Code >= 0.27 — older CLIs reject the flag.
- Outside safe mode, `-e none` is the CLI's official disable-all-extensions sentinel (an empty `-e ""` no longer disables extensions on 0.27.x). Workspace mode passes `-e none` by default; `--allow-extensions` opts back into normal extension loading.

## Recommended: runner script

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/qwen-cli-runner" ] && echo "$r/skills/qwen-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_qwen.sh" \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

With an explicit model override and read/write workspace exposure:

```bash
bash "${SKILL_DIR}/scripts/run_qwen.sh" \
  --model qwen3-coder-plus \
  --tool-mode workspace \
  --workspace-dir /path/to/project \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Dry-run (no `qwen` call, no auth needed):

```bash
bash "${SKILL_DIR}/scripts/run_qwen.sh" \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```

## Safety notes

- Headless qwen is not a sandbox: with `--approval-mode default/auto-edit/auto/yolo` it can execute tools, and in a non-interactive run there is no human to answer approval prompts. Use non-plan modes only for tasks whose actions are already explicitly authorized.
- Default `--tool-mode isolated` runs qwen from a fresh temporary working directory, passes no `--include-directories`, uses `--approval-mode plan`, and passes the official `--safe-mode` flag — disabling context files (e.g. `QWEN.md`), hooks, extensions, skills and MCP servers. This reduces accidental repo exposure and ambient-instruction injection; it is still not an OS sandbox and does not prove qwen cannot access absolute paths. `--no-safe-mode` opts out (then `-e none` still disables extensions).
- `--tool-mode workspace` exposes each directory via the official `--include-directories` flag (defaults to the current cwd when no `--workspace-dir` is given), switches the default approval mode to `default`, and passes `-e none` (extensions off) unless `--allow-extensions` is set. It never passes `--safe-mode`, so workspace context files and user-level skills/MCP configuration apply. Workspace selection is explicit access, not a read-only guarantee and not an authorization grant.
- Authentication and model routing still come from the installed CLI's user-level configuration in both modes; `--safe-mode` disables customizations, not credentials.
- `--system-prompt-file` content is passed via `--system-prompt` as one CLI argument. Very large system prompts can hit OS argument limits; keep system instructions bounded (the user prompt goes via stdin and does not have this problem).

## Notes

- The runner writes only the final result text to `--out`. Tool calls, tool results, thinking blocks and message metadata are not represented in that output file; they remain in the raw attempt captures.
- Exit 0 requires a successful CLI exit AND a non-error `type:"result"` message with nonblank final text. Error results fail even when `qwen` exits 0. Interrupted text is retained as `OUT.partial`, never as a completed `OUT`.
- Every attempt's raw stdout/stderr and a budget receipt remain under `OUT.attempts/run.*` (override the parent with `--trace-dir DIR`). These files contain prompts and model output; keep them in an authorized private location outside the source repository.
- `--max-attempts` (alias `--max-retries`) caps all CLI calls in this invocation; retries and default-model fallback share the same budget. `--timeout-secs` is a total deadline (default 900; 0 explicitly disables it) including backoff. Timeout/cancellation terminate locally created CLI process groups and descendants; cancellation of a remote provider job is not attested.
- The runner defaults to `--model qwen4-max-preview`. Override with `--model ALIAS` for a different configured model. If the requested model fails with a model-not-found style error, the runner retries with the CLI's configured default model unless `--no-fallback` is set. Requested model aliases are recorded in the receipt; actual provider model identity remains unknown unless separately attested.
- Deterministic failures (usage/auth/region-ineligibility errors, exit codes 2/126/127, and similar, detected from the exit code and diagnostics) fail immediately with the diagnostic instead of burning the retry backoff; model-not-found keeps its default-model fallback. Quota wording inside a successful assistant body does not turn a completed result into an error.
- `--resume-session ID` resumes a specific recorded qwen session (`qwen -r ID`); the prompt becomes that session's next turn. It requires `--work-dir DIR` pointing at the prior run's working directory — qwen scopes recorded sessions per project directory, so the default fresh temporary directory has no sessions and the runner refuses the combination upfront. Continuation continues the same execution and does not count as independent review. Recency-based `--continue` is deliberately not exposed (racy across parallel runs).
- A failed attempt whose captured events show recorded tool activity (tool_use/tool_result) is never re-dispatched: re-running the identical prompt could duplicate side effects. The runner stops, keeps any recovered assistant text as `OUT.partial`, and leaves continuation to an explicit `--resume-session` decision. Retries remain available for failures without tool evidence.
- No output artifact (`--out`, `OUT.partial`, `--raw-out`, `--stderr-out`) may alias the prompt or system-prompt file; the runner refuses such paths before dispatch.
- `--max-session-turns N` passes the CLI's own session-turn cap for bounded agentic tasks.
- Use `--dry-run` for offline validation. It prints paths, sizes, hashes and the planned invocation, but never the prompt content.
- A completed invocation is not scientific acceptance; a parseable review does not establish substantive correctness.

## Exit Codes

- `0`: Completed nonblank final text, clean execution, non-error result message
- `1` (or the CLI's own code): Run failed after retry/fallback policy
- `2`: Invalid arguments or missing prerequisites/files
- `11`: Error result/event reported by the CLI
- `12`: No usable final text
- `13`: Deterministic output-shape failure (not retried)
- `124`/`125`: Total deadline / call budget exhausted

## Review-Swarm Compatibility

`run_qwen.sh` mirrors the file-based runner interface used by other swarm runners (`--model`, `--system-prompt-file`, `--prompt-file`, `--out`, `--dry-run`). Like `dsh-cli-runner`, it is independently usable and catalog-registered; adding it to a skill catalog does not register it as a review-swarm backend or install it into a running host.