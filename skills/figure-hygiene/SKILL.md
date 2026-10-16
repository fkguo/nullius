---
name: figure-hygiene
description: "Check scientific results figures and tables, including HTML and multilingual displays, for data fidelity, final value-unit semantics, quantity/component identity, reader selection, legibility and reproducibility. Use when creating, revising or auditing computed or measured results for display. Includes connected-series provenance; a rendered continuous field is continuity-scanned before delivery. For schematic/topological drawings use physics-diagrams."
---

# Figure Hygiene

Use this skill before delivering scientific results figures or tables, including HTML and multilingual versions. Apply chart-specific rules to charts and cell semantics to tables. Keep checks proportional to the display: inspect an ordinary small table directly; do not create a meaningless overview plot.

## Boundaries

- Use `physics-diagrams` for schematic/topological figures: process diagrams, integral-equation schematics, block/recursion schematics, geometry and coordinate sketches. This skill owns figures whose marks encode data values.
- Verify source results through the project's numerical gates (for example `numerical-reliability-gate`); this skill checks their final presentation. Display precision inherits the purpose and the project's agreed tolerance. Extra page decimals do not authorize tighter calculation tolerances or further computation once the required accuracy is reached.
- The presentation rules that are universal — colour threading, CVD safety, label economy floor and ceiling, role-mapped typography, render-then-verify — apply to schematics as well; `physics-diagrams` cross-references them here and stays scoped to schematic content.
- Use `review-swarm` or an independent visual reviewer for submission-bound figures after the checklist passes.

## Correctness Versus Guidance

Data fidelity, the label-economy floor, the anti-pattern list, and render-then-verify are **correctness**: they apply to every figure, in every context, and have no aesthetic content. Colour, typography, chart choice, and layout are **guidance**: strong defaults that a deliberate, stated alternative may override. Individual guidance rules that state a perceptual or factual invariant — semantic-zero centring of diverging maps, CVD safety, leader-line anchoring — still bind even inside guidance sections.

Script paths below are relative to `$SKILL_DIR`. Set it if the host does not provide it:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/figure-hygiene" ] && echo "$r/skills/figure-hygiene" && break; done || true)}"
```

## Data Fidelity

- **Excluded rows.** A row marked excluded or flagged in the source data is either omitted entirely or drawn with a visually distinct open/hatched marker named in the key. It never enters a summary statistic plotted alongside the included rows.
- **Comparable conditions only.** Conditions measured under non-comparable protocols (different sample size, budget, configuration, or procedure) are not plotted as visual peers. Separate them with a facet break or a marker on the label, and state the difference once in the caption.
- **One connected series, one evaluator fingerprint.** Before drawing a line, interpolation, fitted band,
  or pooled summary through rows originating in multiple checkpoints/runs, verify that every joined row has
  the same complete evaluator fingerprint. The fingerprint covers model/branch choices, all top-level and
  nested/defaulted numerical settings, source/dependency hashes, and the plotted-value transformation.
  Matching a few legend-visible settings is insufficient. Missing or mixed fingerprints are a correctness
  failure: recompute uniformly, or split/facet the configurations and identify them separately. Check every
  plotted component; a smooth insensitive coordinate can conceal heterogeneity that appears as a kink in a
  more sensitive coordinate. Use `"$SKILL_DIR/scripts/bin/check_series_provenance.py"` as the deterministic gate once the
  plotting table exposes `series_id` and `evaluator_fingerprint` (or explicitly named equivalent columns).
- **Rendered-field continuity.** When a figure renders a computed field of a quantity the underlying theory
  says is continuous across the plotted domain except at declared singularities, scan neighbour-to-neighbour
  differences across the whole raster **before the figure is presented as delivered**, and report the worst
  delta together with the scan. A jump that does not sit at a declared singularity is a defect to trace to
  its mechanism — a threshold inside the evaluator that switches the size of the working problem, a code
  path that flips, a cell left over from an earlier run — **never an annotation to write on the figure**.
  The scan is mechanical, and precedes presentation, exactly because a smooth-looking rendering is what
  hides such a defect: the eye certifies the smooth majority, an isolated jump reads as texture, and the
  wrong values travel on into tables and conclusions.
- **Fail-closed substitution of corrected values.** When corrected values replace superseded stored rows
  in a figure or table pipeline — after an upstream defect fix — the substitution must fail closed: a
  missing corrected value raises an error and stops the render; it never silently falls back to the
  superseded stored number. A silent fallback re-publishes the defect exactly where the correction is
  incomplete, behind marks that look current. (The recomputation obligation itself is
  `numerical-reliability-gate` G6; this rule is its display side.)
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
- **Numeric annotations.** Choose precision from the reader's purpose and the accepted uncertainty. Two significant figures are a useful on-mark default when sufficient; show more only when the purpose requires distinguishing rows, and never imply unsupported accuracy. Text on a filled mark needs at least 4.5:1 contrast; otherwise place the text outside the mark.
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
- A connected line, interpolation, fitted band, or pooled summary spanning missing or different complete
  evaluator fingerprints.
- A leader line whose nearest mark is not the row it labels.
- A claim-title contradicted by a category on its own axis.
- A neighbour-to-neighbour jump in a rendered field, away from any declared singularity, annotated on the
  figure instead of traced to its mechanism.
- A corrected-value substitution that silently falls back to a superseded stored row when the corrected
  value is missing.

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

A durable or submission-bound figure must re-render from recorded inputs. Bind the data table, the generation script, the style configuration, and a checksum of the output in a small sidecar manifest next to the figure.

For the source-to-cell sidecar and complete examples, read [references/display-semantics.md](references/display-semantics.md). Keep chart-specific `series_provenance` alongside the `display_acceptance` block; check connected rows before rendering.

Anyone (including a later agent) must be able to re-run the command and diff the output against the checksum. Run the series-provenance command before rendering; it must fail if any connected series has a missing or mixed fingerprint. If the regenerated figure differs beyond recorded nondeterminism, or the provenance check fails, the figure and its numbers are out of sync: stop and reconcile before the figure is used anywhere. This bundle is what makes the checklist enforceable — a figure that cannot be regenerated cannot be re-verified. When the figure enters a manuscript gated by the research-writer skill, this bundle is the figure-side instantiation of that skill's traceability manifest: mirror the figure's checksum into the manifest entry so the manuscript-side result-traceability gate verifies the same bytes.

## Display Acceptance Gate

A new display is a new observable. Before a figure or table becomes durable or outward-facing, read [references/display-semantics.md](references/display-semantics.md) and check the **final rendered output after all overrides, conversions, rounding and translations**. Correct sources, successful generation, matching translations and pinned verification evidence do not establish final cell correctness.

The provenance manifest's `"display_acceptance"` block contains:

- **`plotted_quantities`** — every displayed quantity, including table cells and explicitly requested diagnostics.
- **`verdict_bindings`** — one byte-pinned, covering verification verdict per quantity, using the closed `quantity_verdict_v1` contract. Only `pass` is accepted; the manifest cannot widen acceptance.
- **`overview_figure`** — an archived inspection surface with `path`, `archived: true` and optional `sha256`. For a multi-component figure use an all-component overview. For an ordinary small table the final table itself is sufficient; no extra plot is required.
- **`final_display`** — the source values/units and quantity identities, intended reader selection, component mapping, display transformations and final surfaces. The same gate checks the final value-unit combinations, rounding intervals, cell labels/order, and unintended reversible duplicate representations. Explicit useful dual representations are allowed; numerical proximity never establishes duplicate identity. Keep raw evidence and independent evaluations.

Array and composite cells require complete component identities, order, units, definitions and normalization conventions. Do not assume every vector is a probability distribution. Requested diagnostics may be results for that reader; keep failure, missing and non-applicable statuses distinct and do not hide contradictions by filtering.

HTML is read directly through the restricted static adapter; other formats use a byte-bound post-render extraction. Both require an actual inspection of the final rendering for completeness, readability and scientific meaning. Translation correspondence is not independent scientific validation. The reference defines the automatic checks and the judgments they cannot make.

A minimal bound verdict artifact is:

```json
{
  "schema_id": "quantity_verdict_v1",
  "schema_version": 1,
  "quantities": ["quantity_a"],
  "verdict": "pass"
}
```

The verdict is computed by the gate script and only there; the caller must not self-assess or override it:

```bash
python3 "$SKILL_DIR/scripts/bin/check_display_acceptance.py" --manifest figs/scan_summary.provenance.json --json
```

The gate is fail-closed — missing or unverifiable evidence is a failure, never a pass — and emits a `display_gate_result_v1` payload whose `result` carries a falsification label: `pass`, `missing_verdict_binding` (a plotted quantity has no binding, or the block/denominator is undeclared), `verdict_mismatch` (the bound artifact's hash does not match the pinned digest, it does not satisfy `quantity_verdict_v1`, it does not cover the plotted quantity, its outcome is not accepted, or final display semantics fail), `missing_overview_figure` (the overview checkbox is absent, unaffirmed, or the file is gone), or `invalid_manifest` (the manifest itself is unreadable). Exit codes: 0 pass, 1 gate failure, 2 unreadable manifest, invalid invocation, or unsafe output persistence (all emit a machine-readable fail-closed payload). Every consumed JSON document rejects duplicate keys recursively. Optional `--out-json` output is written by same-directory atomic replacement and is refused if it aliases, contains, or is contained by the manifest, any bound verdict artifact, the overview, source data, final surfaces, or post-render extraction inputs—even when a declared input does not yet exist. If an ambiguous or unreadable manifest prevents complete input-slot discovery, no output file is persisted. Run the gate as the last step before the display leaves the project: a display whose gate does not return `pass` does not enter any display surface, and "the figure is already in the draft" is not an exemption — it is the failure mode.

## Review Gate

- For submission-bound figures, run an independent reviewer on the rendered figure and its data table, not on a prose description. Ask it to check the data-fidelity items against the source table, not only the aesthetics.
- Do not re-decorate a passing panel. Between revision rounds, a panel that already passes is not made more visually complex to fix nothing; adding marks or labels to a clean panel is a regression.
- After fixing reviewer findings, re-run render-then-verify and the reviewer on the fixed figure before declaring it done.

When in doubt: fewer hues, more direct labels, raw data over summary statistics, and state what is being measured before showing the result.
