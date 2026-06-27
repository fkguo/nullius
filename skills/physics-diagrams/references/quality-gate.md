# Publication Quality Gate

Run this gate before claiming a figure is done.

## Build Gate

- Build from a clean directory.
- Record the engine (`pdflatex`, `lualatex`, `xelatex`, `asy`, or Python command).
- Keep logs and previews in scratch output, not next to manuscript source unless requested.
- Fail if no vector PDF is produced.

Recommended command:

```bash
python3 skills/physics-diagrams/scripts/build_diagram.py path/to/figure.tex \
  --out-dir /tmp/physics-diagrams/<figure-name>
```

For a PDF produced by Matplotlib, Asymptote, Inkscape, or another external pipeline, run the same PDF
inspection and preview gate:

```bash
python3 skills/physics-diagrams/scripts/build_diagram.py \
  --qa-only path/to/figure.pdf \
  --out-dir /tmp/physics-diagrams/<figure-name>
```

## Visual Gate

Inspect the rendered PNG preview at high DPI and at the intended final size.
Before reporting a verdict, state whether the current agent can actually read images in this session.
If not, the figure is not publication-ready until a human or visual subagent/model reviews the preview.
For complex/submission-bound figures, multi-panel figures, nested-equation figures, or figures with
more than six labels, get an independent visual verdict from another agent, reviewer, or model family
when available. Treat that verdict as blocking when it identifies overlap, alignment, clipping, or
publication-style failures.

Hard failures:

- a label crosses a line, arrowhead, vertex, block edge, or another label;
- a label is clipped by the page or bounding box;
- an arrowhead is hidden by a label backing box;
- a white backing hides a topology-defining crossing or vertex;
- a line visibly passes through a filled vertex blob, source blob, or operator block;
- a physical line has visible breaks because it was assembled from separate nested pictures or nodes;
- a pointlike physical vertex such as a WT interaction is drawn as a box with line gaps rather than
  as a connected vertex;
- a dimer/isobar is drawn with a closed-ended decorative double stroke when the constituent particle
  line styles should be visible;
- a dimer appears to pass through an exchange vertex as an unchanged dimer, instead of becoming a
  single particle after emitting the exchanged constituent;
- particle-line semantics conflict with the manuscript convention, such as drawing `K`/`\pi` exchange
  with the same solid line used for `D`/`D^*` without explanation;
- a panel label collides with a physics label;
- a channel-dependent exchange is shown as a single generic diagram in a way that suggests every
  channel can exchange the same particle;
- a summary-row glyph shows multiple adjacent topologies in a way that reads as a product or
  concatenated subdiagram when it is meant to represent one family expanded below;
- a hierarchy arrow stops short of the target panel or penetrates the physics content instead of
  landing cleanly on the target boundary;
- text is unreadable at manuscript width.

Soft failures that usually require revision:

- label lanes are too tight;
- line widths vary without semantic reason;
- default colors are too saturated for a paper schematic;
- a filled vertex blob is drawn without the incident lines sharing a common center;
- a large operator block relies on fill masking instead of explicit boundary-to-boundary line
  segments;
- repeated channels that should share a baseline are visibly misaligned;
- blocks of the same kind use inconsistent colors or sizes;
- panels have inconsistent baselines or scale;
- ordinary interaction vertices are shown with mixed conventions, such as some point vertices drawn
  as circles and other equivalent point vertices left bare without semantic reason;
- `+`, `=`, or hierarchy arrows are too close to nearby diagrams, making the algebraic operator read
  as a line label or part of the topology;
- every kernel ingredient is wrapped in its own decorative box, making the figure read as disconnected
  modules rather than one physical topology;
- panel boxes have visibly excessive or asymmetric internal padding, especially large empty bottom
  margins below the lowest labels;
- the figure has excessive whitespace after cropping.

## PDF Gate

When tools are available:

```bash
pdfinfo figure.pdf
pdffonts figure.pdf
pdfimages -list figure.pdf
```

For vector schematics:

- `pdfimages -list` should show no unexpected image objects;
- fonts should be embedded;
- Type 3 fonts should be avoided when possible;
- page size should be close to the content bounding box.

For plots with real raster data, raster objects are acceptable only if intentional.

## Manuscript Insertion Gate

Test the insertion command at the intended width:

```tex
\includegraphics[width=0.9\linewidth]{figs/my_diagram.pdf}
```

Check after insertion:

- text remains readable;
- no extra vertical whitespace appears;
- baseline is correct for inline/equation diagrams;
- captions do not repeat labels already inside the figure.

## Delivery Checklist

Report:

- source path;
- vector PDF path;
- PNG preview path;
- build/report JSON path;
- mini-spec: role, objects, line styles, vertices/blocks, labels/sides, panel layout, target width;
- image-reading verdict, including whether the agent can read images and whether a human or
  independent model/subagent reviewed the preview;
- verifier identity: `self-vision`, `visual-subagent`, `human`, or `none`;
- fixes made after the image-reading verdict, if any;
- commands run;
- unresolved risks, if any.
