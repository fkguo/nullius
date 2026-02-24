---
name: codex-cli-runner
description: Run the local `codex` CLI (OpenAI Codex) in non-interactive mode (`codex exec`) for arbitrary prompts; supports file-based system+user prompts, retries with exponential backoff, and writing output to a target file.
---

# Codex CLI Runner

Use this skill when you need to call the OpenAI Codex agent from the command line (any task), independent of the downstream workflow (review, drafting, computation, etc.).

## Preconditions

- `codex` is installed: `command -v codex`
- You are authenticated (run `codex login` if needed).
- The default model and provider are configured in `~/.codex/config.toml`.

## Recommended: runner script (retries + file inputs)

```bash
bash ~/.claude/skills/codex-cli-runner/scripts/run_codex.sh \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

With explicit model:

```bash
bash ~/.claude/skills/codex-cli-runner/scripts/run_codex.sh \
  --model o3 \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

## Notes

- Uses `codex exec` (non-interactive mode) with `--full-auto` (skip approval prompts) and `--sandbox read-only` (safe default for text-generation tasks).
- System prompt + user prompt are merged and fed via stdin to avoid ARG_MAX limits with large prompt files.
- `--output-last-message` (`-o`) captures the agent's final response to the output file.
- `--skip-git-repo-check` is enabled by default so the runner works from any directory.
- Retries on failure with exponential backoff (useful for transient API errors).
- For offline/CI validation, use `--dry-run` to print the planned invocation without calling Codex.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--model MODEL` | (from config.toml) | Model override (e.g. `o3`, `gpt-4.1`) |
| `--system-prompt-file FILE` | (none) | Optional system instructions file |
| `--prompt-file FILE` | **required** | User prompt file |
| `--out PATH` | **required** | Output file for agent's last message |
| `--sandbox MODE` | `read-only` | Sandbox policy: `read-only`, `workspace-write`, `danger-full-access` |
| `--profile PROFILE` | (none) | Config profile from config.toml |
| `--config KEY=VALUE` | (none) | Repeatable `-c` overrides for config.toml values |
| `--full-auto` | enabled | Skip approval prompts (disable with `--no-full-auto`) |
| `--skip-git-repo-check` | enabled | Run outside git repos (disable with `--no-skip-git-repo-check`) |
| `--max-retries N` | 6 | Maximum retry attempts |
| `--sleep-secs S` | 10 | Base sleep for exponential backoff |
| `--dry-run` | off | Print planned command without executing |

## Dry-run example

```bash
bash ~/.claude/skills/codex-cli-runner/scripts/run_codex.sh \
  --model o3 \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```

## Sandbox modes

- `read-only` (default): Agent can read files but not modify them. Best for text generation, analysis, review.
- `workspace-write`: Agent can modify files in the working directory. Use for code generation tasks.
- `danger-full-access`: No restrictions. Use only in externally sandboxed environments.
