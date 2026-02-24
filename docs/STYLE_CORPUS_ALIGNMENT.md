# Style Corpus Alignment (Phase 4.8)

This note tracks alignment between MCP style-corpus tools and external writing skills.

## Purpose

- Keep style evidence retrieval semantics consistent across entry points.
- Prevent drift between skill-side style prompts and MCP-side corpus/query contracts.
- Maintain evidence-first outputs (`uri + summary`) rather than large inline payloads.

## Current Baseline

- `inspire_style_corpus_query` is available in `standard` mode.
- Style-corpus build/import/export tools are `full` + `experimental`.
- `research-writer` can use style guidance assets independently.

## Alignment Principles

- Quality-first: do not trade citation/grounding quality for deterministic shortcuts.
- Contract-first: schema and artifact contracts stay source-of-truth.
- Non-blocking evolution: style alignment improvements are experience optimizations, not release blockers.

## Practical Guidance

- Prefer MCP style corpus query when a run/project context already exists.
- Prefer skill-local style assets when doing offline drafting with no run context.
- If both are used, cite the same style evidence URI set in revision notes.

## Deferred Work

- Optional deeper unification of style profile bootstrapping paths.
- Optional shared diagnostics format for style retrieval quality.
