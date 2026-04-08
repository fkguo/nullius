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

### TypeScript Orchestrator (`@autoresearch/orchestrator`)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `AUTORESEARCH_CONTROL_DIR` | path | derived | Control-plane state directory for `.autoresearch` ledger/state/plan files | orchestrator, hep-mcp |

### Internal Python Residue (`hep-autoresearch`, maintainer/eval only)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `HEP_AUTORESEARCH_DIR` | path | derived | Internal runtime state directory override | hep-autoresearch |
| `HEP_MCP_PACKAGE_DIR` | path | auto-detected | Internal override for locating the HEP MCP package checkout | hep-autoresearch |
| `HEPAR_HTTP_MODE` | `live` \| `record` \| `replay` \| `fail_all` | `live` | Internal HTTP fixture/testing mode | hep-autoresearch |
| `HEPAR_HTTP_FIXTURES_DIR` | path | (none) | Fixture cache directory required by `record` / `replay` modes | hep-autoresearch |
| `HEPAR_RECORD_ABS_PATHS` | boolean | `false` | Internal artifact-path recording toggle | hep-autoresearch |
| `CODEX_HOME` | path | (none) | Skill discovery root for internal Python wrappers that invoke Codex-managed tools | hep-autoresearch |

### MCP Subprocess Environment Allowlist

The internal Python MCP client (`mcp_config.py`) uses a strict allowlist for environment variables forwarded to MCP subprocesses. Only these variables are propagated:

```
PATH, NODE_PATH, NODE_OPTIONS, NVM_DIR, NVM_BIN,
npm_config_prefix, PNPM_HOME, PYTHONPATH, VIRTUAL_ENV,
LANG, LC_ALL, LC_CTYPE, HOME, USER, LOGNAME,
TMPDIR, TEMP, TMP, SHELL,
HEP_TOOL_MODE, PDG_DB_PATH, PDG_ARTIFACT_TTL_HOURS
```

## Security Notes

- **Zotero** is restricted to localhost only — no Zotero Web API support.
- **PDG database** path must be absolute and existing.
- **`HEP_DATA_DIR`** and **`PDG_DATA_DIR`** support `~` expansion for the home directory.
- Public/default guidance should point users to `autoresearch` and the MCP package READMEs; internal Python residue variables are listed here only so CI/dev contract checks have one truthful registry.
