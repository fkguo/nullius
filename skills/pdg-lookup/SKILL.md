---
name: pdg-lookup
description: >
  Teaches the PDG (Particle Data Group) tool chain for looking up particle properties,
  measurements, decays, and references from the local PDG SQLite database.
---

# PDG Lookup Workflow

This skill teaches the correct tool-calling sequence for PDG lookups via the `pdg_*` MCP tools.
All PDG tools are local-only (no network) and require `PDG_DB_PATH` to be set.

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
Returns DB path, edition year, and data directories. If this fails, the user needs to set `PDG_DB_PATH`.

## Step 2: Find the particle

```
pdg_find_particle { query: "top quark" }
pdg_find_particle { query: "t", mcid: 6 }
pdg_find_particle { pdgid: "S008" }
```

The result includes `pdgid` values (e.g., `"S008"` for the top quark) needed for subsequent calls.

## Step 3: Get properties or measurements

### Quick property lookup
```
pdg_get_property { pdgid: "S008M", particle: "t" }
pdg_get_property { particle: "W", property: "mass" }
pdg_get_property { particle: "Z", property: "width" }
```
- Use `allow_derived: true` to get width derived from lifetime (and vice versa).
- Returns value, uncertainties, unit, and PDG locator.

### Detailed measurements (CRITICAL: stop-and-select pattern)
```
pdg_get_measurements { particle: "t", property: "mass" }
```
**CRITICAL**: If the result has `kind: "series_options"` or `stop_here: true`, you **MUST STOP** and present the options to the user. Then call again with the specific `property_pdgid` or `data_type` from `example_next_calls`:
```
pdg_get_measurements { property_pdgid: "S008M" }
pdg_get_measurements { pdgid: "S008M", data_type: "DIRECT MEASUREMENT" }
```
Never skip the series selection step. The result is a JSONL artifact with full measurement details.

### Decay modes
```
pdg_get_decays { particle: "Z" }
pdg_get_decays { pdgid: "S044" }
```
Returns all known decay modes with branching ratios as a JSONL artifact.

## Step 4: References

### Find references
```
pdg_find_reference { query: "CKM" }
pdg_find_reference { doi: "10.1103/PhysRevD.110.030001" }
pdg_find_reference { inspire_id: "2830185" }
```

### Get a specific reference
```
pdg_get_reference { document_id: 12345 }
```

## Common Workflow Examples

### Top quark mass
1. `pdg_find_particle { query: "top quark" }` -> get pdgid `S008`
2. `pdg_get_property { particle: "t", property: "mass" }` -> quick value
3. `pdg_get_measurements { particle: "t", property: "mass" }` -> may return `series_options`
4. Select the appropriate series -> `pdg_get_measurements { property_pdgid: "S008M" }`

### Z boson decays
1. `pdg_find_particle { query: "Z boson" }` -> get pdgid `S044`
2. `pdg_get_decays { pdgid: "S044" }` -> all decay modes with BRs

### Higgs measurements
1. `pdg_find_particle { query: "Higgs" }` -> pdgid `S126`
2. `pdg_get_measurements { particle: "H", property: "mass" }` -> handle series_options
3. `pdg_get_measurements { property_pdgid: "S126M" }` -> all mass measurements

### CKM review reference
1. `pdg_find_reference { query: "CKM" }` -> find document_id
2. `pdg_get_reference { document_id: <id> }` -> full reference with INSPIRE link

## Tips

- `pdg_get_property` is fast and returns a single best-fit value. Use it for quick lookups.
- `pdg_get_measurements` returns the full measurement history. Use it when the user needs individual experiment results.
- Particle names are case-insensitive: `"W"`, `"w"`, `"W boson"` all work.
- Use `pdg_batch` (full exposure only) to run multiple PDG lookups in one call.
- Width and lifetime are related: if only one is in the DB, use `allow_derived: true` to get the other.
