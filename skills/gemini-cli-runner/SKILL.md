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
bash /home/user/.codex/skills/gemini-cli-runner/scripts/run_gemini.sh \
  --model gemini-3.1-pro-preview \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Dry-run (no `gemini` call):

```bash
bash /home/user/.codex/skills/gemini-cli-runner/scripts/run_gemini.sh \
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
- The runner now defaults to Gemini CLI's standard headless mode instead of forcing `--approval-mode plan`. Use `--approval-mode plan` only when you explicitly need that mode.
- The runner captures `stdout` and `stderr` separately so Gemini startup/API diagnostics do not pollute the output file.
- `--no-proxy-first` still skips the generateContent fast-path and forces the local Gemini CLI path.
- Use `--dry-run` to print the planned command + prompt file size/hash without calling `gemini`.
