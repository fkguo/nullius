---
name: markdown-hygiene
description: Check and repair deterministic Markdown hygiene issues in research notes, especially Markdown math escaping, TOC-generated LaTeX escapes, rendered math/link readiness, and portable cleanup before research-harness/research-team/research-writer/research-integrity handoff; also trigger on rendering symptoms such as math showing as raw $...$ source on GitHub or a report page, formulas that render in one viewer but not on the target surface, LaTeX escapes that look doubled, or paper references that are not clickable.
metadata:
  short-description: Deterministic Markdown math and link hygiene
---

# Markdown Hygiene

Use this skill when Markdown research notes need deterministic formatting cleanup before review, handoff, publication scaffolding, or `research-team` / `research-writer` workflows.

The TOC repair is one subcommand of this broader Markdown hygiene surface.

## When to use

- A generated Markdown table of contents escaped LaTeX inside math, such as `$\\gamma\\_{\\rm lin}$`, `$G\\_R$`, or `$k^\\*$`.
- Markdown math contains accidental doubled command backslashes such as `$\\Delta$` instead of `$\Delta$`.
- Display-math blocks contain continuation lines beginning with `=`, `+`, or `-`, which some Markdown renderers can confuse with block syntax.
- You need a standalone Markdown cleanup/check before invoking `research-harness`, `research-team`, or `research-writer`.
- You need to verify rendered-note portability for graph or slide artifacts: local Markdown links resolve, absolute local paths are absent, likely note paths are real links rather than code spans, display math is separated from prose, and project-configured raw math/text tokens are gone.
- Human-facing Markdown documents must render all intended math as math, both inline and display, and every web page or paper reference shown to a reader must be clickable.
- Math renders on one surface but not another, for example formulas that show as raw `$...$` source text on a GitHub README or a rendered report page while a local preview looks fine.

For a full `research-team` project preflight, keep using `research-team`; its team-cycle gates remain the authoritative runtime checks. This skill is the standalone, reusable hygiene entrypoint.

## Target rendering surface

These rules are not renderer-neutral: the same Markdown source can render cleanly on one surface and leak raw math source on another. Decide which surface the document must serve before choosing checks, and never "fix" a file back and forth between surface conventions — pick the target, then converge on it.

- **GitHub repo Markdown (README, in-repo docs pages, issue and PR text).** Inline `$...$` and display `$$...$$` are both supported. GitHub layers its own Markdown parsing on top of the math span, so a few constructs that are fine in a TeX document are fragile here; the known hazards are exactly what `--check-github-math` flags. Typical symptom: a formula that looks fine in a local preview shows up on the rendered GitHub page as raw `$...$` source text or with mangled characters. Run the baseline `check` plus `--human-facing`, and add `--check-github-math`; that flag exists for this surface.
- **Local editors and document pipelines (editor previews, KaTeX or MathJax site and slide generators, pandoc-style converters).** Inline `$...$` and display `$$...$$` are the portable forms. These renderers hand the span content to the math engine mostly verbatim, so doubled command backslashes such as `$\\Delta$`, TOC-escaped forms such as `$G\_R$`, and prose-adjacent `$$` blocks are the classic breakage. Typical symptom: stray literal backslashes or underscores inside typeset math, or a display block that renders as plain paragraph text. Run the baseline `check`, plus `--human-facing` for reader-facing notes; leave `--check-github-math` off unless the renderer shares GitHub's failure modes.
- **Chat clients that render only display blocks.** Some conversation surfaces render standalone `$$...$$` blocks but show inline `$...$` as raw source, so inline math typed into the chat window needs Unicode or display blocks there. That constraint applies to chat replies, not to Markdown files: for files, keep `$...$` as the portable inline form and do not rewrite documents into Unicode-only math (see the Safety Contract). The deterministic script lints Markdown files only and has no checks for chat-reply text.

The deterministic script inspects Markdown source patterns and never invokes any renderer, so a clean run is strong evidence, not proof, that the target surface renders everything. The acid test is always the same: the document must compile and render on the TARGET surface without leaking raw source. When one file must serve several surfaces, write to the strictest target and verify there.

### Checking GitHub rendering without pushing

GitHub's own Markdown endpoint is the cheapest faithful probe of its math pipeline. It needs network access and an authenticated GitHub CLI (`gh api` refuses to run unauthenticated; bare unauthenticated REST calls get only a very small quota):

```bash
gh api markdown -f mode=gfm -f "text=$(cat README.md)"
```

Every formula GitHub recognizes comes back wrapped in a `math-renderer` element; any `$...$` left as bare text in the returned HTML will leak as raw source on the rendered page. Use `mode=gfm` — the plain `markdown` mode does not run the math pipeline. Recognition is necessary but not sufficient: typesetting happens later in the browser, so an unsupported macro inside a recognized span can still fail there; for final certainty view the rendered page once. This skill deliberately ships no offline emulator of GitHub's pipeline: local preview engines differ from GitHub in exactly the ways that matter here, and a faithful clone would be heavy machinery for little added trust.

## Commands

Set `SKILL_DIR` if the host does not provide it:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/markdown-hygiene" ] && echo "$r/skills/markdown-hygiene" && break; done || true)}"
```

Check a file or directory without modifying it:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check --root research_contract.md
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check --root .
```

Check graph/slide-facing note portability:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check \
  --root notes \
  --check-local-links \
  --check-bare-md-paths \
  --raw-math-preset ascii-math \
  --raw-token 'PROJECT_SPECIFIC_RAW_PATTERN'
```

Use `--raw-math-preset ascii-math` to catch common plain-text math artifacts such as ASCII arrows and caret powers outside fenced code and outside Markdown math. Use `--raw-token` with project-provided regex patterns for domain-specific symbols, reactions, variable names, or formula fragments that should have been converted into rendered math or ordinary prose. Repeat `--raw-token` for multiple patterns. Use `--path-prefix` to add project-specific relative note roots to the bare-path detector.

Check human-facing rendered Markdown:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check \
  --root notes \
  --human-facing \
  --raw-token 'PROJECT_SPECIFIC_RAW_PATTERN'
```

`--human-facing` enables local-link portability checks, bare Markdown-path checks, clickable-reference checks for bare web URLs / DOIs / arXiv IDs, code-wrapped math checks, display-spacing checks, table-math pipe checks, and the `ascii-math` raw-math preset. Add project-specific `--raw-token` patterns until every formula-like token that should render as math is either inside Markdown math or intentionally rewritten as prose.

For README or other GitHub-targeted Markdown, add the GFM-fragility check:

```bash
python3 "$SKILL_DIR/scripts/bin/markdown_hygiene.py" check \
  --root README.md \
  --human-facing \
  --check-github-math
```

`--check-github-math` flags known GitHub Markdown math hazards such as raw `*` inside math, fragile `\bar{...}_...` constructs, and inline math immediately followed by `)`. Fix with standard LaTeX that remains readable in offline renderers, for example `\ast`, `\bar X_...`, and a small wording or punctuation change after the closing `$`.

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
- Rewrites only Markdown math regions for LaTeX escaping fixes, plus likely formula-like inline code spans that should have been Markdown math.
- For human-facing Markdown, all formula content intended as math must be written in renderable Markdown math: inline formulas in `$...$`, display formulas in standalone `$$...$$` blocks, or renderer-supported display environments. Do not leave formulas as plain text or inline code when a human reader should see compiled math.
- For Markdown files, do not rewrite inline math into Unicode text. `$...$` is the portable form for inline formulas in Markdown documents; Unicode-only inline math is a chat-client workaround, not the document standard.
- Put display `$$` delimiters on standalone lines with a blank line before the opening delimiter and after the closing delimiter. Single-line or prose-adjacent display math is fragile across renderers.
- In Markdown tables, do not put literal `|` characters inside math cells; use `\mid`, `\lvert...\rvert`, or `\lVert...\rVert` so the table parser cannot split the formula.
- For GitHub-facing Markdown, preserve standard LaTeX math but use GFM-safe forms such as `\ast` instead of raw `*`, avoid fragile `\bar{...}_...` forms when a simpler `\bar X_...` works, and avoid a closing inline `$` immediately followed by `)`.
- In display formulas, prefer visual LaTeX fractions such as `\frac{...}{...}` when a mathematical fraction is intended; slash notation is acceptable only when it is semantically a ratio or part of prose-like notation.
- For human-facing Markdown, web pages and paper references must be clickable Markdown/HTML links. Bare `http://...`, `https://...`, DOI strings, and arXiv identifiers in prose are hygiene failures; use `[label](url)`, `<https://...>`, reference-style Markdown links, or equivalent HTML anchors.
- The clickable-reference rule is for human-readable Markdown deliverables. Non-Markdown files, including JSON artifacts that are consumed only by agents or machines, are not scanned and do not need Markdown linkification.
- In display-math blocks, prefixes line-leading `=`, `+`, or `-` with `{}` as a conservative source-formatting fix.
- TOC cleanup applies only from a heading beginning with `目录`, `Table of Contents`, or `Contents` until the next `---` horizontal rule.
- Does not regenerate TOCs, rewrite anchors, or alter non-math link targets.
- Optional `check`-only link checks do not rewrite files. They fail on broken local links, `file://` links, absolute local paths, and local links escaping the checked root.
- Optional bare-path checks flag likely note paths displayed as inline code instead of Markdown links; fix them by writing normal links with relative targets.
- Optional clickable-reference checks flag bare web URLs, DOIs, and arXiv IDs that are not already inside Markdown links, reference links, HTTP(S) autolinks, or HTML anchors.
- Optional code-math checks flag likely formulas inside inline code spans. The fixer converts ordinary single-line code spans like `` `C(k)` `` or `` `\Omega` `` into `$C(k)$` or `$\Omega$`, and converts whole-line `` `\[...\]` `` / `` `$$...$$` `` spans into display math.
- Optional display-spacing checks flag inline `$$...$$` and prose-adjacent `$$` blocks. The fixer inserts blank lines around standalone `$$` blocks.
- Optional table-math pipe checks flag literal pipes inside math on table lines.
- Optional GitHub-math checks are fail-only and target README/GitHub rendering hazards; do not enable them for non-GitHub surfaces unless that renderer has the same failure modes.
- Optional raw-token and raw-math-preset checks are fail-only guards for rendered artifacts; tune them per project so they catch unrendered formula text without becoming a generic prose linter.

After applying fixes, inspect `git diff` and then run the nearest project gate, for example `research-team` preflight or `research-writer` validation. If the target artifact is rendered HTML, GitHub Markdown, slides, or PDF, verify the actual target renderer rather than relying only on source checks; for GitHub Markdown the endpoint probe under "Target rendering surface" is the cheapest first pass, and for PDF-style deliverables, build and read back or visually inspect the pages.
