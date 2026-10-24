# Gates — full conditions

Each gate produces one artifact. The artifact — not the conversation — is the interface
between sessions, models and people. A gate can be re-opened by new evidence; that is
normal and is recorded, not hidden.

The gate order is not negotiable: **G0 → (G1 ∥ G2) → G3 → G4 → G5**. G0 alone first,
because everything downstream is a claim about the data. G1 and G2 may run in parallel
once the atlas exists. G3 needs the contract. G4 needs the frozen rules. G5 is last.

Freshness: a gate is fresh when its artifact is bound to the current dataset version and
contract revision. A dataset update re-opens G0, G3 and G4. A contract change re-opens
G2, G3 and G4.

---

## G0 — Data atlas

**Purpose.** Make the dataset legible before any UI, contract or query is designed. The
atlas is the only document that answers "what is actually in here, and what is not".

**Required content**

- Source identity: origin URL, version, release date, byte size, hash algorithm and
  value, licence pointer.
- Record inventory: every table (or file/record type) with row count, primary key,
  purpose, and where it will appear in the app.
- Field inventory: type, nullability, empty-vs-null, unit, encoding, and a destination
  for every field — *shown*, *deliberately hidden* (with reason), or *unknown*.
- Identity: what makes each object unique, and what does **not**. Listing rows vs entity
  rows; generic family names; identifiers shared by several entities; isomer/charge
  states that share an identifier.
- Relations: foreign keys, weak or string joins, one-to-many and many-to-many edges,
  cross-source relations, and which relations are load-bearing for the product.
- Cross-source section (if the dataset has more than one source): which quantities
  overlap, which disagree, and what the app must show when they do.
- **What the data cannot provide**: a specific negative list. This section is the most
  valuable one; it prevents invented features and invented values.
- Verification: reproducible commands, expected counts, and who re-derived them
  independently.

**Pass condition**

- Every field has a destination; no field is described by its display name alone.
- An independent reviewer re-derives the counts from the dataset and matches the atlas.
- The negative section is non-empty and specific (not "some edge cases").
- Identity ambiguities are enumerated with at least one real counterexample.

**Evidence from the reference build.** The atlas covered 15 tables and 128 fields and was
checked three ways (atlas ↔ schema contract ↔ live database). A review found that a
category mapping derived from a flag alone misfiled 30 roots — some of which had no
entity identity at all — and that a paper's photon was assumed to be a generic name when
it was a concrete row. Both errors came from interpreting a display-level attribute as
identity.

**Does not prove.** That every quantity is physically understood, or that the negative
list is complete.

**Exit.** `check_kit.py --gate G0` passes, and the atlas hash is recorded.

---

## G1 — Product and UX

**Purpose.** Decide what the user does, with real data, before implementation. Product
defects found here are cheap; found after the UI is built they are rewrites.

**Required content**

- Users and jobs, in one paragraph each.
- Five primary flows, each with a **named real example** (a record key that exists in the
  dataset), from arrival to result and back.
- Navigation model. Names and symbols are the primary axis; opaque identifiers are one
  query mode, never the main way to find something. Back/forward and state restoration
  are part of the model.
- Notation and search: case, unicode, aliases, charge/isomer/state, units; explicit
  "no silent replacement" rule; candidate lists for family names.
- States: loading, empty result, not-recorded, error, offline, stale data, partial
  dataset. Each has a rendering and a recovery action.
- Layout classes (compact / medium / expanded) and the platform matrix; a feature is not
  "done" on a platform without a layout check there.
- Accessibility and copy rules: text selection and copy on every value; read-aloud
  labels; contrast; no defensive filler wording.
- Non-goals.

**Pass condition**

- Every required flow has a real example and a defined end state.
- No primary flow requires the user to know an opaque ID.
- Every state has a rendering; no state is silently mapped to "no data".
- Copy terms are defined in one place; user-facing strings contain no engineering
  hedging.

**Evidence from the reference build.** The first implementation was rejected repeatedly by
the owner: the home page had nothing but a search box, entry identifiers were unusable as
the primary navigation, the same interaction behaved differently on different pages, and
user-visible copy contained defensive AI phrasing. These were product-level defects that
no amount of styling fixed.

**Does not prove.** Usability on a device, or accessibility conformance.

**Exit.** A criteria-first review record ([criteria/product.md template](../assets/templates/criteria/product.md))
plus `check_kit.py --gate G1`.

---

## G2 — Interface contract

**Purpose.** Fix the boundary between data and UI so the data layer is reviewable without
reading widgets.

**Required content**

- Interface list: name, input, output, status, errors, pagination, provenance.
- Status semantics: `success` / `notFound` / `error`. An existing object with an empty
  child list is `success`; only a missing parent is `notFound`. This distinction is where
  most silent data bugs enter.
- Stable error codes; no raw exception or driver error escapes the boundary.
- Provenance on every returned object: source table/record type, row or record key, and
  the dataset hash/version.
- Pagination: keyset (not offset) with the exact cursor contents; the union of pages must
  equal the full set, and the contract says how that is checked.
- Invariants: dataset opened read-only; every user value bound as a parameter; list
  arguments chunked; the UI never issues SQL or reads raw rows.
- What the UI may not do (recompute units, derive lifetimes, merge sources, hide nulls).
- Versioning: contract revision, compatibility rule, and what happens on dataset
  mismatch.

**Pass condition**

- Empty vs missing is distinguishable in every interface.
- Every interface returns provenance; the negative cases are named and tested.
- No UI path can bypass the data layer.

**Evidence from the reference build.** A fidelity review found a HIGH divergence: a
missing parent was reported as an error instead of `notFound`, which the UI would have
rendered as a broken page rather than "not recorded". Two provenance gaps and one
handle leak on a validation-failure path were found in the same round.

**Does not prove.** That the implementation matches the contract.

**Exit.** `check_kit.py --gate G2` passes, and a fidelity review has run against a real
build.

---

## G3 — Frozen rules and fixtures

**Purpose.** Make parsing and display semantics explicit, partitioned over the whole
dataset, and testable before implementation. This is the highest-value gate for a data
app and the one most often skipped.

**Required content**

- Layers: what is in scope now, what is explicitly deferred, and the fallback for
  deferred input (usually an opaque "show the original text" state). Deferred classes are
  counted, not hand-waved.
- Rules with stable IDs: input, output, examples and counterexamples drawn from the real
  dataset.
- **Partition over the full dataset**: a table whose counts sum to the total number of
  records in scope, with the SQL or command that produced each count. Partition totals
  are the guard against "the rules cover what I happened to test".
- Fixture: path, generator (independent of the app implementation, no imports from app
  code), regeneration command, and the determinism requirement — two runs must be
  byte-identical, and the committed fixture must match a fresh run.
- Change control: rules first, fixture second, implementation third. A rule change that
  does not change the fixture is suspicious.
- An erratum of the "the document was wrong, the data won" kind, recorded, not silently
  edited.

**Pass condition**

- The partition sums to the full set; every deferred class has a count and a fallback.
- The generator is independent and deterministic; regeneration matches the committed
  fixture.
- Every rule has a named positive and a named negative example.
- Uncovered syntax resolves to the opaque fallback, never to a guessed value.

**Evidence from the reference build.** 7,938 decay modes were partitioned into strict,
inclusive, excluded and out-of-scope classes. The freeze caught a document example that
contradicted its own rule (a generic neutrino name that could not be a unique identity)
and a charge collapse in the fixture (K⁺ and K⁻ shared a listing row). The independent
generator also corrected a count in the document — the lockstep working exactly as
intended.

**Does not prove.** That the rules are physically correct. Only that they are explicit,
complete over the partition, and consistently applied.

**Exit.** `check_kit.py --gate G3` passes; the generator runs twice byte-identically and
matches the committed fixture.

---

## G4 — Acceptance matrix

**Purpose.** Turn every known trap into an executable or visually checkable acceptance
item, using real records, plus exhaustive sweeps where sampling would miss regressions.

**Required content**

- Per flow: real example, expected display, expected copy/read text, expected status.
- Trap table from the atlas: trap → real example → expected behaviour → what a wrong
  implementation would show.
- Failure states: missing record, corrupt dataset, offline, stale version, partial
  dataset, permission failure.
- Exhaustive sweeps: what is swept (usually the whole dataset), the command, and the
  expected mismatch count (normally zero). A sample is not a sweep.
- Synthetic items clearly labelled, with the reason they are synthetic.
- A "not covered" section listing what this matrix does not test.

**Pass condition**

- Every trap in the atlas appears with a real example.
- Display rules are swept over the full dataset, not a sample.
- Synthetic examples are labelled and kept out of coverage claims.

**Evidence from the reference build.** Seven mandated real examples exposed a magnitude
loss: the formatter checked a text column while displaying a different one, dropping
×10⁻² on real rows (63%/87% of the value). A later fix dropped a percent marker on ~550
rows; only a full-dataset sweep caught it. The seven examples were not enough — the sweep
was.

**Does not prove.** Performance, accessibility, or that the matrix is complete.

**Exit.** `check_kit.py --gate G4` passes; sweep output is attached to the record.

---

## G5 — Release

**Purpose.** Make distribution claims true on each platform, and make the data and key
custody auditable.

**Required content**

- Toolchain: verified versions, host, and the command that produced each result. Only
  measured values; no pre-filled versions.
- Data licensing: per dataset, the terms, attribution text, redistribution rights, and
  what is *not* redistributed.
- Signing and key custody: where the key lives, how it is backed up, what breaks if it is
  lost, and the rule that it must never be regenerated casually.
- Update channel: manifest, hosting fallback, and the check that a released build sees
  the right version.
- Release-asset pointer: if downloads resolve through `releases/latest`, a new code
  release silently moves the data pointer. State how this is handled — keep the data
  release latest, publish the code release with `latest=false`, or pin asset URLs — and
  verify the asset URL after publishing.
- Platform matrix: built / smoked / untested, per platform. A macOS build is not evidence
  for Windows.
- Checklist: version and build number consistent across app, manifest and store metadata;
  data asset hash verified; tests green on release configuration.
- Rollback: what the user does if an update is bad.

**Pass condition**

- Every claimed platform has a real build and a smoke test recorded.
- Data terms and attribution are recorded; redistributed assets are listed.
- Signing keys are outside the repository and their custody is documented.
- Version, build number and update manifest agree.

**Evidence from the reference build.** An Android signing key was lost during cleanup;
every 0.1.x install was stranded and users had to export, uninstall, reinstall and
import. Startup "regression" of 2.5–3.5 s was a debug-build JIT artifact — release was
43 ms. A Windows port was blocked by packaging and CI gates, not by application code.
A citation-only release was later published without re-uploading 2 GB of data assets: it
was created with `latest=false`, so `releases/latest/download/nds.sqlite.gz` still
resolved to the data release, while Zenodo still archived the release and minted a DOI.

**Does not prove.** Store approval, or that a future release will build.

**Exit.** `check_kit.py --gate G5` passes; the release checklist is signed off with the
honesty grades.

---

## Using the checker

```bash
python3 scripts/check_kit.py --kit-root <repo> --gate G0   # one gate
python3 scripts/check_kit.py --kit-root <repo> --gate all  # everything
```

The checker verifies file presence, required headings (English or Chinese aliases),
non-empty critical sections, unresolved `TODO:` placeholders, and a few content signals
(a partition total and fixture path in G3, table rows in G4). It is deliberately
structural: it cannot judge whether the content is true. Passing it is necessary, not
sufficient.
