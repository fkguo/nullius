# Tool Selection

Choose by figure type, not by tool enthusiasm. The goal is a manuscript-ready vector figure with
editable source and labels that do not collide with lines.

## Default: Explicit-Coordinate TikZ

Use for process diagrams, tree diagrams, one-loop/two-loop sketches, exchange diagrams, decay chains,
and integral-equation schematics.

Why:

- native LaTeX math labels and manuscript fonts;
- direct vector PDF output;
- ordinary TeX distributions can compile it;
- explicit coordinates make label lanes controllable;
- shared `pd*` styles keep colors, line widths, labels, and blocks consistent across figures.

Use TikZ core for complex layout: panels, boxes, arrows between equations, braces, labels, and colored
operator blocks.

## Feynman/Process Idiom: tikz-feynhand

Use `tikz-feynhand` when Feynman/process diagrams benefit from standard particle-line commands such as
`\propag`, `pho`, `sca`, or familiar feynhand vertex placement. Keep vertices explicit; do not use it
as an automatic layout engine. Keep labels as separate `pdLabel` TikZ nodes when automatic edge labels
would collide with lines.

See `assets/examples/feynhand_process.tex` for a minimal standalone example.

Do not make `tikz-feynman` automatic graph placement the default for final publication figures. It is
useful for quick topology sketches, but complex schematics need manual layout and label control.

## Geometry Escape Hatch: Matplotlib/Python

Use Matplotlib when the figure is a geometry/coordinate/angle schematic or when existing data already
come from an external computation pipeline and only the presentation needs styling.

This skill does not own the numerical computation that produces physics curves, histograms,
amplitudes, contours, or fit results. It may own the plotting script, labels, vector export, and
publication QA once the data already exist.

Requirements:

- use `text.usetex` or mathtext consistently with the manuscript;
- export vector PDF with `savefig(..., format="pdf")`;
- avoid rasterized artists unless intentionally plotting image data;
- run `build_diagram.py --qa-only figure.pdf` and inspect the preview at final manuscript size.

Matplotlib is not the default for Feynman topology. It is a first-class route for geometry sketches and
for styling precomputed data figures.

## Rare Escape Hatch: Asymptote

Use Asymptote when the figure is mostly geometry: smooth curves, projected surfaces, 3D-ish
kinematic sketches, or path labels that are easier to express programmatically than in TikZ.

Keep the same quality contract: TeX labels, vector PDF, rendered preview, and visual inspection.
Avoid Asymptote for ordinary Feynman/process diagrams unless the project already uses it. If used,
export PDF first, then run `build_diagram.py --qa-only figure.pdf` for the shared QA report.

## Finishing Only: Inkscape

Use Inkscape only when importing/cleaning SVG, matching an existing hand-made figure, or doing final
manual polish. If used, keep the SVG and record the export command. Treat GUI edits as derived assets,
not as a reproducible canonical source, unless the user explicitly chooses SVG-first work.

On macOS the CLI may be:

```bash
/Applications/Inkscape.app/Contents/MacOS/inkscape --export-type=pdf input.svg
```

## Upstream Only: FeynArts and QGRAF

Use FeynArts or QGRAF to enumerate or check model-generated topologies. They answer "which diagrams
exist?", not "how should this explanation figure be laid out?". Redraw selected final figures in a
publication-layout backend.

## Rarely Use For This Skill

- Graphviz: useful for abstract dependency graphs, weak for physics line styles and TeX labels.
- PyX: useful for Python vector graphics with TeX labels, but less common than Matplotlib and TikZ.
- MetaPost/feynmf/feynmp: useful for legacy projects that already use them; avoid introducing them
  into new manuscripts unless requested.
