# Review swarm: outputs and runner parity

## Outputs

- `{out-dir}/agent_*_*.txt` (or backend output override paths)
- `{out-dir}/trace.jsonl`
- `{out-dir}/meta.json` (per-agent results incl. `failure_class`, plus the
  `unavailable_backends` outage report)
- With `--two-phase`: `{out-dir}/two_phase/` (composite phase prompts) and `*.phase1.*`
  phase-1 outputs next to the final outputs.
- With `review_one.py`: the assembled inputs persist under `{out-dir}/inputs/`
  (`system.md`, `packet.md`) for audit.

## Runner parity notes

### System prompt delivery

All backends now receive the system prompt by default. However, the delivery mechanism differs:

| Runner | Delivery | True system role? |
|--------|----------|-------------------|
| claude-cli-runner | `--system-prompt` native arg | Yes |
| codex-cli-runner | Merged into stdin (`=== System Instructions ===` + `=== Task ===`) | No — prepended to user message |
| gemini-cli-runner | Concatenated into stdin (`system + \n\n + prompt`) | No — prepended to stdin |
| opencode-cli-runner | Concatenated into stdin (same as gemini) | No — prepended to stdin |
| kimi-cli-runner | `--system-prompt-file` prepended to the prompt file | No — prepended to user message |

Only Claude CLI uses a true system role with elevated priority. The other four runners prepend the system prompt as a user-message prefix. This is a CLI limitation, not a bug.

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
