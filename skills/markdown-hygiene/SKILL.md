---
name: markdown-hygiene
description: Check and repair deterministic Markdown hygiene issues in research notes, especially Markdown math escaping, TOC-generated LaTeX escapes, and portable cleanup before research-harness/research-team/research-writer handoff.
metadata:
  short-description: Deterministic Markdown math and TOC hygiene
---

# Markdown Hygiene

Use this skill when Markdown research notes need deterministic formatting cleanup before review, handoff, publication scaffolding, or `research-team` / `research-writer` workflows.

The TOC repair is one subcommand of this broader Markdown hygiene surface.

## When to use

- A generated Markdown table of contents escaped LaTeX inside math, such as `$\\gamma\\_{\\rm lin}$`, `$G\\_R$`, or `$k^\\*$`.
- Markdown math contains accidental doubled command backslashes such as `$\\Delta$` instead of `$\Delta$`.
- You need a standalone Markdown cleanup/check before invoking `research-harness`, `research-team`, or `research-writer`.

For a full `research-team` project preflight, keep using `research-team`; its team-cycle gates remain the authoritative runtime checks. This skill is the standalone, reusable hygiene entrypoint.

## Commands

Set `SKILL_DIR` if the host does not provide it:

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/markdown-hygiene}"
```

Check a file or directory without modifying it:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check --root research_contract.md
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check --root .
```

Apply the deterministic fixes in place:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" fix --root research_contract.md
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" fix --root .
```

Run only the old TOC LaTeX-unescape behavior:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" fix-toc --root Draft.md
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" fix-toc --check --root Draft.md
```

## Safety Contract

- Edits only Markdown files.
- Skips fenced code blocks.
- Rewrites only Markdown math regions for LaTeX escaping fixes.
- TOC cleanup applies only from a heading beginning with `目录`, `Table of Contents`, or `Contents` until the next `---` horizontal rule.
- Does not regenerate TOCs, rewrite anchors, or alter non-math link targets.

After applying fixes, inspect `git diff` and then run the nearest project gate, for example `research-team` preflight or `research-writer` validation.
