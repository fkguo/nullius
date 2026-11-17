# @nullius/hep-mcp

Current most mature HEP domain pack. Local stdio MCP server exposing `hep_*` tools for literature search exports, identifier and Zotero mappings, and provider-local composition.

## Layer

Domain workflow pack. The strongest end-to-end example in the repo, but **not the root product identity** — generic lifecycle and contracts live in `@nullius/orchestrator` and `@nullius/shared`. See root [README.md](../../README.md) §3 Layer Model.

`hep-mcp` is a tool package, not generic lifecycle or approval authority. It keeps no runs, paper/evidence projects or evidence catalogs of its own: runs, approvals and lifecycle belong to the orchestrator (`<project_root>/artifacts/runs/<run_id>/`). Tools that produce files (`hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `hep_import_from_zotero`, `inspire_parse_latex`, and `inspire_search` when given `output_dir`) write them into a caller-chosen `output_dir`, typically a subdirectory of the current run directory, and return project-relative paths (`export_path`, `meta_path`, `mapping_path`, `path`, `artifacts[].path`). INSPIRE lookups made through the response cache (by `hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `inspire_search` with `output_dir`, and the INSPIRE resolution step of `hep_import_from_zotero`) are recorded request by request under `<output_dir>/external_api/`; other provider calls (the Zotero local API, the source retrieval of `inspire_parse_latex`) are not recorded there. There are no project or evidence catalog, draft rendering, project export or paper bundling tools.

Historical HEP run directories (`runs/<run_id>/` under a HEP data root) and paper/evidence project directories (`projects/<project_id>/`, including evidence catalogs) written by earlier versions are evidence: they stay readable in place and no tool creates or rewrites them. [docs/URI_REGISTRY.md](../../docs/URI_REGISTRY.md) gives the reading rules for historical `hep://runs/...` and `hep://projects/...` references.

## Numerical comparisons

The automated `inspire_detect_measurement_conflicts` operator has been retired.
It no longer appears in either exposure mode, and calls to that name return an
unknown-tool error. Existing saved outputs remain readable; they are not
recomputed, rewritten or promoted to accepted evidence by this change.

Use `inspire_paper_source` or `arxiv_paper_source` to obtain sources, then read
the returned files with the host's available tools. A downloaded path is not
read content. `inspire_parse_latex` still provides structural tables and
locators; PDG and HEPData retain their independent data-access tools. Establish
observable definitions, conditions, units, uncertainty conventions and shared
inputs before using existing numerical execution to compare or combine values.
Preserve asymmetric errors and limits. Unresolved comparability or correlations
must remain explicit; absence of a comparable pair is not evidence of agreement.
See the [numeric-source guidance](../../skills/research-integrity/references/m3-numeric-sources.md).

## Research judgment and source access

Scientific interpretation belongs to the host using the actual sources. The
provider retains search, records, original text, data, citation structure and
LaTeX extraction. The following tools have been retired from both exposure
modes: `inspire_grade_evidence`, `inspire_critical_analysis`,
`inspire_classify_reviews`, `inspire_theoretical_conflicts`,
`inspire_analyze_citation_stance`, and `inspire_find_crossover_topics`.
Calls to those names return an unknown-tool error. Their private scientific
scoring, preset judgments and dedicated sampling pipelines have been removed.
Historical outputs remain readable with their original provenance and status;
they do not acquire current scientific acceptance.

`inspire_topic_analysis` retains `timeline`, `evolution` and `all` metadata
views. The `emerging` mode and its momentum, disruption and new-entrant scoring
options are removed. Use explicit date/citation queries and analyze a defined
bibliometric sample in the research project if the task needs that analysis.
The retained metadata summaries and their sampled ordering are not scientific
quality, novelty or priority judgments.

Both views retain every requested period, including a zero result or an
unavailable query. A phase's `paper_count` is the provider-reported match count;
it is `null` when the query fails. Its `search` records `status`
(`available`/`unavailable`), the exact `query`, `requested_page_size`, optional
`sort`, `returned_count`, `sample_complete`, `has_more` and any `next_url`,
`warning` or `error`. Failed queries use `null` for the returned count and
continuation/completeness fields. A successful page is not necessarily the
complete result set. `coverage.period_queries` and `coverage.paper_samples`
summarize period queries and their samples separately as `complete` or `partial`;
they do not establish literature coverage or source reading.

- `timeline` requests at most five most-cited records per year and exposes the
  first three as `key_papers`. `sample_citation_sum` sums only the returned
  records; it is `null` on query failure or when any sampled citation count is
  missing. `missing_citation_count` records those missing sample values.
  `total_papers` comes from a separate count query for the same topic and exact
  interval, with its own `total_search` status.
- `evolution` requests one most-cited page of at most 1000 records per period.
  `sample_basis` makes the five-paper selection and author-occurrence summary
  explicit: `key_authors` counts only the first three authors of each sampled
  record. `publication_count_change` compares adjacent, available, equally long
  periods with a positive previous count; otherwise it is `null`. It is not
  citation momentum or a categorical trend forecast. `current_status` counts the
  final two years of the requested interval (or the shorter interval), retaining
  its own `time_range` and `search` status. The old `citation_momentum`,
  `growth_rate`, categorical `trend` and `subtopics` outputs are removed.

`time_range_basis` distinguishes `requested_start` from
`default_20_year_lookback`: without a supplied start, the start year is the end
year minus 20. It does not identify the topic's earliest publication. Check the
separate total/recent query statuses as well as the period coverage fields.

`inspire_trace_original_source` returns `source_candidates` and a `trace_chain`
from bounded citation metadata. Each node records distinct observed
`citing_recids`, an `incoming_reference_count`, and whether its reference lookup
was returned, unavailable, or not requested at the depth limit. A returned
`reference_lookup` includes `returned_count`, `unresolved_count`, `selected_count`
and `truncated_by_limit`; these describe the adapter response and the bounded
selection for traversal. An empty lookup is an adapter result,
not proof that the original paper has no bibliography.
`cross_validate=true` filters to candidates cited by at least two distinct
traced records; it does not establish independent scientific confirmation.
Candidates are ordered by that observed count, then known year and record ID.
Unknown-year records remain eligible. The old `original_sources`, priority
confidence, originality labels and `independent_chains` fields are removed.
Scientific priority remains `not_assessed`; establish it from explicit claims
and original texts. Previously saved outputs retain their historical bytes and
meaning, without acquiring current scientific acceptance.

## Aggregated providers

`hep-mcp` re-exposes the bounded provider MCP atoms (`arxiv-mcp`, `openalex-mcp`, `hepdata-mcp`, `pdg-mcp`, `zotero-mcp`) under their own tool names (`arxiv_*`, `openalex_*`, `hepdata_*`, `pdg_*`, `zotero_*`), with the same `standard`/`full` exposure as in the provider packages. Zotero aggregation is gated by `HEP_ENABLE_ZOTERO` (set to `0` to hide `hep_import_from_zotero` and friends); the other providers are always included when present.

The live tool inventory is code-owned and mode-filtered by `HEP_TOOL_MODE` (`standard`, `full`). Exact counts live in the generated category and status docs, not in this README — see the drift lock below.

Compact paper summaries keep up to three author names and carry `authors_omitted`
when names are omitted, including omissions from earlier projections. Markdown
paper views show up to ten names with an explicit `et al. (+N more)` marker when
the list is incomplete. Use the source record for the complete author list.

The [personal plugin](../skills-market/docs/PERSONAL_PLUGIN.md) composes this server
with [`project-mcp`](../project-mcp/README.md) and `idea-mcp`, plus the existing
research skills. It does not register the atomic providers again. Portable manifests launch it through `nullius runtime mcp hep-mcp` using host-private
configuration. HEP can run standalone; when `NULLIUS_PROJECT_ROOT` is configured
it becomes the cwd so the existing project harness applies;
HEP tool calls still use their own `project_root` argument for durable artifact
routing. HEP retains its local-server capabilities and trust boundary; the
project adapter's file restrictions do not sandbox HEP or expose HEP caches
outside the bound project. Chat/Work/Claude-host connections are separate from
the locally tested composition and remain unverified.

## Data root

Resolved per tool call, in this order:

1. `project_root` argument (for an initialized nullius project) → `<project_root>/artifacts/hep-mcp/`
2. `HEP_DATA_DIR` env when set
3. `~/.nullius/hep-mcp/` (scratch fallback)

`PDG_DATA_DIR` follows the resolved root by default at `<resolved root>/pdg`.

`hep_health` checks whether the data and download directories are writable
or can be created when needed. Running it on a fresh project leaves both paths
absent. A search export can create the response cache without downloading any
papers. Its run records refer to individual cache entries by file URI.

A `project_root` is admitted as at the other nullius front doors: in canonical
(symlink-resolved) form, outside any nullius checkout, and initialized. The
project-local directories a call actually uses must be reached through real
directories: these are `artifacts/`, `artifacts/hep-mcp/` and
`artifacts/hep-mcp/pdg/`, and a symlink there (dangling or not) is refused
rather than followed out of the project. Absolute
paths compared with the data root, such as `output_dir`, may name the project
through any alias of its root, while a path that really lands outside it,
including through a dangling symlink, is refused.

`output_dir` requires `project_root`. It is relative to the project root or
absolute (any spelling of the root), is created if missing, may not traverse a
symbolic link below the project root, may not lie under `.nullius/`,
`team/runs/` or `artifacts/hep-mcp/` (compared ignoring letter case), and may not
be the project root itself. An output name is one file name (or
`external_api/<file name>` for API records); the names of one call must be
distinct even when compared ignoring case and Unicode normalization, and none may
be `external_api` itself. A request repeated within one call is made and recorded
once.
Each output file is staged and flushed first and only then given its name, and
a call never replaces an existing file: if any file it would write already
exists, the call is refused, before any provider request when the name is known
in advance. A call that fails removes the files it had already published, so when
that cleanup succeeds it leaves all of its files or none. If cleanup fails, the
error says what is left: published files that could not be removed make it
UNSAFE_FS, stating that the outputs are incomplete and listing them in
`files_left` (with any remaining staging files in `staging_left`); staging files
alone that could not be removed keep the original error, extended with
`staging_left`; a staging file that could not even be identified is named in
`staging_path`; and if the removals cannot be flushed to disk, the error is
UNSAFE_FS saying the cleanup may not survive a crash, with
`unflushed_directories`. Only a crash of the server process during
publication can leave part of a set without such a report. Either way, a later
call naming those files is then
refused until they are removed. Choose a new `output_dir` (or new artifact names)
to run a tool again; earlier outputs keep their bytes.

## Build & run

```bash
pnpm -r build
node packages/hep-mcp/dist/index.js
```

Wire into an MCP client (Cursor / Claude Desktop / Claude Code / Codex / OpenCode / etc.):

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/nullius/packages/hep-mcp/dist/index.js"],
      "env": {
        "HEP_DATA_DIR": "~/.nullius/hep-mcp",
        "HEP_TOOL_MODE": "standard"
      }
    }
  }
}
```

`inspire_literature` accepts the common optional `project_root` in all seven modes while retaining each mode's own required and allowed provider arguments. Use a digit string or a positive JSON integer for a literature record ID. Quote IDs above 9007199254740991 to preserve every digit. `get_bibtex` accepts an array of these IDs, a single ID, or a comma- or whitespace-separated string.

## Front-door drift lock

The tool inventory, doc tables, and category counts are tied together by:

```bash
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
pnpm --filter @nullius/hep-mcp test -- tests/docs/docToolDrift.test.ts
```

These fail closed when `docs/TOOL_CATEGORIES.md` or `meta/docs/orchestrator-mcp-tools-spec.md` drift from the live registry.

## Build & test

```bash
pnpm -C packages/hep-mcp build
pnpm -C packages/hep-mcp test
```

## See also

- Root [README.md](../../README.md) — surface policy and end-to-end smoke path
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.1 — `HEP_DATA_DIR` resolution
- [docs/TOOL_CATEGORIES.md](../../docs/TOOL_CATEGORIES.md) — live tool taxonomy
