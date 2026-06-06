# HEPData MCP — Usage Guide

HEPData (https://www.hepdata.net) is the authoritative public database of numerical data from
high-energy physics experiments, including LHC, Tevatron, HERA, LEP, and fixed-target experiments.

This guide is for both human users and AI agents.

---

## Tool Overview

| Tool | Purpose | Requires |
|------|---------|---------|
| `hepdata_search` | Search for records; returns `hepdata_id` list | At least one search condition |
| `hepdata_get_record` | Get record metadata and table list; returns `table_id` values | `hepdata_id` |
| `hepdata_get_table` | Fetch numerical data inline (JSON, YAML, or CSV) | `table_id` |
| `hepdata_download` | Download a full submission to local disk (zip / json / per-format archive) | `hepdata_id` + `_confirm: true` |

**Typical call chain:**

```
hepdata_search → hepdata_get_record → hepdata_get_table
```

---

## hepdata_search — Parameter Reference

### Exact ID lookup (unambiguous, preferred when you have an ID)

```json
{ "inspire_recid": 728302 }
{ "arxiv_id": "hep-ex/0610021" }
{ "doi": "10.1016/j.physletb.2007.01.073" }
```

### Keyword search (broad text matching, less precise)

```json
{ "query": "pion form factor CMD-2" }
```

> HEPData keyword search is broad Elasticsearch text matching. It is **less precise** than structured
> filters and may return unrelated records. Use structured filters below when possible.

### Structured filters (precise, AND-combinable with each other and with `query`)

#### `reactions` — by reaction type (most effective for physics searches)

Use INSPIRE/HEPData reaction notation: **ALL CAPS, spaces around `-->`**.

```json
{ "reactions": "E+ E- --> PI+ PI-" }    // 46 records
{ "reactions": "PI- P --> PI- P" }       // 200 records
{ "reactions": "PI+ P --> PI+ P" }       // 146 records
{ "reactions": "P P --> P P" }           // 330 records
{ "reactions": "E+ E- --> HADRONS" }     // 296 records
{ "reactions": "GAMMA P --> PI0 P" }     // 141 records
```

**Particle name reference** (spaces required; do not use LaTeX or Unicode):

| Particle | HEPData notation |
|----------|-----------------|
| π±       | `PI+` / `PI-`   |
| π⁰       | `PI0`           |
| proton   | `P`             |
| antiproton | `PBAR`        |
| e±       | `E+` / `E-`     |
| photon   | `GAMMA`         |
| K±       | `K+` / `K-`     |
| neutron  | `N`             |
| muon     | `MU+` / `MU-`   |

#### `collaboration` — by experiment (case-sensitive)

```json
{ "collaboration": "LHCb" }
{ "collaboration": "CMD-2" }
{ "collaboration": "KLOE" }
{ "collaboration": "BESIII" }
{ "collaboration": "CMS" }
{ "collaboration": "ATLAS" }
```

#### `observables` — by measurement type

```json
{ "observables": "SIG" }           // total cross section
{ "observables": "DSIG/DOMEGA" }   // differential cross section (angular)
{ "observables": "DSIG/DPT" }      // differential cross section (pT)
{ "observables": "DSIG/DT" }       // differential cross section (|t|)
{ "observables": "POL" }           // polarization
{ "observables": "ASYM" }          // asymmetry
{ "observables": "F2" }            // structure function F2
{ "observables": "SLOPE" }         // slope parameter (elastic)
{ "observables": "MULT" }          // multiplicity
```

#### `phrases` — by physics topic tag (title-case exact phrases)

```json
{ "phrases": "Proton-Proton Scattering" }
{ "phrases": "Pion-Proton Scattering" }
{ "phrases": "Deep Inelastic Scattering" }
{ "phrases": "Elastic" }
{ "phrases": "Cross Section" }
{ "phrases": "Jet Production" }
{ "phrases": "Polarization" }
```

#### `cmenergies` — by CM energy range in GeV (format: `"min,max"`)

```json
{ "cmenergies": "0.0,1.0" }           // √s < 1 GeV (low-energy)
{ "cmenergies": "1.0,10.0" }          // 1–10 GeV
{ "cmenergies": "7000.0,8000.0" }     // LHC 7 TeV
{ "cmenergies": "13000.0,14000.0" }   // LHC 13 TeV
```

#### `subject_areas` — by arXiv category

```json
{ "subject_areas": "hep-ex" }
{ "subject_areas": "nucl-ex" }
{ "subject_areas": "hep-ph" }
```

### Pagination and sorting (modifiers — not standalone search conditions)

```json
{ "sort_by": "date" }      // relevance (default) | collaborations | title | date | latest
{ "page": 2, "size": 25 }  // single page; size max 25
{ "max_results": 100 }     // bounded auto-pagination (see below)
```

`max_results` enables **bounded auto-pagination**: the search fetches successive
pages (each a separate, rate-limited request) and accumulates results until that
many are collected, or HEPData runs out of matches — whichever comes first. Omit
it for single-page behavior (effective default = `size`). A **hard cap of 200**
applies: larger values are clamped down to 200, so a single search can never
trigger an unbounded crawl of HEPData.

### Combined examples

```json
{ "reactions": "E+ E- --> PI+ PI-", "cmenergies": "0.0,2.0", "sort_by": "date" }
{ "collaboration": "LHCb", "observables": "SIG", "query": "charm production" }
{ "reactions": "P P --> P P", "observables": "DSIG/DT" }
```

---

## hepdata_get_record — Response Structure

```json
{
  "hepdata_id": 96268,
  "title": "Measurement of σ(e+e- → π+π-)...",
  "inspire_recid": 912841,
  "arxiv_id": "arXiv:1107.4822",
  "doi": "10.1016/j.physletb.2011.04.055",
  "collaborations": ["KLOE"],
  "abstract": "...",
  "data_tables": [
    { "table_id": 1649547, "name": "Differential cross section", "doi": "..." },
    { "table_id": 1649548, "name": "Statistical covariance",     "doi": "..." }
  ]
}
```

`data_tables[].table_id` is passed directly to `hepdata_get_table`.

---

## hepdata_get_table — Inline Formats

`format` selects how the table is returned inline (no file is written):

- `format: "json"` (default) — parsed and normalized into the structured object below.
- `format: "yaml"` — raw native HEPData YAML text with the full error breakdown.
- `format: "csv"` — raw HEPData CSV text for the table.

Heavy/binary formats (`root`, `yoda`, `yoda1`, `yoda.h5`) are **not** available here —
use `hepdata_download` to write those to disk.

### JSON format — Response Structure

`values` is an array of rows. Each row has `x` (independent variables) and `y` (measured quantities).

**`x` entries:**
- `{ "value": "0.95" }` — point data (single energy, angle, etc.)
- `{ "low": "0.90", "high": "1.00" }` — bin data (bin edges)

**`y` entries:**
- `value` — the measurement
- `errors[]` — list of error contributions, each with:
  - `label` — source name (e.g. `"stat"`, `"sys"`, `"lumi"`)
  - `symerror` — symmetric error (±value); present when error is symmetric
  - `asymerror: { plus, minus }` — asymmetric errors (when present instead of `symerror`)

```json
{
  "name": "Table 1",
  "description": "Bare cross section for e+e- → π+π-",
  "headers": [
    { "name": "M_ππ² [GeV²]", "colspan": 1 },
    { "name": "σ_ππ [nb]",    "colspan": 1 }
  ],
  "values": [
    {
      "x": [{ "low": "0.100", "high": "0.110" }],
      "y": [{
        "value": 44.0,
        "errors": [
          { "label": "stat", "symerror": 7.0 },
          { "label": "sys",  "symerror": 5.0 }
        ]
      }]
    }
  ]
}
```

Use `format: "yaml"` for the full native HEPData YAML with complete error breakdown,
or `format: "csv"` for raw CSV text.

---

## hepdata_download — Downloading Submissions

Downloads a complete submission for all tables to local disk. Unlike
`hepdata_get_table` (which returns text-renderable formats inline), this is the
path for whole-submission archives and heavy/binary formats.

**Requires `_confirm: true`** — this is a safety gate (writes files to disk).

```json
{ "hepdata_id": 96268, "_confirm": true }                  // original submission zip
{ "hepdata_id": 96268, "format": "yoda", "_confirm": true } // per-format archive
```

### `format` — what gets downloaded (default `original`)

| `format` | What HEPData returns | On-disk filename |
|----------|----------------------|------------------|
| `original` (default) | full submission zip (all tables, all formats) | `hepdata_submission.zip` |
| `json` | single submission JSON file | `hepdata_submission.json` |
| `csv` | `.tar.gz` archive of every table as CSV | `hepdata_submission_csv.tar.gz` |
| `root` | `.tar.gz` archive of every table as ROOT | `hepdata_submission_root.tar.gz` |
| `yaml` | `.tar.gz` archive of every table as YAML | `hepdata_submission_yaml.tar.gz` |
| `yoda` | `.tar.gz` archive of every table as YODA | `hepdata_submission_yoda.tar.gz` |
| `yoda1` | `.tar.gz` archive of every table as YODA1 | `hepdata_submission_yoda1.tar.gz` |
| `yoda.h5` | `.tar.gz` archive of every table as YODA HDF5 | `hepdata_submission_yoda_h5.tar.gz` |

Each format is written to its **own** file under the submission's artifacts
directory, so downloading multiple formats of the same submission never
overwrites a previous one. The returned `uri` mirrors the on-disk filename.

**Response fields:**

```json
{
  "uri": "hepdata://artifacts/submissions/96268/hepdata_submission.zip",
  "file_path": "/path/to/data/artifacts/submissions/96268/hepdata_submission.zip",
  "size_bytes": 48320,
  "tables_count": 15
}
```

- `uri` — artifact reference for downstream pipeline use
- `file_path` — absolute path on local disk
- `size_bytes` — archive size in bytes
- `tables_count` — number of data tables in the submission

Storage root is controlled by the `HEPDATA_DATA_DIR` environment variable
(defaults to a platform-standard data directory).

---

## External Links

- HEPData website: https://www.hepdata.net
- Search with JSON API: https://www.hepdata.net/search/?format=json
- Submission format reference: https://hepdata.net/submission
- REST API documentation: https://hepdata.readthedocs.io/en/latest/api.html
