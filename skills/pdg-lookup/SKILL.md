---
name: pdg-lookup
description: "Teaches the PDG (Particle Data Group) tool chain for looking up particle properties, measurements, decays, and references from the local PDG SQLite database."
---

# PDG Lookup Workflow

This skill teaches the correct tool-calling sequence for PDG lookups via the `pdg_*` MCP tools.
All PDG tools are local-only (no network). Set `PDG_DB_PATH` for data queries; `pdg_info` can also report that it is not configured.

## Tool Chain Overview

```
pdg_info                    # Check DB status, see available editions
    |
pdg_find_particle           # Search by name / MCID / PDG identifier
    |
    +-- pdg_get_property     # Quick: mass, width, lifetime (with uncertainties)
    +-- pdg_get_measurements # Detailed: all measurements for a PDG identifier
    +-- pdg_get_decays       # All decay modes for a particle
    +-- pdg_get              # Full PDG identifier object (JSON artifact)
    |
pdg_find_reference          # Find PDG references by DOI / INSPIRE recid / title
pdg_get_reference           # Get a specific PDG reference record
```

## Step 1: Check availability

```
pdg_info {}
```
Inspect `db.configured`, the edition, and data directories. If the database is not configured, set `PDG_DB_PATH` to its absolute path; report other errors as returned.

## Step 2: Find the particle

```
pdg_find_particle { name: "t" }
pdg_find_particle { mcid: 6 }
pdg_find_particle { pdgid: "S008" }
```

Use exactly one of `name`, `mcid`, or `pdgid`. Read the returned identifiers before subsequent calls; `S008` is the charged-pion entry, not the top quark.

## Step 3: Get properties or measurements

### Quick property lookup
```
pdg_get_property { particle: { mcid: 6 }, property: "mass" }
pdg_get_property { particle: { name: "W" }, property: "mass" }
pdg_get_property { particle: { name: "Z" }, property: "width" }
```
- Returns a stored value, its uncertainties, unit, and PDG locator. A missing property is `NOT_FOUND`; no other physical quantity is substituted or derived.
- If a missing width makes the recorded lifetime relevant to the question, query `property: "lifetime"` explicitly and inspect the source. The host performs any subsequent calculation in the research project with its assumptions, units, uncertainty treatment and source locators.
- The quick summary follows database flags and row order; it does not prove that one physical definition or measurement is uniquely appropriate. Use `pdg_get` on the returned property identifier to read all stored rows, including limits, confidence levels and asymmetric or missing uncertainties.

### Detailed measurements (CRITICAL: stop-and-select pattern)
```
pdg_get_measurements { particle: { mcid: 6 }, data_type: "M" }
```
**CRITICAL**: If the result has `kind: "series_options"` or `stop_here: true`, you **MUST STOP** and present the options to the user. Then call again with the specific `property_pdgid` or `data_type` from `example_next_calls`:
```
pdg_get_measurements { property_pdgid: "<returned_property_pdgid>" }
pdg_get_measurements { particle: { mcid: 6 }, property_pdgid: "<returned_property_pdgid>" }
```
Replace the placeholder with the selected returned identifier. `data_type` uses database codes such as `M`, `G`, or `T`, not prose such as "DIRECT MEASUREMENT". Never skip the series selection step. The result is a JSONL artifact with measurement details for the requested page; follow pagination when more rows remain.

### Decay modes
```
pdg_get_decays { particle: { name: "Z" } }
pdg_get_decays { particle: { pdgid: "S044" } }
```
Returns a page of decay records as a JSONL artifact. Inspect `has_more` and use `start`/`limit` to retrieve the remaining rows. The branching value is a database-ordered preview; use `pdg_get` on a decay identifier to inspect its complete stored value rows.

## Step 4: References

### Find references
```
pdg_find_reference { title: "CKM" }
pdg_find_reference { doi: "10.1103/PhysRevD.110.030001" }
pdg_find_reference { inspire_id: "2830185" }
```

### Get a specific reference
```
pdg_get_reference { document_id: "<returned_document_id>" }
```
Use the returned string `document_id`, or the returned numeric `id` with the `id` parameter.

## Common Workflow Examples

### Top quark mass
1. `pdg_find_particle { mcid: 6 }` -> inspect the returned particle identifier
2. `pdg_get_property { particle: { mcid: 6 }, property: "mass" }` -> quick value; inspect its definition and alternatives
3. `pdg_get_measurements { particle: { mcid: 6 }, data_type: "M" }` -> may return `series_options`
4. Select the physically appropriate series -> `pdg_get_measurements { property_pdgid: "<returned_property_pdgid>" }`

### Z boson decays
1. `pdg_find_particle { name: "Z" }` -> inspect the returned particle identifier
2. `pdg_get_decays { particle: { name: "Z" } }` -> decay records; paginate as needed

### Higgs measurements
1. `pdg_find_particle { mcid: 25 }` -> inspect the returned Higgs identifier
2. `pdg_get_measurements { particle: { mcid: 25 }, data_type: "M" }` -> handle `series_options`
3. `pdg_get_measurements { property_pdgid: "<returned_property_pdgid>" }` -> measurements for the selected series; paginate as needed

### CKM review reference
1. `pdg_find_reference { title: "CKM" }` -> inspect matching references and select a `document_id`
2. `pdg_get_reference { document_id: "<returned_document_id>" }` -> full reference with available identifiers

## Tips

- `pdg_get_property` returns a quick selected summary, which can be a measurement or a limit. Inspect `value_type`, `limit_type`, and `alternatives`; use the detailed records when the physical definition matters.
- `pdg_get_measurements` returns the full measurement history. Use it when the user needs individual experiment results.
- Particle names are case-insensitive by default. Names and aliases must exist in the configured database; use `pdg_find_particle` when unsure.
- Use `pdg_batch` (full exposure only) to run multiple PDG lookups in one call.
- Keep the returned edition, source locator and units with any value used in calculations. Preserve historical derived-result files as historical evidence; they do not create a current provider calculation path.
