---
name: cursor-runner
description: Run one prompt through the local Cursor Agent CLI with an explicit model ID from the account's model list. Use for headless Claude, Gemini, Grok, or other Cursor model calls with file-based prompts, a timeout, and captured final text.
---

# Cursor Runner

Use this runner for one text task from another host. It invokes the local Cursor
Agent CLI and uses the current Cursor account. On macOS or Linux, use Python
3.10+ and a Cursor CLI (`cursor-agent` or `agent`) that supports command
sandboxing in Ask mode. Authenticate with `agent login` or the standard
`CURSOR_API_KEY` environment variable.

Run commands from the skill directory, or use the absolute path to its script:

```bash
python3 scripts/run_cursor.py --check-client
python3 scripts/run_cursor.py --list-models
python3 scripts/run_cursor.py \
  --model MODEL_ID_FROM_LIST \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/answer.txt \
  --timeout-secs 300
```

- Copy the exact model ID listed for the account. Claude, Gemini, Grok and their
  variants depend on the account, region and Cursor's catalog. The runner sends
  the model ID as supplied and makes one attempt. Use a concrete ID for model
  comparisons, since aliases and routers can resolve to different models.
- `--system-prompt-file FILE` prepends instructions to the text sent by Cursor.
  Both files must be UTF-8. The combined prompt is limited to 64 KiB because the
  CLI takes it as an argument. It may be visible to local process inspection.
- `--dry-run` validates the files and reports the request size and hash before
  dispatch. `--cursor-bin PATH` selects an explicit executable.
- The runner opens an empty temporary workspace in Cursor's read-only Ask mode
  with command sandboxing enabled. Cursor can still read files and use tools
  available through its own configuration. Use a task that fits in the prompt.
- Choose a fresh output path. The runner publishes final text only after a zero
  exit and a successful, nonblank terminal result. The attempt directory holds
  raw JSON events, stderr and the receipt, including Cursor's reported model
  label and session when available. Raw events can include the prompt. A model
  label is Cursor's report, while the receipt records the exact requested ID.
- The timeout applies to the inference process. Failures retain the available
  diagnostics and return nonzero. The runner is standalone and does not add a
  seat to review-swarm.

See [Cursor's CLI guide](https://cursor.com/docs/cli/using),
[output format](https://cursor.com/docs/cli/reference/output-format) and
[model availability](https://prod.cursor.com/help/models-and-usage/available-models).
