# @hep-research/pdg-mcp

English | [中文](./README_zh.md)

`pdg-mcp` is a **local (offline)** MCP server (stdio transport) that provides reproducible queries over PDG (Review of Particle Physics) **SQLite snapshots**.

Design principles:

- **Evidence-first**: large outputs are written to local `artifacts/`; tools return only `uri + summary`, and the full content is read via `pdg://` resources.
- **Schema SSOT**: tool parameters use Zod schemas as the single source of truth, and MCP `inputSchema` is derived from them (no drift).

> Dependency: system `sqlite3` must be available in `PATH` (internally uses `sqlite3 -json` in read-only mode).

## Environment variables and directories

### Required

- `PDG_DB_PATH`: **absolute path** to a PDG sqlite file (e.g. `/abs/path/to/pdg-2025-v0.3.0.sqlite`)
  - If unset: only `pdg_info` works (`db.configured=false`); all other tools return `INVALID_PARAMS`.

### Optional

- `PDG_DATA_DIR`: local data directory (default: `<HEP_DATA_DIR>/pdg` when `HEP_DATA_DIR` is set; otherwise `~/.hep-research-mcp/pdg`)
  - artifacts directory: `$PDG_DATA_DIR/artifacts`
- `PDG_ARTIFACT_TTL_HOURS`: PDG artifact cache TTL in hours (`0/off` disables; cleaned on startup and periodically; default 24)
- `PDG_ARTIFACT_DELETE_AFTER_READ`: if enabled, deletes an artifact file right after it is successfully read via `pdg://artifacts/<name>` (useful for “query cache” workflows)
- `PDG_TOOL_MODE`: tool exposure mode (`standard` by default; `full` may expose more tools in the future)
- `PDG_SQLITE_MAX_STDOUT_BYTES`: max sqlite3 stdout per query (default 50MB)
- `PDG_SQLITE_CONCURRENCY`: sqlite3 concurrency limit (default 4)

## Resources (`pdg://`)

`pdg-mcp` exposes resources for reading local artifacts:

- `pdg://info`
  - returns minimal server info and `artifacts_dir` (JSON text)
- `pdg://artifacts`
  - returns the current artifacts index (JSON text)
- `pdg://artifacts/<name>`
  - text (`.json/.jsonl/.txt/.md`): returns file text directly
  - binary (e.g. `.pdf/.png/.zip`): **no base64 payload**; returns metadata JSON only (`file_path/size_bytes/sha256/mimeType`)

> Note: to avoid flooding MCP client UIs, `resources/list` only exposes entrypoints (`pdg://info` and `pdg://artifacts`). Read a concrete artifact via `pdg://artifacts/<name>` (discover names via the `pdg://artifacts` index) or via the `resources/templates/list` template `pdg://artifacts/{artifact_name}`.

## Tools (`pdg_*`)

### 1) `pdg_info`

Purpose: server info, directory info, and the current `PDG_DB_PATH` metadata (small result).

Input: `{}`

Key outputs:

- `db.configured`: whether `PDG_DB_PATH` is configured
- if configured: `db.file.sha256`, `db.edition`, `db.license`, `db.citation`, etc. (from `pdginfo`)
- `data_dir` / `artifacts_dir`

### 2) `pdg_find_particle`

Purpose: find particle candidates by **name / MCID / PDG identifier (pdgid)** (small result; paginated).

Input (exactly one query):

- `name: string`
- `mcid: int` (PDG Monte Carlo ID / PDG code; integer strings are accepted)
- `pdg_code: int` (alias of `mcid`)
- `pdgid: string`

Common parameters:

- `case_sensitive?: boolean = false`
- `match?: 'exact' | 'prefix' | 'contains' = 'exact'` (only for `name`)
- `start?: int = 0`
- `limit?: int = 20` (max 50)

Key outputs:

- `candidates[]`: `pdgid/pdgid_id/name/mcid/charge/cc_type/pdg_description`
- `match`: hit provenance (`particle` direct hit or via `pdgitem`/`pdgitem_map`)
- `has_more`: pagination flag
- `normalized_name`: input normalization (e.g. `π`→`pi`, superscripts/subscripts, etc.)

### 3) `pdg_get_property`

Purpose: fetch a high-frequency property (`mass/width/lifetime`) with uncertainties (small result).

Input:

- `particle`: `{ name | mcid | pdgid, case_sensitive?: boolean = false }` (exactly one)
  - `particle.pdg_code` is supported as an alias of `mcid`
- `property: 'mass' | 'width' | 'lifetime'`
- `edition?: string`
- `allow_derived?: boolean = false`

Key outputs:

- `particle`: resolved base particle + charged variants
- `property`: `pdgid/pdgid_id/data_type/flags`
- `value`: `display_value_text` + numeric `value/error_*` + `display_text`
- `pdg_locator`: points to `pdgdata.pdgdata_id`
- `value_type_meaning/limit_type_meaning`: decoded via `pdgdoc` when available

Derived width:

- if `width` is requested and PDG has no width but provides lifetime, set `allow_derived=true`
- returns `derived.width_from_lifetime` with source locator and constants (`Γ = ħ / τ`)

### 4) `pdg_get`

Purpose: fetch a **PDG identifier (pdgid)** in detail (writes JSON artifact; tool returns `uri + summary`).

Input:

- `pdgid: string` (e.g. `S043M`)
- `edition?: string`
- `artifact_name?: string` (safe filename; no path separators)

Key outputs:

- `uri: pdg://artifacts/<name>`
- `summary`: `pdgid/pdgid_id/description/data_type/flags/edition`, `pdgdata_rows`, `child_count`, etc.
- artifact content: `pdgid` row, `pdgdata_rows`, `pdgdecay_rows`, and a children sample

### 5) `pdg_get_decays`

Purpose: list decay modes for a particle (writes JSONL artifact; tool returns `uri + summary`; paginated).

Input:

- `particle`: `{ name | mcid | pdg_code | pdgid, case_sensitive?: boolean = false }` (exactly one)
- `edition?: string`
- `start?: int = 0`
- `limit?: int = 200` (max 500)
- `artifact_name?: string`

Key outputs:

- `uri: pdg://artifacts/<name>`
- `summary.preview`: a few decay lines (with `display_text`)
- each JSONL line includes:
  - `decay`: like `W+ -> e+ + nu`
  - `incoming/outgoing[]`: particle list (`multiplier`, `subdecay_id`)
  - `branching`: `pdgdata_id/edition/display_text`, etc.

### 6) `pdg_find_reference`

Purpose: search `pdgreference` by DOI / INSPIRE recid / document id / title (small result; paginated).

Input (exactly one query):

- `doi: string`
- `inspire_id: string` (usually a numeric INSPIRE recid)
- `document_id: string` (PDG internal id like `PATEL 1965`)
- `title: string`

Common parameters:

- `match?: 'exact' | 'prefix' | 'contains' = 'contains'`
- `case_sensitive?: boolean = false`
- `start?: int = 0`
- `limit?: int = 20` (max 50)

Key outputs:

- `references[]`: `id/document_id/publication_name/publication_year/doi/inspire_id/title`
- `references[].inspire_lookup_by_id`: identifiers directly usable by `hep-research-mcp`’s `inspire_literature` (mode=`lookup_by_id`)
  - include DOI if it starts with `10.`
  - include INSPIRE recid if `inspire_id` is all digits

### 7) `pdg_get_reference`

Purpose: fetch a single reference record (small result; includes INSPIRE lookup hints).

Input (exactly one selector):

- `id: int`
- `document_id: string`

Common parameters:

- `case_sensitive?: boolean = false` (only for `document_id`)

Key outputs:

- `reference`: same structure as `pdg_find_reference`, plus `reference.inspire_lookup_by_id`
- `pdg_locator`: `{ table: 'pdgreference', pdgreference_id: <id> }`

### 8) `pdg_get_measurements`

Purpose: list measurements for a PDG identifier (writes JSONL artifact; paginated; optional joins for reference/values/footnotes).

This tool also supports a **particle-mode** entry point:

- you can pass a `particle` selector (`name | mcid | pdgid`), or
- pass a numeric `pdgid` string as a convenience shorthand for **MCID/PDG code** (e.g. `111` for `pi0`).

If the particle maps to **multiple measurement series** (multiple child PDG identifiers under the particle), the tool returns a **JSON artifact** with series options instead of measurement JSONL.

Input:

Exactly one of (or use property_pdgid directly):

- `pdgid: string` (PDG identifier like `S009T`; numeric strings are treated as MCID/PDG code)
- `particle: { name | mcid | pdg_code | pdgid, case_sensitive?: boolean = false }`
- `property_pdgid: string` (can be used alone to directly query a specific PDG identifier like `S009R1`)

Optional disambiguation (when using `particle` or numeric `pdgid`):

- `property_pdgid?: string` (choose a specific child series under the particle, e.g. `S009T`)
- `data_type?: string` (choose by PDGID.DATA_TYPE, e.g. `T`, `M`, `BR`)

- `case_sensitive?: boolean = false`
- `start?: int = 0`
- `limit?: int = 50` (max 200)
- `include_values?: boolean = true`
- `include_reference?: boolean = true`
- `include_footnotes?: boolean = true`
- `artifact_name?: string`

Key outputs:

- Measurements mode (JSONL):
  - `uri: pdg://artifacts/<name>`
  - `summary.has_more`: boolean indicating if more measurements are available
  - `summary.next_page_hint`: if `has_more=true`, contains the next call parameters (`start`, `limit`)
  - **Pagination**: when `has_more=true`, call again with `start = previous_start + previous_limit`
  - each JSONL line includes:
    - `measurement`: from `pdgmeasurement`
    - `values[]`: from `pdgmeasurement_values` (`column_name/value_text/value/error_*` + `display_text`)
    - `reference`: from `pdgreference` (if enabled) + `reference.inspire_lookup_by_id`
    - `footnotes[]`: from `pdgmeasurement_footnote` + `pdgfootnote` (if enabled)
- Series-options mode (JSON):
  - `summary.kind = 'series_options'`
  - `summary.requires_selection = true` (indicates you must stop and select a series)
  - `summary.stop_here = true` (**CRITICAL**: do NOT call again with the same particle/pdgid)
  - the artifact lists candidate series under the particle (with `measurement_count`) and hints for the next call
  - **CRITICAL**: When you receive `series_options` or `stop_here=true`, you MUST STOP querying immediately. Do NOT call `pdg_get_measurements` again with the same particle/pdgid - this causes infinite loops. Instead, use one of the `example_next_calls` with `property_pdgid` or `data_type` to select a specific series.

### 9) `pdg_batch`

Purpose: execute multiple PDG tool calls in one request (writes JSON artifact; limited parallelism).

Availability: **full-only** (not exposed in `standard` mode).

Input:

- `calls: Array<{ tool: <pdg tool name>, arguments?: object }>` (1–50)
- `concurrency?: int = 4` (max 16)
- `continue_on_error?: boolean = false`
- `artifact_name?: string`

Allowed `tool` values:

- `pdg_info`
- `pdg_find_particle`
- `pdg_find_reference`
- `pdg_get_reference`
- `pdg_get_property`
- `pdg_get`
- `pdg_get_decays`
- `pdg_get_measurements`

Key outputs:

- `uri: pdg://artifacts/<name>`
- `summary.ok/errors/skipped` + `preview`
- artifact stores the full call log (`duration_ms`, per-call errors/results) for audit and reproducibility

## Bridge to `hep-research-mcp` (Reference workflow)

When `pdg-mcp` is aggregated into `hep-research-mcp` (single MCP server):

- all `pdg_*` tools are available on the same server
- `inspire_literature` (mode=`lookup_by_id`) can directly consume `references[].inspire_lookup_by_id` produced by:
  - `pdg_find_reference`
  - `pdg_get_reference`
  - `pdg_get_measurements`
