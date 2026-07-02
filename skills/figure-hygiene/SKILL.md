---
name: figure-hygiene
description: "Correctness and legibility checklist for data/results figures in any field: charts, parameter scans, spectra, distributions, fit comparisons, constraint contours, heatmaps, and low-dimensional projection scatters. Use when an agent plots computed or measured data, revises a results figure for a manuscript, or audits whether a data figure is publication-ready. Covers data fidelity (excluded rows never enter plotted summaries, claim-titles true against every axis category, one canonical value per claim), label economy floor and ceiling, colour threading with a CVD-safe palette, role-mapped typography, chart choice by data shape, a render-then-verify QA loop (bbox overlap check plus per-panel perceptual crops), and a figure-reproduction provenance bundle. For schematic/topological figures such as process diagrams, integral-equation schematics, and geometry sketches, use physics-diagrams instead; this skill owns figures whose content is data."
---

# Figure Hygiene

Use this skill to make data/results figures correct, legible, and reproducible. It is a checklist, not a house style: frame, font, and palette are parameters, and the rules below say what must be true of the figure, not what it must look like. The unit of work is one figure; run the checklist before delivering any figure whose content is computed or measured data.

## Boundaries

- Use `physics-diagrams` for schematic/topological figures: process diagrams, integral-equation schematics, block/recursion schematics, geometry and coordinate sketches. This skill owns figures whose marks encode data values.
- This skill checks the figure, not the numbers. Verify plotted values through the project's own computation pipeline and numerical gates (for example `numerical-reliability-gate`) before styling them; a beautiful figure of an unverified number is still unverified.
- The presentation rules that are universal — colour threading, CVD safety, label economy floor and ceiling, role-mapped typography, render-then-verify — apply to schematics as well; `physics-diagrams` cross-references them here and stays scoped to schematic content.
- Use `review-swarm` or an independent visual reviewer for submission-bound figures after the checklist passes.

## Correctness Versus Guidance

Data fidelity, the label-economy floor, the anti-pattern list, and render-then-verify are **correctness**: they apply to every figure, in every context, and have no aesthetic content. Colour, typography, chart choice, and layout are **guidance**: strong defaults that a deliberate, stated alternative may override. Individual guidance rules that state a perceptual or factual invariant — semantic-zero centring of diverging maps, CVD safety, leader-line anchoring — still bind even inside guidance sections.

## Data Fidelity

- **Excluded rows.** A row marked excluded or flagged in the source data is either omitted entirely or drawn with a visually distinct open/hatched marker named in the key. It never enters a summary statistic plotted alongside the included rows.
- **Comparable conditions only.** Conditions measured under non-comparable protocols (different sample size, budget, configuration, or procedure) are not plotted as visual peers. Separate them with a facet break or a marker on the label, and state the difference once in the caption.
- **Self-consistency.** Every key, threshold, and title inside the figure must be satisfied by every plotted row. Before saving, walk each categorical outcome label back to the rule that defines it; if a row's value contradicts its label or the title, the figure is wrong, not the data.
- **Claim-titles must be true.** A sentence-title is tested against every category on the axis before rendering. If any category contradicts it, qualify the title ("on 3 of 4 cases") or downgrade it to a description.
- **State n and what was held fixed.** Every panel that draws a summary mark states the number of observations and the unit of replication; every small multiple that holds a variable fixed states the fixed value — in the panel or, when the label budget is tight, in the caption.
- **Reference structure is reference.** An ordering, grouping, or hierarchy drawn as context uses an established external reference, not one inferred from the plotted data. Infer the structure only when the structure is itself the result.
- **One number per claim.** A quantitative claim (runtime, accuracy, count, best-fit value) has exactly one canonical value across every panel, the caption, and the abstract. Define what it measures and use that value everywhere.

## Label Economy: Floor and Ceiling

The figure shows the pattern; the caption carries the context. Design for a general scientific reader, not the author.

- **Floor (non-removable).** Every distinct mark, series, glyph, or comparator must be identifiable from the figure alone. A label is non-removable if deleting it leaves a reader asking "what is that?"; it is removable only if the question becomes "why is that there?". Comparator labels name the thing ("prior method", "no joint fit"), never a bare role word ("baseline", "previous"). Any term a general scientist cannot parse gets a one-word gloss.
- **Ceiling.** Per panel: title, axis labels, tick labels, series identity, and at most 2 or 3 narrative annotations. Count the strings; more than 6 beyond axes and ticks means the panel is over budget. The ceiling counts narrative annotations (callouts, value labels, brackets); identity labels are floor, not budget.
- **Move to the caption:** number of observations, what was held fixed, abbreviation expansions, non-comparable footnotes, exclusion rationale, methodological caveats.
- **Titles are takeaways.** A reader seeing only the title knows what the panel shows. "Robust to dropped inputs" passes; "Fewer inputs" fails. Read it aloud cold — if the listener asks "fewer inputs, so what?", rewrite. For a row of small multiples that vary one thing, drop per-panel titles for one row header.
- **Value-on-mark only for the headline number** — the one a reader would quote. Everything else is read off the axis.
- **When in doubt, delete the label and re-read.** If the message survives, the label stays deleted.

## Colour Threading

- **One colour, one entity.** Once a colour is bound to an entity (a method, a condition, a dataset), reuse that exact colour for every mark representing that entity — line, fill, marker, text, heatmap row. Colour is the cross-reference; a reader should never consult a legend twice.
- **Limit hues.** Use as few distinct hues as the data require. Make a focal series visually dominant (saturated, heavier weight) and comparators lighter or desaturated. The focal hue must not coincide with any hue of a categorical palette used in the same figure, and the focal series must stay identifiable even where its mark is zero-width or coincident with others.
- **Nested categories.** When categories nest, the outer level picks the hue family and the inner level samples within it.
- **Continuous and diverging (binding).** Use a perceptually uniform sequential map for generic continuous values; a single-hue ramp for ordinal rank or size; a diverging map for signed quantities — always centred at the semantically meaningful zero (0, 1.0, or the reference median), never the data midpoint.
- **CVD safety (binding).** Never rely on a red/green contrast for a binary or opposing distinction; any binary pair must survive deuteranopia simulation. Reserve one high-salience alarm hue for error/anomaly marks and do not reuse it as a data-series colour. The helper's default palette (Okabe-Ito with the vermillion slot held out as the alarm hue) satisfies this.
- **Two palettes, two legends.** When a figure uses two categorical colour systems, each legend sits adjacent to the first panel where its palette applies.

## Typography

- **Sentence titles.** A panel title states the comparison in plain language, regular weight, left-aligned. Metric names go on the axis, not in the title.
- **Role-mapped size ladder.** A figure uses at most three font sizes, mapped to role, not to available space: titles, axis labels, and series identity at the base size; legend and annotation text one step down; tick labels one step further. Panel letters are the only exception (bold, larger). If a label does not fit at its role's size, fix the layout or shorten the text; do not invent an intermediate size. `apply_figure_style(sizes=(9, 8, 7))` sets the ladder.
- **Nomenclature.** Names that a field's convention italicises are italicised; abbreviated codes inherit the rule. Expand every abbreviation once on first appearance.
- **Magnitude suffixes.** Large counts use k / M / B forms ("4.2B", "120 k"), not comma-grouped full numerals.
- **Numeric annotations.** On-mark numbers use at most 2 significant figures — unless that rounding would print two distinct rows as the same value, in which case show the digit that separates them. Text on a filled mark needs at least 4.5:1 contrast; otherwise place the text outside the mark.
- **No internal codes.** Axis labels use plain-language names; codebase abbreviations appear only in parentheses after the readable name or in the caption.
- **Panel letters.** Bold, top-left, outside the axes box; case follows the target venue. Refer to them in prose as "panel a" or "panels a and b".

## Chart Choice by Data Shape

Choose the chart family from the shape of the data and the number of observations, and prefer showing the distribution over showing only a summary:

- **Categorical versus numeric:** jittered strip with a median tick for small samples; box or violin for large ones; bar plus raw points or an interval when the mean is the message. A category absent from a group is marked explicitly ("n.d.", a dash, or a hatched ghost) — an empty slot reads as zero — and a zero-valued bar gets a visible stub.
- **Single observations:** a filled dot with a thin neutral stem to the semantic zero (lollipop), value label beside the dot.
- **Continuous series:** the per-x summary as a line with markers, individual runs as thin translucent lines behind it, and direct text labels at line ends in preference to a legend box.
- **Overlapping distributions:** stacked panels with a shared x-axis or a ridgeline; overlay only when the separation is visually clear.
- **Matrices:** when a heatmap is small enough to read, print the value in every cell and state the threshold once in the colourbar label.
- **Low-dimensional projection scatters** (for example a learned 2-D embedding): drop ticks and tick labels, name the axes with a small corner arrow pair, and label clusters by thin leader lines into surrounding whitespace.
- **Label the extremes.** On a scatter of named observations, direct-label at least the maximum, the minimum, and any flagged point; after rendering, verify every leader endpoint terminates within one marker radius of the row it names.

Read [references/chart-choice.md](references/chart-choice.md) for the full taxonomy, including axes, scales, small multiples, and layout rules.

## Anti-Patterns

These are correctness failures, not style preferences:

- Red and green as opposing categories.
- Filled bars on a log-scaled value axis (bar length encodes the ratio to an arbitrary floor).
- A diverging colormap centred at the data midpoint instead of the semantic zero.
- Colourbar ticks that are evenly spaced but miss the semantic centre.
- An axis title that restates the tick labels.
- The direction of goodness explained only in the caption.
- A reference line drawn at a value that is itself one of the plotted points.
- An excluded row that enters a plotted summary statistic.
- A leader line whose nearest mark is not the row it labels.
- A claim-title contradicted by a category on its own axis.

## Render, Then Verify

Saving the file is not the end of the task. After the figure renders, run both checks:

1. **Geometric check.** No visible text may overlap another text or an axes spine (a tick label sitting on its own spine is not a finding), and every text must lie inside the figure canvas. The bundled helper runs this on every figure a plotting script leaves open:

```bash
python3 "$SKILL_DIR/scripts/bin/figure_qa.py" --script figs/src/scan_summary.py
```

Fix findings by moving, shortening, or staggering labels, then re-run until clean. Inside a live Python session, call `check_figure(fig)` from the same script instead.

2. **Perceptual check.** The geometric check will not catch a low-contrast label, a leader line that crosses three others, or two confusable series colours. Emit one crop per panel and look at each:

```bash
python3 "$SKILL_DIR/scripts/bin/figure_qa.py" --script figs/src/scan_summary.py --crops-dir /tmp/figure-qa-crops
```

For each crop ask: is every glyph and mark legible against its background? Does the smallest plotted element have a stroke or stub? Do any leader lines cross? Could any series colour be mistaken for another? Does the legend sit beside what it keys? A perceptual defect that passes the geometric check is still a defect.

State explicitly whether the current agent can actually read the crop images in this session. If it cannot, mark the figure NOT publication-ready until a human or a visual reviewer inspects the crops.

## Figure Reproduction Provenance

A durable or submission-bound figure must re-render from recorded inputs. Bind the data table, the generation script, the style configuration, and a checksum of the output in a small sidecar manifest next to the figure:

```json
{
  "figure": "figs/scan_summary.pdf",
  "data": ["data/scan_results.csv"],
  "script": "figs/src/scan_summary.py",
  "style": "figs/src/style.json",
  "command": "python3 figs/src/scan_summary.py",
  "sha256": {
    "figs/scan_summary.pdf": "<hex digest>",
    "data/scan_results.csv": "<hex digest>"
  }
}
```

Anyone (including a later agent) must be able to re-run the command and diff the output against the checksum. If the regenerated figure differs beyond recorded nondeterminism, the figure and its numbers are out of sync: stop and reconcile before the figure is used anywhere. This bundle is what makes the checklist enforceable — a figure that cannot be regenerated cannot be re-verified.

## Review Gate

- For submission-bound figures, run an independent reviewer on the rendered figure and its data table, not on a prose description. Ask it to check the data-fidelity items against the source table, not only the aesthetics.
- Do not re-decorate a passing panel. Between revision rounds, a panel that already passes is not made more visually complex to fix nothing; adding marks or labels to a clean panel is a regression.
- After fixing reviewer findings, re-run render-then-verify and the reviewer on the fixed figure before declaring it done.

When in doubt: fewer hues, more direct labels, raw data over summary statistics, and state what is being measured before showing the result.
