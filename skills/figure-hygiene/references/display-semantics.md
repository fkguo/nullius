# Final display semantics

Read this before accepting a scientific results figure or table, including
HTML and translated versions. The gate is `scripts/bin/check_display_acceptance.py`;
`display_semantics.py` is its adjacent helper, not another workflow.

## Reader selection and quantity identity

Declare the reader's purpose and the quantities to show before formatting.
Use scientific results appropriate to that purpose; keep computation diagnostics
and intermediate values in internal records unless the reader is studying them.
In that case name their reader purpose explicitly. Keep failure, missing and
non-applicable outcomes distinct. Filtering must not conceal contradictions;
inspect the full source inventory against the selected inventory and explain
scientifically relevant omissions. The script cannot decide what an audience needs.

Identify each quantity by object, conditions, reference and definition. Record
additional parameter, model, basis or other context wherever it changes identity.
Two reversible representations of that same identity are normally one result.
Allow both when there is an explicit use, such as reading in two unit systems.
Never merge values merely because they are close or share a label. Distinct
references, definitions, parameters, models or bases can define different quantities.
Exact identity comparison can flag undeclared duplicate representations; a person
must establish identity when different words name the same thing.

Presentation deduplication retains raw records and provenance. Duplicate evaluation
and duplicate output are different: do not remove an independent confirmation
because its display representation repeats another result. One canonical value per
claim refers to the same definition and representation, not to different unit tokens.

## Units, transformations and precision

Bind each raw value to its unit at acquisition and during every replacement.
Override the value-unit pair together; a missing replacement stops generation.
Record the raw source, canonical unit mapping, display transformation and final unit.
Check **after** the last override, unit conversion, rounding and translation.
An intermediate validated table is insufficient if later code rewrites its cells.

For an invertible mapping, the raw value must lie in the inverse image of the
final printed token's rounding interval. Equivalently, compare its forward image
with that interval. The gate uses the latter and exact decimal tokens. For a
printed number with last-place step $h$, it accepts the closed interval

$$
[d-h/2,\ d+h/2].
$$

Endpoints allow either tie convention. This is a display consistency check, not
a fresh numerical precision requirement. Use decimal/scientific notation with
a meaningful last printed place; `1.20`, `1.2` and `1.2e3` have different intervals.
Locale formatting and uncertainty expressions require faithful post-render
extraction into decimal tokens, with human inspection of their visible meaning.

For a non-invertible mapping, verify its definition, domain and forward image;
do not demand an inverse. The small helper supports identity, nonzero affine
maps and absolute value. Other mappings require a project-specific semantic
adapter/check; do not relabel them as identity to get a pass.

Choose displayed precision from the audience's use and the already accepted
uncertainty/tolerance. Do not infer a stricter calculation target from excess
page decimals, and do not recompute after the required accuracy has been reached.
Scientific convergence tolerances belong to `numerical-reliability-gate` and the
project contract; this skill does not redefine them.

## Components and final reading

Vectors, arrays and composite cells need a complete component map: identity,
order, units, normalization convention and definitions needed to interpret them.
A list of numbers or a collective label is insufficient. State the actual
normalization, including an unnormalized convention when appropriate. Only a
defined probability distribution requires the relevant probability normalization;
coordinates, signed coefficients and other components need not sum to one.

Flatten composite displays into identified leaf cells in the checking inventory.
Inspect the actual component labels and order. The helper requires every declared
component of a selected quantity; to show a scientifically meaningful projection
or subset, define that displayed quantity explicitly in the source inventory.

Inspect the final rendering, not just its generation log. Check each value against
its source mapping, the visible unit, quantity/component meaning, selection,
order, captions, headers and the reader's interpretation. A small table usually
needs a direct cell-by-cell read, not a synthetic overview plot. A larger figure
still benefits from the existing all-component overview and panel crops.

Repeat this check on each language after translation. Language labels may differ;
their identity and unit semantics must remain equivalent. Bilingual agreement
only establishes correspondence, not an independent scientific check.

## Sidecar contract

Keep the existing `plotted_quantities`, `verdict_bindings` and `overview_figure`
inside `display_acceptance`, and add required `final_display`. The result still
uses `display_gate_result_v1`; semantic failures are `verdict_mismatch` with a
specific finding kind. An old bundle remains historical evidence, but without
final semantics it does not grant a new display acceptance.

All paths are relative to the sidecar unless absolute. Pin source, final files
and extraction files with lowercase SHA-256 digests. All consumed JSON rejects
duplicate keys. Protected-input checks cover these paths even if missing.
If the sidecar has a top-level `figure` path, that file must be among the checked
final surfaces; an inspected translation cannot stand in for an omitted main display.

`final_display` has these fields (closed shape):

| Field | Meaning |
| --- | --- |
| `purpose` | Non-empty reader purpose. |
| `source` | `{path, sha256}` for the raw quantity inventory. |
| `selection` | Unique quantity IDs; must equal `plotted_quantities`. |
| `cells` | Ordered leaf cells `{id, quantity, unit, transform}`, plus `component` for array entries and optional `representation` for multiple component sequences. |
| `surfaces` | Final rendered files, each with the fields below. |
| `diagnostic_purposes` | Optional mapping from selected diagnostic/intermediate quantity ID to its reader purpose. |
| `dual_representations` | Optional list of `{cells: [cell IDs], purpose}`; exactly the groups repeating a reversible quantity/component identity. |

The raw inventory is `{quantities: [...], units: {...}}`; `units` is optional.
Each quantity has `id`, `identity`, `role` (`result`, `diagnostic`, `intermediate`)
and either `raw` or `components`. `identity` requires non-empty `object`,
`conditions`, `reference`, `definition` strings; additional named context strings
distinguish identities. A raw record is `{value: "decimal token", unit: "symbol"}`.
Optional `status` is `available`, `failed`, `missing` or `not_applicable`; the last
three require `value: null`, never a fake zero.

For arrays, use ordered `components: [{id, definition, raw}, ...]` and non-empty
`component_definition` and `normalization` strings instead of scalar `raw`.
Each leaf display cell specifies the corresponding `component` ID.
For multiple representations of an array, give each sequence a distinct
`representation` string on its cells. Every sequence must retain the complete
declared component order; sequences may be interleaved in a component-major
table. This is separate from `dual_representations`, which explains why each
repeated quantity/component is useful to the reader.

Built-in units: `1`, `%`, `s`, `ms`, `m`, `mm`, `cm`, `km`, `kg`, `g`.
Custom unit entries are `{dimension, scale: "decimal", offset: "decimal"}`;
canonical value is raw value times scale plus offset. Positive scales are
required and built-in symbols cannot be redefined. Custom dimensions, scales,
offsets and translated unit labels must be checked by a person; hashes cannot
prove they are scientifically valid.
If a visible unit label is itself a known symbol, its canonical mapping must
agree with the intended unit; translation cannot relabel seconds as milliseconds.

A cell transform has `kind` and a non-empty `definition`. `identity` converts
units directly. `affine` additionally requires decimal `scale` (nonzero) and
`offset`, applied **in canonical units before converting to the final unit**.
`absolute` takes the absolute canonical value before final unit conversion.
The source and final unit dimensions must agree. Non-invertible cells need
definitions that explain the changed meaning; the script does not infer it.

A surface has `path`, `sha256`, `format` (`html` or `extracted`), `language`,
`labels` (all cell IDs to final identity labels), `unit_labels` (all used unit
symbols to distinct final visible strings), and `review`. Optional `status_labels`
maps status tokens to distinct translated labels. `review` is
`{sha256: <same final digest>, readability: true, semantics: true}`: a record
of **actual final-render inspection**, never default booleans set by the generator.
It records a person's or visual agent's judgment, not independent proof.

For static HTML, mark each result table with `data-results`. Every result `td`
must have a unique `data-display-id` and exactly three flat spans:

```html
<table data-results>
  <tr><td data-display-id="interval">
    <span data-field="label">Elapsed interval</span>
    <span data-field="value">1.23</span>
    <span data-field="unit">s</span>
  </td></tr>
</table>
```

The helper reads the text actually in those spans, including the unit, not
an expected number hidden in an attribute. For dynamic HTML, CSS visibility,
localized numbers, headers carrying units, PDF/PNG charts or other layouts,
use `format: "extracted"` and `extraction: {path, sha256}`. Extract **after
rendering and all edits**, not from the generator's input. The extraction JSON
is `{surface_sha256: <final digest>, cells: [{id, label, value, unit}, ...]}`.
Inspect every extracted cell against the final rendering. Headers and captions
must be resolved into each leaf's identity/unit; array entries each get a record.

Here is a complete `final_display` structure for the HTML above (replace the
digest markers with the actual file digests):

```json
{
  "purpose": "report an elapsed interval",
  "source": {"path": "quantities.json", "sha256": "<source digest>"},
  "selection": ["interval"],
  "cells": [{
    "id": "interval", "quantity": "interval", "unit": "s",
    "transform": {"kind": "identity", "definition": "convert source milliseconds to seconds"}
  }],
  "surfaces": [{
    "path": "interval.html", "sha256": "<final digest>", "format": "html", "language": "en",
    "labels": {"interval": "Elapsed interval"}, "unit_labels": {"s": "s"},
    "review": {"sha256": "<final digest>", "readability": true, "semantics": true}
  }]
}
```

Its raw `quantities.json` is:

```json
{"quantities": [{
  "id": "interval",
  "identity": {"object": "sample", "conditions": "fixed protocol", "reference": "start", "definition": "elapsed interval"},
  "role": "result", "raw": {"value": "1234", "unit": "ms"}
}]}
```

For a small table, `overview_figure` may point to `interval.html` itself with
`archived: true`. Preserve the covering, byte-pinned `quantity_verdict_v1`
binding; the semantic check supplements that scientific verification.

## Automatic coverage and remaining judgments

The gate rejects missing identity/component mappings, unlisted quantities,
undeclared diagnostics, unintended reversible duplicates, wrong dimensions,
wrong final value-unit pairs, stale final/extraction bytes, missing rendered
inspection records and incorrect cell labels/order. It checks decimal rounding
intervals, and forward maps for the supported non-invertible transform.

It cannot prove source correctness, identity equivalence expressed with different
words, custom unit definitions, transformation suitability, reader relevance,
honest filtering, independent verification, or the truth of an inspection receipt.
Static parsing cannot detect CSS-hidden content, dynamic DOM changes or unmarked
result regions. Extraction hashes bind bytes but do not prove extraction fidelity.
Inspect those matters explicitly; unresolved meaning or incomplete final-render
coverage prevents acceptance even if the mechanical gate passes. After any final
edit, regenerate extraction, inspect, re-pin and rerun; do not merely refresh hashes.
