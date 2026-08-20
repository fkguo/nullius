# Ecosystem Configuration Registry (v1)

> Public registry for environment-variable configuration that still matters to checked-in, live surfaces.
> Historical or maintainer-only knobs may continue to exist internally, but they should not be treated as public front-door configuration authority.

## Priority Chain

Environment variables follow a strict priority chain (highest → lowest):

1. **Environment variable** (`process.env.X` / `os.environ['X']`)
2. **`.env` file** (loaded via `dotenv/config` at MCP entry point)
3. **Hardcoded default** in source code

## Configuration Keys

### Core (`hep-mcp`)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `HEP_DATA_DIR` | path | `~/.hep-mcp` | Root data directory for HEP artifacts, downloads, cache, and colocated provider state | hep-mcp, pdg-mcp |
| `HEP_TOOL_MODE` | `standard` \| `full` | `standard` | Tool exposure level — `standard` shows core tools, `full` shows all | hep-mcp |
| `HEP_DOWNLOAD_DIR` | path | `<HEP_DATA_DIR>/downloads` | Override directory for arXiv/paper downloads | hep-mcp |
| `ARXIV_DOWNLOAD_DIR` | path | `<HEP_DATA_DIR>/downloads` | Alias for `HEP_DOWNLOAD_DIR` (fallback) | hep-mcp |
| `WRITING_PROGRESS_DIR` | path | `<HEP_DATA_DIR>/writing_progress` | Directory for run progress artifacts | hep-mcp |
| `HEP_ENABLE_ZOTERO` | boolean | `true` | Enable/disable Zotero Local API integration | hep-mcp |
| `HEP_ENABLE_MULTIMODAL_RETRIEVAL` | boolean | `true` | Enable multimodal retrieval surfaces when supported by the current build | hep-mcp |
| `HEP_DEBUG` | comma-separated | (none) | Enable debug logging for specific categories (e.g. `cache,evidence`) | hep-mcp |
| `HEP_ENABLE_TOOL_USAGE_TELEMETRY` | boolean | (unset) | Enable tool call telemetry artifacts and summaries | hep-mcp |

### Runtime / Sampling (`hep-mcp`)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `ZOTERO_BASE_URL` | URL | `http://127.0.0.1:23119` | Zotero Local API endpoint (strictly local-only) | zotero-mcp, hep-mcp |
| `ZOTERO_DATA_DIR` | path | (none) | Zotero data directory for attachment/fulltext resolution | zotero-mcp, hep-mcp |

Note: host-side sampling and orchestration now own writing/model decisions. This registry only tracks the remaining environment variables that still shape checked-in runtime behavior.

### PDG (`pdg-mcp`)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `PDG_DB_PATH` | path | (none) | Absolute path to PDG SQLite database; enables PDG tools when set | pdg-mcp |
| `PDG_DATA_DIR` | path | `<HEP_DATA_DIR>/pdg` | PDG data/artifacts directory | pdg-mcp |
| `PDG_TOOL_MODE` | `standard` \| `full` | `standard` | PDG tool exposure level | pdg-mcp |
| `PDG_ARTIFACT_TTL_HOURS` | int | `24` | Artifact cache TTL in hours | pdg-mcp |
| `PDG_SQLITE_MAX_STDOUT_BYTES` | int | `52428800` | Max output from sqlite3 CLI (50 MB) | pdg-mcp |
| `PDG_SQLITE_CONCURRENCY` | int | `4` | Max concurrent sqlite3 operations | pdg-mcp |
| `PDG_ARTIFACT_DELETE_AFTER_READ` | boolean | (unset) | Delete artifacts after reading | pdg-mcp |

### TypeScript Orchestrator (`@nullius/orchestrator`)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `NULLIUS_CONTROL_DIR` | path | derived | Control-plane state directory for `.nullius` ledger/state/plan files | orchestrator, hep-mcp |
| `NULLIUS_RUN_MCP_COMMAND` | path or command | (none) | Local stdio MCP server executable used by `nullius run` workflow steps | orchestrator |
| `NULLIUS_RUN_MCP_ARGS_JSON` | JSON string array | `[]` | Arguments passed directly to the configured MCP executable | orchestrator |
| `NULLIUS_RUN_MCP_ENV_JSON` | JSON string map | `{}` | Explicit non-secret MCP server configuration; credential-shaped and process-injection keys are rejected | orchestrator |
| `NULLIUS_RUN_MCP_CREDENTIALS_JSON` | JSON string map | `{}` | Explicit MCP credential name/value declarations; values are not copied from the ambient environment | orchestrator |
| `NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON` | JSON string array | `[]` | Credential names required by the configured MCP server; missing or empty declared values fail before spawn | orchestrator |

### MCP Subprocess Environment Allowlist

MCP subprocess launchers use an isolated temporary `HOME`, an explicit working directory, and a strict ambient baseline. Only these ambient variables are propagated by the orchestrator stdio launch path:

```
PATH, TMPDIR, TEMP, TMP, LANG, LC_ALL, LC_CTYPE, TZ,
HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY,
http_proxy, https_proxy, all_proxy, no_proxy,
SSL_CERT_FILE, SSL_CERT_DIR, NODE_EXTRA_CA_CERTS
```

Server configuration must be named explicitly in `NULLIUS_RUN_MCP_ENV_JSON`. Credential-shaped names are rejected there and must instead be named exactly in `NULLIUS_RUN_MCP_CREDENTIALS_JSON`; names listed by `NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON` are checked before spawn so authenticated providers cannot silently degrade to anonymous operation. Loader and shell injection variables such as `NODE_OPTIONS`, `PYTHONPATH`, `LD_PRELOAD`, `DYLD_*`, and `BASH_ENV` are rejected in both channels. Credential values are never included in validation errors. On POSIX systems the server runs in a dedicated process group so timeout and shutdown apply to its descendant tree. Required containment fails closed on platforms where that guarantee is unavailable; a direct-child-only Windows launch requires an explicit best-effort API selection.

## Security Notes

- **Zotero** is restricted to localhost only — no Zotero Web API support.
- **PDG database** path must be absolute and existing.
- **`HEP_DATA_DIR`** and **`PDG_DATA_DIR`** support `~` expansion for the home directory.
- Public/default guidance should point users to `nullius` and the MCP package READMEs; internal Python residue variables are listed here only so CI/dev contract checks have one truthful registry.
