# Ecosystem Configuration Registry (v1)

> Single source of truth for all environment-variable–based configuration across the autoresearch ecosystem.

## Priority Chain

Environment variables follow a strict priority chain (highest → lowest):

1. **Environment variable** (`process.env.X` / `os.environ['X']`)
2. **`.env` file** (loaded via `dotenv/config` at MCP entry point)
3. **Hardcoded default** in source code

## Configuration Keys

### Core (hep-mcp)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `HEP_DATA_DIR` | path | `~/.hep-research-mcp` | Root data directory for all HEP artifacts, downloads, cache | hep-mcp, pdg-mcp, hep-autoresearch |
| `HEP_TOOL_MODE` | `standard` \| `full` | `standard` | Tool exposure level — `standard` shows core tools, `full` shows all | hep-mcp |
| `HEP_DOWNLOAD_DIR` | path | `<HEP_DATA_DIR>/downloads` | Override directory for arXiv/paper downloads | hep-mcp |
| `ARXIV_DOWNLOAD_DIR` | path | `<HEP_DATA_DIR>/downloads` | Alias for `HEP_DOWNLOAD_DIR` (fallback) | hep-mcp |
| `WRITING_PROGRESS_DIR` | path | `<HEP_DATA_DIR>/writing_progress` | Directory for writing pipeline artifacts | hep-mcp |
| `HEP_ENABLE_ZOTERO` | boolean | `true` | Enable/disable Zotero Local API integration | hep-mcp |
| `HEP_DEBUG` | comma-separated | (none) | Enable debug logging for specific categories (e.g. `cache,evidence`) | hep-mcp |
| `DEBUG` | any | (none) | Enable all debug logging if set | hep-mcp |
| `HEP_ENABLE_TOOL_USAGE_TELEMETRY` | boolean | (unset) | Enable tool call telemetry | hep-mcp |

### LLM Provider (hep-mcp writing subsystem)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `WRITING_LLM_PROVIDER` | string | (none) | LLM provider: `openai`, `anthropic`, `google`, `deepseek`, `kimi`, `glm`, `qwen`, `openai-compatible` | hep-mcp |
| `WRITING_LLM_API_KEY` | string | (none) | API key for the selected LLM provider | hep-mcp |
| `WRITING_LLM_MODEL` | string | provider default | Model identifier (e.g. `gpt-4o`, `claude-sonnet-4-20250514`) | hep-mcp |
| `WRITING_LLM_BASE_URL` | URL | provider default | API endpoint override for custom/self-hosted endpoints | hep-mcp |
| `WRITING_LLM_TEMPERATURE` | float | `0.3` | Sampling temperature (0.0–2.0) | hep-mcp |
| `WRITING_LLM_MAX_TOKENS` | int | (none) | Max output tokens per request | hep-mcp |
| `WRITING_LLM_MODE` | `passthrough` \| `client` \| `internal` | derived | LLM call strategy | hep-mcp |
| `WRITING_LLM_TIMEOUT` | int (ms) | `90000` | LLM request timeout | hep-mcp |
| `WRITING_LLM_MAX_RETRIES` | int | `3` | LLM request retry count | hep-mcp |
| `CONCURRENCY_LIMIT` | int | derived | Max concurrent section writes | hep-mcp |

### PDG (pdg-mcp)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `PDG_DB_PATH` | path | (none) | Absolute path to PDG SQLite database; enables PDG tools when set | pdg-mcp |
| `PDG_DATA_DIR` | path | `<HEP_DATA_DIR>/pdg` | PDG data/artifacts directory | pdg-mcp |
| `PDG_TOOL_MODE` | `standard` \| `full` | `standard` | PDG tool exposure level | pdg-mcp |
| `PDG_ARTIFACT_TTL_HOURS` | int | `24` | Artifact cache TTL in hours | pdg-mcp |
| `PDG_SQLITE_MAX_STDOUT_BYTES` | int | `52428800` | Max output from sqlite3 CLI (50 MB) | pdg-mcp |
| `PDG_SQLITE_CONCURRENCY` | int | `4` | Max concurrent sqlite3 operations | pdg-mcp |
| `PDG_ARTIFACT_DELETE_AFTER_READ` | boolean | (unset) | Delete artifacts after reading | pdg-mcp |

### Zotero (zotero-mcp)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `ZOTERO_BASE_URL` | URL | `http://127.0.0.1:23119` | Zotero Local API endpoint (strict: only localhost:23119) | zotero-mcp, hep-mcp |
| `ZOTERO_DATA_DIR` | path | (none) | Path to Zotero data directory (for PDF attachment resolution) | hep-mcp |

### Python Orchestrator (hep-autoresearch)

| Key | Type | Default | Description | Read by |
|-----|------|---------|-------------|---------|
| `HEP_AUTORESEARCH_DIR` | path | derived | Runtime state directory | hep-autoresearch |
| `HEP_MCP_PACKAGE_DIR` | path | auto-detected | Path to hep-mcp package | hep-autoresearch |
| `HEPAR_HTTP_MODE` | `live` \| `record` \| `replay` \| `fail_all` | `live` | HTTP handling mode for testing | hep-autoresearch |
| `HEPAR_HTTP_FIXTURES_DIR` | path | (none) | HTTP fixture cache directory (record/replay) | hep-autoresearch |
| `HEPAR_RECORD_ABS_PATHS` | boolean | `false` | Record absolute paths in artifacts | hep-autoresearch |
| `CODEX_HOME` | path | (none) | Codex CLI home directory | hep-autoresearch |

### MCP Subprocess Environment Allowlist

The Python MCP client (`mcp_config.py`) uses a strict allowlist for environment variables forwarded to MCP subprocesses. Only these variables are propagated:

```
PATH, NODE_PATH, NODE_OPTIONS, NVM_DIR, NVM_BIN,
npm_config_prefix, PNPM_HOME, PYTHONPATH, VIRTUAL_ENV,
LANG, LC_ALL, LC_CTYPE, HOME, USER, LOGNAME,
TMPDIR, TEMP, TMP, SHELL,
HEP_TOOL_MODE, PDG_DB_PATH, PDG_ARTIFACT_TTL_HOURS
```

## Security Notes

- **API keys** (`WRITING_LLM_API_KEY`) are never forwarded to MCP subprocesses.
- **Zotero** is restricted to localhost only — no Zotero Web API support.
- **PDG database** path must be absolute and existing.
- **`HEP_DATA_DIR`** supports `~` expansion for home directory.
