Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Model selection

- `--models a,b,c`: explicit model specs for launcher-executed seats; exact identity mappings
  are required before those seats supply family quorum.
- `--agents N`: rotate through available OpenCode config models (legacy convenience;
  prefer explicit `--models` for reviewer runs).
- `--model default`: one OpenCode agent, CLI default model.
- Mixed backends supported: `claude/...`, `codex/...`, `gemini/...`, `kimi/...`, OpenCode `provider/model`.

### Default-model policy (hard rule)

When model is omitted or set to `default`, **do not inject historical model names**.
Always delegate to each backend CLI's configured default model.

This rule applies to all backends:
- OpenCode
- Claude CLI
- Codex CLI
- Gemini CLI
- Kimi CLI

Read [`references/fallback-and-outages.md`](fallback-and-outages.md) when a backend is unavailable, a fallback must be chosen or recorded, or a packet approaches the prompt-size limit (the `Fallback policy`, `Backend outage handling` and `Prompt-size guardrail` sections, moved there verbatim).
