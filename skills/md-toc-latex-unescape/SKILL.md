---
name: md-toc-latex-unescape
description: Fix LaTeX escaping introduced by Markdown Table-of-Contents generators inside a TOC block (e.g., \\kappa, \\gamma\\_{\\rm lin}, G\\_R, k^\\*) by rewriting only math segments ($...$, $$...$$) in the TOC region.
metadata:
  short-description: Fix LaTeX escapes in Markdown TOC
---

# Markdown TOC LaTeX Unescape

Use this skill when a Markdown file’s **Table of Contents** shows broken math because a TOC generator escaped LaTeX (common symptoms: `\\kappa`, `\\gamma\\_{\\rm ...}`, `\\_`, `^\\*`, `\\tau\\_c`).

This skill does **not** regenerate the TOC; it only cleans up LaTeX escaping **inside the TOC block**.

## What it changes (and what it won’t)

- Only edits the region from a TOC heading line whose text starts with `目录` / `Table of Contents` / `Contents` (case-insensitive; any heading level `##`, `###`, …) until the next horizontal rule `---`.
- Only rewrites content inside math delimiters (`$...$` and `$$...$$`) within that region.
- Skips fenced code blocks (````` ``` ````` … ````` ``` `````) inside the TOC region.
- Leaves anchors `(#...)` untouched (anchors are outside math delimiters and are therefore never rewritten).

> Note: the TOC block must be terminated by a line containing only `---`. If no such line appears after the TOC heading, the script will treat the remainder of the file as “in TOC”.

## Quick start

Run the bundled script on one or more Markdown files:

```bash
python3 "$CODEX_HOME/skills/md-toc-latex-unescape/scripts/fix_md_toc_latex_escapes.py" Draft_Derivation_HM_SCET.md
```

Multiple files can be processed in one invocation:

```bash
python3 "$CODEX_HOME/skills/md-toc-latex-unescape/scripts/fix_md_toc_latex_escapes.py" file1.md file2.md
```

## Safety check (recommended)

To see whether changes are needed without modifying files:

```bash
python3 "$CODEX_HOME/skills/md-toc-latex-unescape/scripts/fix_md_toc_latex_escapes.py" --check Draft_Derivation_HM_SCET.md
```

Exit codes:

| Mode | Condition | Exit code |
|---|---|---|
| `--check` | changes would be made | `1` |
| `--check` | no changes needed | `0` |
| normal (in-place) | always | `0` |

The script is silent by default; use `--check` (exit code) and/or version control (e.g., `git diff`) to confirm what changed.

After applying, validate that common “double backslash” mistakes are gone:

```bash
grep -n '\\\\[a-zA-Z]' Draft_Derivation_HM_SCET.md
grep -n '\\\\[*_^]' Draft_Derivation_HM_SCET.md
```

## When it will come back

If you run the same TOC generator again and it re-escapes LaTeX, rerun this skill/script as a post-processing step.
