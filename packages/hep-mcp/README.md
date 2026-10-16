# @nullius/hep-mcp

Current most mature HEP domain pack. Local stdio MCP server exposing `hep_*` tools for literature search exports, identifier and Zotero mappings, and provider-local composition.

## Layer

Domain workflow pack. The strongest end-to-end example in the repo, but **not the root product identity** — generic lifecycle and contracts live in `@nullius/orchestrator` and `@nullius/shared`. See root [README.md](../../README.md) §3 Layer Model.

`hep-mcp` is a tool package, not generic lifecycle or approval authority. It keeps no runs, paper/evidence projects or evidence catalogs of its own: runs, approvals and lifecycle belong to the orchestrator (`<project_root>/artifacts/runs/<run_id>/`). Tools that produce files (`hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `hep_import_from_zotero`, `inspire_parse_latex`, `inspire_theoretical_conflicts`, and `inspire_search` when given `output_dir`) write them into a caller-chosen `output_dir`, typically a subdirectory of the current run directory, and return project-relative paths (`export_path`, `meta_path`, `mapping_path`, `path`, `artifacts[].path`). INSPIRE lookups made through the response cache (by `hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `inspire_search` with `output_dir`, and the INSPIRE resolution step of `hep_import_from_zotero`) are recorded request by request under `<output_dir>/external_api/`; other provider calls (the Zotero local API, the paper fetches of `inspire_theoretical_conflicts`, the source retrieval of `inspire_parse_latex`) are not recorded there. There are no project or evidence catalog, draft rendering, project export or paper bundling tools.

Historical HEP run directories (`runs/<run_id>/` under a HEP data root) and paper/evidence project directories (`projects/<project_id>/`, including evidence catalogs) written by earlier versions are evidence: they stay readable in place and no tool creates or rewrites them. [docs/URI_REGISTRY.md](../../docs/URI_REGISTRY.md) gives the reading rules for historical `hep://runs/...` and `hep://projects/...` references.

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

`inspire_literature` accepts the common optional `project_root` in all seven modes while retaining each mode's own required and allowed provider arguments. Its advertised catalog, parser and dispatcher agree; `size` is optional and is not required by modes that reject it.

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
