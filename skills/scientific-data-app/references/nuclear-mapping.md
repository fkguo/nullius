# Nuclear data mapping (PDG → NDS)

A checklist for mapping concepts when moving from particle data to nuclear data. It is
not a product design and not a schema; it names the places where a straight port would be
wrong.

## Why a mapping is needed

| | Particle data (PDG) | Nuclear data (NDS) |
| --- | --- | --- |
| Source | one curated evaluation per quantity | several evaluations and compilations coexist |
| Versioning | annual edition, whole database | per-record provenance: AME2020, NUBASE2020, an ENSDF dataset, JENDL-5, an EXFOR entry |
| Value model | one best value (average/fit) per quantity | overlapping values that disagree; the user needs the comparison |
| Structure | item tree, decay modes as text | nucleus → dataset → level → gamma/decay feeding, plus reaction data |
| Size | one ~64 MB snapshot | ~85 MB core, plus multi-GB evaluated libraries |

## Concept map

| PDG concept | NDS concept | Note |
| --- | --- | --- |
| particle | nuclide (Z, N, A) + isomer state | ground state and isomers are distinct objects |
| `pdgid` | dataset/record key | ENSDF dataset, EXFOR entry, ENDF MAT/MF/MT |
| property / series | quantity | mass excess, half-life, spin-parity, γ energy/intensity, cross section |
| summary (average/fit) | evaluated value + source | several evaluations may coexist; no single "best" |
| measurement | dataset / entry / point | one publication may contribute many datasets |
| reference | keynumber / EXFOR entry / library release / DOI | provenance per record, not per edition |
| decay mode | decay branch / feeding | γ transitions belong to the **daughter** |
| edition | per-record provenance | a mixed-provenance view is normal |
| classification flags | element, mass region, dataset type, reaction type | not a single hierarchy |
| related quantity | derived quantity (Q-value, separation energy) | derived values carry their own provenance |

## What does not transfer

- The best-summary rule. A "PDG average" analogue does not exist across nuclear
  evaluations; hiding the alternatives would be a data error.
- The annual edition as the unit of versioning and the "current edition" UI.
- The item tree and decay-text grammar. ENSDF levels, gammas and feedings are a graph
  with cross-dataset duplication.
- The ASCII→math conversion for particle symbols. Nuclear notation needs its own frozen
  rules (nuclide, isomer, spin-parity, units).
- The single bundled snapshot and its update story.

## Nuclear-specific hard problems

1. **Cross-source conflicts.** Mass excess from AME vs NUBASE; adopted levels vs a
   dataset's levels; JENDL vs EXFOR cross sections; laser-spectroscopy vs IAEA charge
   radii. The app must show the source and the alternative; it must not silently prefer
   one.
2. **Identity.** Nuclide notation variants (`238U`, `U-238`, `²³⁸U`), isomers (`m1`,
   `m2`), ground state, natural abundance; level identity inside a dataset; dataset vs
   adopted level.
3. **Hierarchy and duplication.** Levels and gammas repeat across datasets; relative
   intensities are not comparable across datasets; a gamma belongs to the daughter.
4. **Units and precision.** keV/MeV, barns, half-life units (s, m, h, d, y, %),
   asymmetric errors, limits, `STABLE` vs `NULL`, estimated vs measured values.
5. **Scale.** The core database can be bundled; JENDL-5 (~2.1 GB) and EXFOR (~528 MB)
   cannot. The app needs a dataset registry with install state, version and hash, and a
   download/caching UX.
6. **Navigation.** The chart of nuclides (N vs Z) is the primary map; element and isotope
   lists, notation search and reaction search sit on top of it.
7. **Licensing.** Terms differ per source; attribution and redistribution rights must be
   recorded per dataset before an asset ships.
8. **References.** ENSDF keynumbers, EXFOR entries and library release notes are the
   provenance units; a paper-level reference is often not enough.

## Traps already documented

`nds-mcp/DATABASE.md` records the data traps that the first acceptance matrix should use:

- gamma transitions belong to the daughter nucleus;
- alpha decay and reaction data are absent from the core database;
- level energies with symbolic offsets are not absolute;
- relative intensities are not comparable across datasets;
- `STABLE` is not `NULL` for half-life;
- estimated vs measured values need distinct display;
- charge radii need a coverage strategy, not a blind `COALESCE`;
- reference keynumbers are mass-scoped;
- isomer flags `M` vs `M1` are ambiguous;
- foreign-key integrity is partial;
- AUTOINCREMENT ids are not stable across rebuilds;
- levels and gammas are duplicated across datasets;
- no absolute gamma intensity without external normalization;
- a negative Q(β⁻) does not give Q(EC) by negation.

## Confirmed decisions for Nuclear Library (2026-10-24)

Project decisions, not skill defaults:

- Public product eventually; the public repository is not created until there is an
  implementation.
- Private design/operations repository: `Nuclear-Library-Internal`.
- `nds.sqlite` and other small assets ship inside the app; JENDL-5 and EXFOR are
  downloaded on demand.
- Platform set matches Particle Library (desktop and mobile together).

## First slices (sequence, not design)

1. Atlas from `nds-mcp/DATABASE.md` plus verification queries, including the negative
   list.
2. Contract for nuclide lookup, nuclide page, levels, gammas, decay, reactions, sources
   and search.
3. Frozen rules for nuclide/isomer notation, spin-parity, units, number formatting and
   source-precedence display.
4. Acceptance matrix built from the traps above.
5. Only then UI: search, nuclide page, chart of nuclides, source comparison.
6. Dataset registry and download UX before the bundling policy is coded.

## Questions the contract must settle

- dataset registry model: versions, hashes, install states, partial installs;
- how a source conflict is displayed (side-by-side, badge, filter);
- isomer identity and level matching across datasets;
- default view: adopted values or a named dataset;
- half-life/unit normalization and display precision;
- search normalization for notation variants;
- what "not recorded" looks like per field;
- reference/provenance granularity.

## Do not

- reuse the best-summary or edition model;
- treat one value per quantity as the norm;
- hide conflicts behind a preferred value;
- infer Q-values, decay modes or spins from display text;
- bundle multi-GB libraries by default.
