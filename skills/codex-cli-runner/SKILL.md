---
name: codex-cli-runner
description: Run the local `codex` CLI (OpenAI Codex) in non-interactive mode (`codex exec`) for arbitrary prompts; supports file-based system+user prompts, retries with exponential backoff, and writing output to a target file.
---

# Codex CLI Runner

Use this skill when you need to call the OpenAI Codex agent from the command line (any task), independent of the downstream workflow (review, drafting, computation, etc.).

> **If you are already running as Codex, don't use this runner to re-invoke yourself.** Keep the call
> in-host: a native sub-agent if your host exposes one, else inline in your own loop. The `codex` CLI hop
> adds latency, a separate session, and context loss for zero gain. This runner is for reaching Codex from
> a DIFFERENT host (Claude / OpenCode / …) for cross-model work. Choose `model_reasoning_effort` by task
> difficulty (quality first, not token thrift) — hard tasks warrant `high`/`xhigh`.

## Preconditions

- `codex` is installed: `command -v codex`
- You are authenticated (run `codex login` if needed).
- The default model and provider are configured in `~/.codex/config.toml`.

## Recommended: runner script (retries + file inputs)

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/codex-cli-runner" ] && echo "$r/skills/codex-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_codex.sh" \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

With explicit model:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/codex-cli-runner" ] && echo "$r/skills/codex-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_codex.sh" \
  --model o3 \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

## Notes

- Uses `codex exec` (non-interactive mode) with `--sandbox read-only` (the safe default for review / text-generation tasks). Non-interactivity is pinned via `-c approval_policy="never"`.
- The runner intentionally does **not** pass codex's deprecated `--full-auto` flag: in codex ≥0.140 `--full-auto` implies `--sandbox workspace-write` and would silently override the read-only default, giving a reviewer write access. To allow writes, request the write sandbox explicitly with `--sandbox workspace-write`.
- System prompt + user prompt are merged and fed via stdin to avoid ARG_MAX limits with large prompt files.
- `--output-last-message` (`-o`) captures the agent's final response to the output file.
- **Danger: `--out` OVERWRITES its target on every invocation, including retries.** Never point `--out` at a file whose current content matters: a rerun or follow-up call that returns a short summary silently replaces whatever an earlier run wrote there (a real multi-hundred-line deliverable has been lost to a 13-line summary this way). Recommended pattern: have the prompt instruct the agent to write deliverables to their own separate files, and use `--out` only to collect the final summary message.
- `--skip-git-repo-check` is enabled by default so the runner works from any directory.
- Retries on failure with exponential backoff (useful for transient API errors).
- Deterministic failures (usage/auth/region-ineligibility errors, exit codes 2/126/127, and similar, detected from the exit code and the tail of the attempt log) fail immediately with the diagnostic instead of burning the retry backoff.
- For offline/CI validation, use `--dry-run` to print the planned invocation without calling Codex.

## Session continuation (multi-turn / crash recovery)

`codex exec` records every run as a session (a rollout file under `~/.codex/sessions`), and
`codex exec resume` continues one. The runner exposes this three ways (all live-validated):

- `--resume-session ID` — send this prompt as the NEXT turn of a named session. The explicit,
  non-racy form for chaining multi-turn workflows across runner invocations (each run's banner
  prints `session id: <uuid>`; capture it from your log).
- `--resume-last` — resume the most recently STARTED session, resolved from the session-start
  timestamp embedded in the rollout FILENAME (deliberately NOT the file mtime — mtimes get
  refreshed by unrelated touches and were observed live to select the wrong session). Still RACY if
  other codex runs start sessions concurrently; prefer `--resume-session ID` in parallel workflows.
- `--resume-on-retry` — opt-in crash recovery: when an attempt fails, the runner extracts THIS
  run's session id from the codex banner, and every subsequent retry RESUMES that session with a
  short auto-continue prompt instead of restarting the whole task from scratch — a long run keeps
  its partial progress across transient failures. Falls back to the normal fresh restart when no
  id was captured.

Caveats: the `resume` subcommand does not accept `--sandbox` or `--profile` — the runner preserves
the sandbox via the equivalent `-c sandbox_mode="..."` config override and DROPS a `--profile` with
a warning. A resumed turn appends to the session permanently; do not resume clean-room review
sessions whose independence you need to preserve.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--model MODEL` | (from config.toml) | Model override (e.g. `o3`, `gpt-4.1`) |
| `--system-prompt-file FILE` | (none) | Optional system instructions file |
| `--prompt-file FILE` | **required** | User prompt file |
| `--out PATH` | **required** | Output file for agent's last message (**overwritten on every invocation** — see Notes; keep deliverables in separate files) |
| `--sandbox MODE` | `read-only` | Sandbox policy: `read-only`, `workspace-write`, `danger-full-access` |
| `--profile PROFILE` | (none) | Config profile from config.toml |
| `--config KEY=VALUE` | (none) | Repeatable `-c` overrides for config.toml values |
| `--skip-git-repo-check` | enabled | Run outside git repos (disable with `--no-skip-git-repo-check`) |
| `--max-retries N` | 6 | Maximum retry attempts |
| `--sleep-secs S` | 10 | Base sleep for exponential backoff |
| `--resume-session ID` | (none) | Send the prompt as the next turn of a named codex session |
| `--resume-last` | off | Resume the most recently started session (filename-timestamp resolution; racy under concurrency) |
| `--resume-on-retry` | off | On a failed attempt, resume this run's own session on retries instead of restarting |
| `--dry-run` | off | Print planned command without executing |

## Dry-run example

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/codex-cli-runner" ] && echo "$r/skills/codex-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_codex.sh" \
  --model o3 \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```

## Sandbox modes

- `read-only` (default): Agent can read files but not modify them. Best for text generation, analysis, review. This default is enforced — the runner never sends `--full-auto`, so it is not silently upgraded to `workspace-write`.
- `workspace-write`: Agent can modify files in the working directory. Use for code generation tasks.
- `danger-full-access`: No restrictions. Use only in externally sandboxed environments.
