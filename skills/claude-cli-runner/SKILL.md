---
name: claude-cli-runner
description: Run the local `claude` CLI in non-interactive mode (with optional retries/backoff) for arbitrary prompts; supports loading system+user prompts from files and writing output to a target file.
---

# Claude CLI Runner

Use this skill when you need to call Claude from the command line (any task), independent of the downstream workflow (review, drafting, translation, etc.).

## Preconditions

- `claude` is installed: `command -v claude`
- You are authenticated/configured for Claude Code CLI.

## Recommended: runner script (retries + file inputs)

```bash
bash "$CODEX_HOME/skills/claude-cli-runner/scripts/run_claude.sh" \
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
- It retries on failures with exponential backoff (useful for transient 5xx/overload).
- It feeds the user prompt via stdin (`--input-format text` + `< --prompt-file`) to avoid macOS/Linux `ARG_MAX` limits (fixes `Argument list too long` with 1–5MB prompt packets).
- For offline/CI validation, use `--dry-run` to print the planned invocation without calling Claude (prints only paths + size + sha256; never the full prompt).

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
cd /path/to/autoresearch-lab/packages/hep-mcp
npx vitest run tests/smoke-no-toplevel-union.test.ts
```

### Affected MCP Projects

The following MCP projects had top-level-union schema fixes (2026-01-28):
- `hep-mcp` / `@autoresearch/hep-mcp`: `inspire_literature` and related retained INSPIRE surfaces
- `zotero-mcp`: `zotero_local`

Historical workflow-like tool names may since have been pruned. Use the current tool catalog for live tool names rather than this historical note.

## Runner dry-run

```bash
bash "$CODEX_HOME/skills/claude-cli-runner/scripts/run_claude.sh" \
  --system-prompt-file /path/to/system.txt \
  --prompt-file /path/to/prompt.txt \
  --out /path/to/output.txt \
  --dry-run
```
