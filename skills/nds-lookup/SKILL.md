---
name: nds-lookup
description: "Teach the nds-mcp tool chain for nuclear data: atomic masses, separation energies, Q-values, half-life/spin-parity/decay modes, charge radii, ENSDF levels/gammas/decay feedings, TUNL light nuclei, JENDL-5 cross sections and radiation spectra, EXFOR points, and CODATA constants. Covers the Cross-Source Rule (source-tagged values, never collapsed), provenance fields, and the data traps that produce wrong physics (gamma belongs to the daughter, STABLE vs NULL, relative intensities, symbolic level energies, isomer M vs M1, Q(EC) sign). Use when a question needs nuclear data and the nds_* MCP tools are available."
---

# NDS Lookup

`nds-mcp` is an offline SQLite-backed nuclear-data server. All `nds_*` tools are local
(except optional DB downloads and the update check) and must be called through the MCP
server; never query the SQLite files directly from a shell when the tools can answer.

## Golden rules

1. **Source-tag everything.** When a quantity exists in several sources, return every
   source value. `recommended` / `best` is an additional field, never a replacement and
   never grounds for dropping the others.
2. **Empty is not missing.** `STABLE` is not `NULL`; a symbolic level energy is not
   absolute; an absent value is not zero.
3. **Carry provenance.** Record the dataset version/hash from `nds_info` and the record
   key (ENSDF keynumber, EXFOR `entry_id`, ENDF MAT/MF/MT).
4. **No raw SQL.** Use `nds_schema` then `nds_query`; BLOB columns are never returned and
   cannot be selected.
5. **Optional databases download on first use.** Say so when a call is slow rather than
   reporting a hang or a failure.

## Start here

```
nds_info {}          # versions, built_at, database paths, optional DB status
nds_catalog {}       # installed libraries, quantities, recommended entry tools
```

## Routing

| Question | Tool |
| --- | --- |
| Which nuclides match an element / Z / A? | `nds_find_nuclide` (`element`, `Z`, `A`) |
| Atomic mass, mass excess, binding energy/A | `nds_get_mass` |
| Sn, Sp, S2n, S2p | `nds_get_separation_energy` |
| Reaction Q-values (Qa, Q2bm, Qep, Qbn, …) | `nds_get_q_value` |
| Half-life, spin/parity, decay modes | `nds_get_decay` |
| Charge radius, one or all sources | `nds_get_charge_radius` (`mode=best|all|compare`) |
| Nuclei by property range | `nds_search` |
| Energy levels (ENSDF + TUNL for A ≤ 20) | `nds_query_levels` (`source` discriminator) |
| Gamma transitions | `nds_query_gammas` |
| Beta/EC feeding | `nds_query_decay_feedings` |
| Bibliography | `nds_lookup_reference` |
| JENDL-5 radiation spectra | `nds_get_radiation_spectrum` |
| JENDL-5 targets / channels / cross sections | `nds_list_available_targets`, `nds_get_reaction_info`, `nds_get_cross_section_table` |
| Cross section at one energy | `nds_interpolate_cross_section` |
| EXFOR points / one entry | `nds_search_exfor` (`quantity=SIG|MACS|…`), `nds_get_exfor_entry` |
| CODATA constants | `nds_list_constants`, `nds_get_constant` |
| Unknown table | `nds_schema` → `nds_query` |

## Canonical workflows

**Identity → bulk properties.** `nds_find_nuclide` → take `Z`,`A` → `nds_get_mass` /
`nds_get_decay` / `nds_get_separation_energy`. State whether the mass is the AME neutral-atom
mass (electrons included) before comparing with a reaction Q-value.

**Levels → gammas → feedings → reference.** `nds_query_levels` (keep the `source`
discriminator; ENSDF and TUNL are different datasets) → `nds_query_gammas` for the
**daughter** nucleus → `nds_query_decay_feedings` for the parent → `nds_lookup_reference`
for the keynumber. Do not compare relative intensities across datasets.

**Cross sections.** `nds_list_available_targets` → `nds_get_reaction_info` (available MT and
energy range) → `nds_get_cross_section_table` (`mode=raw|sampled`) →
`nds_interpolate_cross_section` only inside the stated range; out-of-range is an error
unless clamping is requested explicitly.

**EXFOR.** `nds_search_exfor` with a quantity filter → `nds_get_exfor_entry` by
`entry_id`. EXFOR points are experimental; do not mix them with an evaluated library
without labelling each.

**Unknown schema.** `nds_catalog` → `nds_schema` → `nds_query` with an equality filter on
`*_points` tables (`xs_id` or `entry_id`).

## Data traps

| Trap | What to do |
| --- | --- |
| Gamma transitions belong to the **daughter** | Query gammas by the daughter Z,A; never attach them to the parent |
| `nds.sqlite` has no alpha-decay or reaction data | Use NUBASE decay modes / JENDL-5 / EXFOR; do not infer absence from a null |
| Level energies with symbolic offsets are not absolute | Keep the original text; do not subtract |
| Relative intensities are not comparable across datasets | Report per dataset; no cross-dataset normalisation |
| `STABLE` vs `NULL` half-life | Preserve the distinction; never render `NULL` as stable |
| Estimated vs measured values | Keep the estimation flag; do not average them as equals |
| Charge radii coverage differs by source | Use `mode=compare`; do not silently `COALESCE` |
| Reference keynumbers are mass-scoped | Quote the keynumber with the dataset |
| Isomer flag `M` vs `M1` is ambiguous | Read the dataset convention; do not normalise blindly |
| AUTOINCREMENT ids are not stable across rebuilds | Key on physical fields, not row ids |
| Levels/gammas duplicated across datasets | Filter by dataset; state which one is shown |
| No absolute gamma intensity without external normalisation | Do not compute one |
| Q(β⁻) negative does not give Q(EC) by negation | Use the dedicated Q-value field |
| AME masses are neutral atoms (electrons included) | Account for electrons before atomic-mass comparisons |

The full list with column names and queries is in `nds-mcp/DATABASE.md`.

## What not to do

- Do not select BLOB columns or read raw archives; `nds_list_raw_archives` returns
  metadata only.
- Do not merge two sources into one value, or present `recommended` as the only value.
- Do not treat `AUTOINCREMENT` ids as stable identifiers.
- Do not infer a decay mode, spin, or Q-value from display text.
- Do not report a download as a failure; optional DBs are fetched on first use.

## Answer template

> For each number: value ± uncertainty, unit, dataset (version/hash, record key), and the
> source name. If sources disagree, show both and say they disagree; do not choose one
> silently. If the database does not record it, say "not recorded".
