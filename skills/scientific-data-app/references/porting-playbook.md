# Porting an existing dataset app to a new dataset

Use when a working app over dataset A should become app B over dataset B (the reference
case: Particle Library over PDG → Nuclear Library over nuclear data). The goal is to carry
proven parts and drop domain assumptions, not to fork and rename.

## 0 · Licence and provenance first

- Read the source licence before copying anything. MPL-2.0 is file-level: modified MPL
  files stay MPL, new files may use another licence; keep the notices. Record the
  decision in `PORT_LEDGER.md`.
- Data licences are separate and are never inherited from the code licence.
- Keep the split: public code repository, private design/operations repository
  (`<Project>-Internal`). Review records, signing details and internal plans stay private.
- Attribution and third-party notices move with the files, not with the repository.

## 1 · Inventory by layer

| Layer | Examples | Usually portable? |
| --- | --- | --- |
| app shell | navigation, layout classes, theme, shortcuts, boot, error text, update check, backup | yes, mostly |
| core | paths, error types, contract helpers | yes |
| data access | SQL executor, snapshot store, background isolate gateway, hash/verify/atomic install | yes |
| domain | models, display objects, parsers, aliases | structure yes, content no |
| features | pages and flows | selective |
| user data | notes, favourites, settings, backups | yes |
| tooling/CI/release | version generator, asset checks, CI jobs, release scripts | yes |
| assets | dataset files, indexes, brand, store metadata | dataset no, brand no |

## 2 · Classify before touching code

Write one row per file or module in `PORT_LEDGER.md`:

| Decision | Rule |
| --- | --- |
| REUSE | no domain nouns; tests carry over unchanged |
| ADAPT | structure is right, nouns/schema change |
| REWRITE | data semantics differ; keep the shape, not the code |
| DROP | domain-specific feature the new product does not need |

A file that contains a domain noun in a type name, string, error message or test is not
REUSE. Classify by the *most* domain-coupled line, not by the file's directory.

## 3 · Strip rigorously

- Delete, do not comment out. Dead code with old nouns will be re-enabled by a later
  session.
- Rename package, bundle identifier, app name, database asset names, CI variables.
- Remove old assets and string tables wholesale; do not "keep for reference".
- Run the leak checklist (§7) until it is clean.

## 4 · Freeze the new atlas and contract before wiring the UI

The old data layer demonstrates *what a good data layer looks like* (read-only dataset,
background connection, lossless rows, display object separate from raw values, stable
status codes). It is not evidence about the new dataset. Do G0 and G2 for the new data
before porting a single page.

## 5 · Replace fixtures; port tests by category

| Test category | Action |
| --- | --- |
| live-dataset tests | rewrite against the new dataset; expected values come from the dataset |
| negative tests | keep the pattern; new error cases |
| widget/layout tests | adapt flows, keep the layout-class assertions |
| display/golden tests | regenerate from the new dataset; never copy expected values |
| integration test | write a new end-to-end flow on real records |

Rule: expected values are derived from the dataset, never from the old app's output.

## 6 · Re-run every gate

Old "done" claims do not transfer. The new atlas, contract, rules, matrix and release
record each pass on their own. A port is not complete because the UI renders.

## 7 · Domain-leak checklist

Search the whole tree (code, tests, docs, CI, assets, package metadata) for:

- old dataset names and abbreviations, old identifier prefixes, old file names;
- old entity nouns in type names, strings, error messages and help text;
- old URLs, DOIs, citation text, store descriptions, bundle IDs;
- old environment variables and CI repository variables;
- old fixture paths and expected values;
- old screenshots and brand assets.

A grep that returns only deliberately-kept historical notes is the target.

## 8 · What not to port

- The old dataset's value-selection logic ("best" summary, preferred edition).
- The old versioning model when the new data has per-record provenance.
- Domain-specific parsers and their frozen rules (port the *method*, freeze new rules).
- Branding, store copy and screenshots.
- Old review records as evidence for the new app; they are evidence about the old one.

## 9 · Exit criteria

- `PORT_LEDGER.md` has a decision and a test note for every copied module.
- The leak checklist is clean.
- G0–G4 pass on the new dataset.
- A build runs on each targeted platform with the new data.
