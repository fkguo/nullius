---
name: gemini-cli-runner
description: Run the local `gemini` CLI in one-shot mode for arbitrary prompts; supports model selection, file-based prompt input, and writing output to a target file with safe fallback if the model alias differs.
---

# Gemini CLI Runner

Use this skill when you need to call Gemini from the command line (any task), independent of the downstream workflow (review, drafting, etc.).

## Preconditions

- `gemini` is installed: `command -v gemini`
- You are authenticated/configured for Gemini CLI.

## Recommended: runner script (file input + model fallback)

```bash
bash "$CODEX_HOME/skills/gemini-cli-runner/scripts/run_gemini.sh" \
  --model gemini-3.1-pro-preview \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Dry-run (no `gemini` call):

```bash
bash "$CODEX_HOME/skills/gemini-cli-runner/scripts/run_gemini.sh" \
  --model gemini-3.1-pro-preview \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```

Notes:
- If the given `--model` is not recognized by your local CLI, the script retries with the default model (by omitting `-m`).
- Prompts are fed via stdin to avoid `Argument list too long` with large prompt files.
- If `--system-prompt-file` is provided, its contents are prepended to stdin before the prompt file (separated by a blank line).
- If no proxy env is already exported, the runner will try to bootstrap `http_proxy` / `https_proxy` / `all_proxy` from an interactive `zsh` session by invoking a user-defined `proxy_on` helper when available.
- Tool access is explicit:
  - Default is `--tool-mode none`
  - `--tool-mode review` maps to Gemini CLI `--approval-mode plan` plus `--sandbox`, `--no-proxy-first`, and `--extensions none`
- If `--gemini-cli-home` is set, the runner treats it as an isolated Gemini home root. When auth env vars are not already exported, it bootstraps the minimum Gemini auth env from `$HOME/.gemini/.env` so isolated review runs do not silently lose API connectivity.
- Use `--dry-run` to print the planned command + prompt file size/hash without calling `gemini`.
- `--no-proxy-first` still exists as an escape hatch, but read-only review/file access should normally use `--tool-mode review`.
