---
name: literature-graph-builder
description: Build, validate, and QA auditable literature graphs from deep-read notes and survey artifacts. Use when an agent needs to turn a literature review into an interactive graph with paper/method/topic nodes, source-backed edges, embedded notes, portable relative links, rendered math, verified figures, and browser-tested interactions.
---

# Literature Graph Builder

Build an inspectable graph layer on top of already deep-read literature notes. This skill owns graph artifact contracts, rendering checks, link and figure portability, note embedding, and browser QA. It does not replace source reading, citation discovery, or claim grounding.

## Boundaries

- Use `deep-literature-review` first for source discovery, source-first per-paper notes, graph-ready exports, and synthesis.
- Use this skill after notes exist, or while designing the graph-ready export that will consume those notes.
- Use `markdown-hygiene` before rendering notes and again after graph pages are generated.
- Use `claim-grounding` for source-support checks on graph edge claims or figure relevance claims.
- Use `review-swarm` for independent review of the current graph artifact after each substantive correction.

## Workflow

1. Read `references/graph-ready-contract.md` when creating or auditing a graph export.
2. Build or normalize a `literature_graph_v1` JSON artifact with stable node ids, node kinds, relative note paths, source locators, and source-backed edges.
3. Validate the graph before rendering:

```bash
python3 "$SKILL_DIR/scripts/bin/validate_literature_graph.py" --graph path/to/literature_graph.json --project-root .
```

4. Render the graph as a portable local artifact. Keep local paths relative to the graph HTML file or project root; do not emit machine-specific absolute paths.
5. Embed note content in the page or route note links through a local renderer. Clicking a node must open the rendered note on the first click, not only after a layout jitter.
6. Render math with a real math renderer such as MathJax or KaTeX. Do not leave mathematical expressions as raw plain text or code spans in notes, tables, sidebars, or tooltips. Before browser QA, run `markdown-hygiene` with `--raw-math-preset ascii-math` and any project-supplied `--raw-token` patterns that catch domain-specific symbols or reactions.
7. Display real figure assets, not filenames, paper front pages, or title-page screenshots. Convert EPS/PS sources to PNG/PDF before linking them.
8. Browser-test the graph: first-click behavior, node dragging, collision/label overlap, viewport fit, side-panel links, raw-note links, image loading, and math rendering.

## Contract Checks

Run the validator on the graph JSON whenever graph content changes. It checks:

- unique node ids and valid edge endpoints;
- required node labels, kinds, and relative `note_path` values;
- portable paths with no absolute local paths or parent-directory escapes;
- existing Markdown notes for graph nodes;
- source-backed edge metadata rather than unlabeled visual lines;
- figure assets that exist, are relative, and are renderable image/PDF formats;
- no displayed EPS/PS figure paths.

The validator is intentionally conservative. If a project needs extra relation names or node kinds, pass them explicitly instead of weakening the baseline:

```bash
python3 "$SKILL_DIR/scripts/bin/validate_literature_graph.py" \
  --graph path/to/literature_graph.json \
  --project-root . \
  --allow-relation reuse \
  --allow-node-kind dataset
```

## Rendering QA

For an HTML graph, verify these properties before calling it usable:

- **First click**: a click on the visual node body opens the note without requiring a second click.
- **Drag and collision**: nodes can be dragged; labels remain readable; the layout avoids stacking nodes over captions, legends, or side-panel text.
- **Math**: rendered notes and summary tables contain MathJax/KaTeX output, not raw math-like ASCII or code spans.
- **Figures**: every figure card uses an actual local image/PDF source; source locators link to the note, converted figure, or original source artifact.
- **Connected literature**: every connected-node entry is clickable and resolves to a rendered note or the corresponding node.
- **Portability**: moving the artifact directory to another machine preserves relative graph, note, and figure links.

Use screenshots or DOM checks for the above when browser tooling is available. A graph that renders visually but has broken node clicks, missing images, unrendered math, or dead side-panel links is not complete.

## Review Gate

For durable or public graph artifacts, run independent reviewers on the current files, not on a prose summary. Ask them to inspect:

- whether every node has a substantive note;
- whether important edges are source-backed and not merely topical similarity;
- whether figure assets are meaningful and actually displayed;
- whether browser interactions and portable links work;
- whether the skill boundary stayed domain-neutral and avoided project-specific hardcoding.

After fixing reviewer findings, rerun review on the fixed artifact before declaring convergence.
