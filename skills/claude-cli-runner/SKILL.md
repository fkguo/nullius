---
name: claude-cli-runner
description: Run the local `claude` CLI in non-interactive mode (with optional retries/backoff) for arbitrary prompts; supports loading system+user prompts from files and writing output to a target file.
---

# Claude CLI Runner

Use this skill when you need to call Claude from the command line (any task), independent of the downstream workflow (review, drafting, translation, etc.).

> **If you are already running as Claude, don't use this runner to re-invoke yourself.** Keep the call
> in-host: a native sub-agent if your host exposes one (Claude Code's Agent/Task tool), else inline in
> your own loop. The `claude` CLI hop adds latency, a separate auth/session, and context loss for zero
> gain. This runner is for reaching Claude from a DIFFERENT host (Codex / OpenCode / …) for cross-model
> work. Pick reasoning effort by task difficulty — quality first, not token thrift.

## Preconditions

- Python 3.10 or newer for cross-process monotonic deadlines and process supervision.
- `claude` is installed: `command -v claude`
- You are authenticated/configured for Claude Code CLI.

## Recommended: runner script (retries + file inputs)

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/claude-cli-runner" ] && echo "$r/skills/claude-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_claude.sh" \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt
```

Notes:
- The runner always uses `--print` + `--no-session-persistence`.
- `--model` is optional. If omitted (or set to `default` upstream), the runner uses Claude CLI's configured default model.
- It disables tools by default (`--tool-mode none`, equivalent to `--tools ""`).
- Use `--tool-mode review` for the read-only review profile (`Read,Glob,Grep`).
- `--tools ...` remains available as an explicit advanced override when you need a custom built-in tool list.
- It enables `--strict-mcp-config` by default to avoid side effects and MCP schema loading issues (disable with `--no-strict-mcp-config`).
- It retries on failures with exponential backoff (useful for transient 5xx/overload). All calls and
  backoff share an explicit `--timeout-secs` hard budget when supplied; the default has no hard deadline.
- `--max-retries` caps total CLI calls (default `6`), including retries. Incomplete/error terminal
  results, confirmed inactivity, cancellation and budget exhaustion stop without an automatic retry.
- Deterministic failures (usage/auth/region-ineligibility, quota/billing-cycle and permission errors,
  exit codes 2/126/127, and similar, detected from the exit code and diagnostics) fail immediately with the diagnostic instead of burning the retry backoff.
- It feeds the user prompt via stdin (`--input-format text` + `< --prompt-file`) to avoid macOS/Linux `ARG_MAX` limits (fixes `Argument list too long` with 1–5MB prompt packets).
- For offline/CI validation, use `--dry-run` to print the planned invocation without calling Claude (prints only paths + size + sha256; never the full prompt).

## Progress and durable evidence

`--live-capture` explicitly opts into `--output-format stream-json --include-partial-messages --verbose`.
Raw events and stderr are written from launch under the seat-local `OUT.attempts/run.*` directory
(or `--trace-dir DIR`). Live capture does not mirror raw events into ambient legacy attempt-log
locations. `OUT.partial` and each attempt's partial answer contain answer text only;
private reasoning stays in the raw evidence. Progress JSON contains event kinds, growth counters,
timestamps, capture health and process/provider status, never reasoning text. Replays with the same
event identity and payload do not advance the counters; distinct event identities with repeated text
do advance. Without event identity, identical text deltas are retained as separate observed increments.
Heartbeats do not advance the counters. Text is collected by message identity and content-block index,
in original order, with snapshots and deltas reconciled without duplication. Incompatible block types
or text refuse completion while retaining prior partial text. `OUT` contains the complete assistant
text, including earlier messages; tool and thinking blocks stay in raw events. Exit 0, a successful
terminal record matching the complete text or final text message, and completed text blocks are required.
Partial text never completes a review contract.

`--expected-secs` (default `1200`) is a soft estimate only. `--timeout-secs` defaults to `0` (no hard
budget); any explicit positive value is a hard total cap across attempts and backoff, unaffected by
output growth. `--inactivity-secs` defaults to `0` (disabled). An explicit threshold records a diagnostic
with capture health, last advancing event and provider/process status, followed by
`--inactivity-grace-secs` (default `30`, positive). Only a healthy observable stream with earlier advancing
content can terminate after this grace. Silent reasoning before any advancing event and unknown/degraded
capture cannot establish a stall. Activity establishes generation, not correctness or semantic quality.

Without live capture, successful stdout+stderr output bytes are preserved and progress remains unknown.
Buffered silence never enables an inactivity kill. Cancellation and hard-budget exhaustion stop local
CLI process groups and preserve existing raw/partial evidence; they do not attest remote-job cancellation.
Deterministic failure classification reads stderr and typed stream error messages, never answer or
thinking text. Cancellation also interrupts retry backoff without waiting for the delay to finish.
Capture directories must be excluded from peer packets/workspaces by the caller's existing read-path
membrane. Read-only tool access alone cannot enforce filesystem isolation.

Example:

```bash
bash /path/to/claude-cli-runner/scripts/run_claude.sh \
  --system-prompt-file /path/to/system.txt --prompt-file /path/to/prompt.txt \
  --out /path/to/review.txt --live-capture --expected-secs 1200 --timeout-secs 5400
```

## Session continuation (OPT-IN; the default stays a clean-room one-shot)

By default the runner passes `--no-session-persistence`: nothing is recorded, nothing resumable —
the right contract for independent reviews. Session features are opt-in (any of them implies
persistence; all live-validated):

- `--persist-session` — record the conversation so a later invocation can resume it.
- `--session-id-file FILE` — also capture the new session id to FILE. Internally switches claude to
  `--output-format json`; `--out` then receives ONLY the final result text (parsed from the JSON
  envelope), not raw stdout+stderr.
- `--resume-session ID` — send this prompt as the NEXT turn of a previously persisted session
  (`claude --resume ID`). Chain multi-turn workflows: run 1 with `--session-id-file sid.txt`, run 2
  with `--resume-session "$(cat sid.txt)"`. Non-racy: the id is explicit.

Do NOT persist/resume sessions for clean-room review rounds whose independence matters — a resumed
round sees the earlier turns.

## Troubleshooting: 400 Error with Custom API Gateway

### Symptom

When using a custom `ANTHROPIC_BASE_URL` (configured in `~/.claude/settings.json`), Claude CLI may fail with:

```
API Error: 400 {"error":{"message":"input_schema does not support oneOf, allOf, or anyOf at the top level"}}
```

This happens when MCP tools are loaded and their JSON schemas contain top-level `oneOf`/`anyOf`/`allOf` (produced by Zod's `z.discriminatedUnion` or `z.union`).

### Temporary Workaround

Use `--strict-mcp-config` to skip MCP tool loading:

```bash
echo "test" | claude --print --no-session-persistence --strict-mcp-config
```

**Note:** This disables MCP tools entirely. For scientific research workflows, tools/MCP should remain enabled for full functionality.

### Root Cause

Some API gateways (e.g., `jp.duckcoding.com`, `openclaudecode.cn`) enforce stricter JSON Schema validation than the official Anthropic API. When MCP tools use `z.discriminatedUnion('mode', [...])`, the resulting JSON Schema has a top-level `oneOf`, which these gateways reject.

### Permanent Fix

Flatten `z.discriminatedUnion` schemas to plain `z.object` with `z.enum` for the discriminator field:

**Before (problematic):**
```typescript
const ToolSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('get'), id: z.string() }),
  z.object({ mode: z.literal('search'), query: z.string() }),
]);
```

**After (compatible):**
```typescript
const ToolSchema = z.object({
  mode: z.enum(['get', 'search']),
  id: z.string().optional(),      // get mode
  query: z.string().optional(),   // search mode
});
```

### Smoke Test

A smoke test ensures no tool has top-level union constructs:

```bash
cd /path/to/nullius/packages/hep-mcp
npx vitest run tests/smoke-no-toplevel-union.test.ts
```

### Affected MCP Projects

The following MCP projects had top-level-union schema fixes (2026-01-28):
- `hep-mcp` / `@nullius/hep-mcp`: `inspire_literature` and related retained INSPIRE surfaces
- `zotero-mcp`: `zotero_local`

Historical workflow-like tool names may since have been pruned. Use the current tool catalog for live tool names rather than this historical note.

## Runner dry-run

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/claude-cli-runner" ] && echo "$r/skills/claude-cli-runner" && break; done || true)}"
bash "${SKILL_DIR}/scripts/run_claude.sh" \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```
