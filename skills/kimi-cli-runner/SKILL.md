---
name: kimi-cli-runner
description: Run the local `kimi` CLI (Kimi Code) in non-interactive prompt mode for arbitrary prompts; supports file-based system/user prompt inputs, isolated default working directory, optional workspace exposure, retries, model fallback, and writing parsed assistant text to a target file.
---

# Kimi CLI Runner

Use this skill when you need to call Kimi Code CLI from the command line without entering the TUI.

> **If you are already running as Kimi, don't use this runner to re-invoke yourself.** Keep the call
> in-host when available. This runner is for reaching Kimi from a different host (Codex / Claude /
> OpenCode / etc.) for cross-model review, drafting, or synthesis.

## Preconditions

- `kimi` is installed: `command -v kimi`
- You are authenticated/configured for Kimi Code CLI. First-time setup is usually `kimi login` or `/login` inside the TUI.
- The official package is `@moonshot-ai/kimi-code` and the executable is `kimi`.

This runner was checked against the official Kimi Code docs and `@moonshot-ai/kimi-code@0.20.1` (`latest` on npm on 2026-06-27). Current Kimi Code prompt mode uses:

```bash
kimi -p "prompt text" --output-format stream-json
```

Kimi Code currently exposes `-p, --prompt <prompt>` for headless prompt mode. It does **not** expose a `--prompt-file` or stdin prompt flag, so the runner keeps a file-based interface but must pass the merged prompt as one CLI argument internally. Very large prompt packets can exceed OS argument limits; the script fails early with a clear message when the merged prompt is over the configured limit.

## Recommended: runner script

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/kimi-cli-runner" ] && echo "$r/skills/kimi-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_kimi.sh" \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

With an explicit model and read/write workspace exposure:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/kimi-cli-runner" ] && echo "$r/skills/kimi-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_kimi.sh" \
  --model kimi-code/kimi-for-coding \
  --tool-mode workspace \
  --workspace-dir /path/to/project \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Dry-run:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/kimi-cli-runner" ] && echo "$r/skills/kimi-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_kimi.sh" \
  --model kimi-code/kimi-for-coding \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```

## Safety notes

- Kimi Code prompt mode rejects `--plan`, `--auto`, and `--yolo` combined with `--prompt`.
- In Kimi Code 0.20.1 source, prompt mode creates the session with `permission: "auto"` and installs a headless approval handler that approves actions.
- Kimi prompt mode is not a sandbox: it can run tools with automatic approval. Use this runner only with trusted prompts or in an external disposable environment.
- To reduce accidental repo exposure, this runner defaults to `--tool-mode isolated`, which runs `kimi -p` from a temporary isolated working directory and passes no `--add-dir`.
- By default, the runner also passes an empty temporary `--skills-dir`, which prevents Kimi from auto-discovering user/project skills during isolated runs.
- Use `--tool-mode workspace` only when Kimi should see a real project. That mode still runs from a temporary working directory but passes each workspace with Kimi's official `--add-dir DIR`.
- `--tool-mode isolated` reduces accidental exposure; it is not an OS sandbox and does not prove Kimi cannot access absolute paths or run shell commands.
- `--tool-mode workspace` is explicit workspace access, not a read-only guarantee. Use it only with prompts that are allowed to read or modify that workspace.

## Notes

- The runner defaults to `--output-format stream-json` and writes only assistant text content to `--out`; tool calls, tool results, metadata, and non-text assistant blocks are not represented in that output file.
- Tool result and metadata events are ignored in parsed output.
- Kimi Code may spend a long time in thinking or tool-use before emitting final assistant text. For reviewer / verification use, prefer a generous per-attempt timeout (the runner default is 900 seconds) and pass `--raw-out` plus `--stderr-out` when you need an auditable trace of tool calls, provider warnings, or partial output.
- If a specific `--model` fails with a model-not-found style error, the runner retries with Kimi's configured default model unless `--no-fallback` is set.
- Retry behavior uses `--max-attempts` and `--sleep-secs`.
- The merged prompt limit defaults to a conservative OS-argument-safe value. Override with `KIMI_MAX_PROMPT_BYTES` when you know your platform can accept larger prompt arguments.
- Repeat `--skills-dir DIR` to pass Kimi Code skill directories through to the run. Per official Kimi docs, specifying this flag replaces auto-discovered user and project skill directories.
- Pass `--auto-skills` only when you intentionally want Kimi to auto-discover user/project skills; it is mutually exclusive with explicit `--skills-dir`.
- Use `kimi provider list --json` to inspect the model aliases configured on the current machine before setting `--model`.
- Use `--dry-run` for offline validation. It prints paths, sizes, hashes, and planned flags, but never prints the full prompt.

## Headless approval and session continuation

- `--yolo` — pass Kimi `-y` (auto-approve all actions). Needed for headless agentic tasks whose
  tool actions would otherwise wait for an interactive approval and stall the run.
- `--resume-session ID` — resume a specific recorded Kimi session (`kimi -S ID`); the prompt
  becomes that session's next turn. **The id REQUIRES the `session_` prefix** (live-caught: a bare
  UUID fails with `Session ... not found`; `session_<uuid>` resumed correctly). Discover ids in
  `~/.kimi-code/session_index.jsonl` (field `sessionId`) or under
  `~/.kimi-code/sessions/wd_<dir-hash>/session_<uuid>/`.
- `--continue-work-dir` — continue the previous session OF THE WORKING DIRECTORY (`kimi -c`). Kimi
  scopes `-c` per working directory — confirmed both by the CLI help and by the on-disk
  `sessions/wd_<dir-hash>/` layout — so this is non-racy across parallel runs in different
  directories. Requires `--work-dir DIR` pointing at the prior run's directory (the runner's
  default isolated fresh temp dir has no previous session): run 1 with `--work-dir D`, run 2 with
  `--work-dir D --continue-work-dir`.

Both continuation forms are live-validated END-TO-END: a fact planted in run 1 was recalled by the
`--continue-work-dir` run and again by the `--resume-session session_<uuid>` run.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--model MODEL` | Kimi config default | Configured model alias for this invocation |
| `--system-prompt-file FILE` | none | Optional system instructions, prepended to the user prompt |
| `--prompt-file FILE` | required | User prompt file |
| `--out PATH` | required | Parsed assistant text output file |
| `--tool-mode MODE` | `isolated` | `isolated` or `workspace`; `none` is accepted as a legacy alias for `isolated` |
| `--workspace-dir DIR`, `--add-dir DIR` | current cwd in workspace mode | Repeatable directory exposed via Kimi `--add-dir`; requires `--tool-mode workspace` |
| `--work-dir DIR` | temp dir | Session working directory for `kimi -p`; advanced |
| `--skills-dir DIR` | empty temp dir | Repeatable Kimi Code skills directory |
| `--auto-skills` | off | Do not pass `--skills-dir`; allow Kimi auto-discovery; mutually exclusive with `--skills-dir` |
| `--kimi-bin PATH` | `kimi` | Kimi executable path |
| `--max-attempts N` | 3 | Attempts per run mode |
| `--max-retries N` | 3 | Deprecated alias for `--max-attempts` |
| `--sleep-secs S` | 5 | Base exponential backoff |
| `--timeout-secs S` | 900 | Per-attempt hard timeout for the Kimi subprocess; 0 disables timeout |
| `--raw-out FILE` | none | Copy raw Kimi stdout from the last attempt to this file for audit/debugging |
| `--stderr-out FILE` | none | Copy raw Kimi stderr from the last attempt to this file for audit/debugging |
| `--no-fallback` | off | Do not retry without `--model` after model-not-found errors |
| `--yolo` | off | Pass Kimi `-y` (auto-approve all actions) for headless agentic tasks |
| `--resume-session ID` | (none) | Resume a specific recorded Kimi session (`kimi -S ID`) |
| `--continue-work-dir` | off | Continue the working directory's previous session (`kimi -c`; requires `--work-dir`) |
| `--dry-run` | off | Print planned invocation without calling Kimi |
