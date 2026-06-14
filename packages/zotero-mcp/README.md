# zotero-mcp

Zotero (Local API) MCP server for **local** library management.

## Constraints (by design)

- **Local MCP transport only**: stdio (`StdioServerTransport`) only; no HTTP transport/server.
- **Zotero Local API only**: `http://127.0.0.1:23119` (no Zotero Web API).
- **Tool-only server**: exposes Zotero tools and `zotero://select/...` result URIs, but does not advertise MCP resources or prompts.

## Build & Run

```bash
pnpm -C packages/zotero-mcp build
pnpm -C packages/zotero-mcp start
```

Or run the workspace binary after build:

```bash
pnpm -C packages/zotero-mcp build
pnpm -C packages/zotero-mcp exec zotero-mcp
```

## Environment Variables

- `ZOTERO_BASE_URL` (default: `http://127.0.0.1:23119`) — must be the Zotero Local API base URL.
- `ZOTERO_DATA_DIR` (default: `~/Zotero`) — Zotero data directory (used to resolve `.zotero-ft-cache`).
- `ZOTERO_FILE_REDIRECT_GUARD` (default: disabled) — when enabled, only accept `file://` redirects that resolve within allowed roots (defense-in-depth for linked attachments).
- `ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS` (default: empty) — extra allowed filesystem roots for `file://` redirects (for linked attachments; separated by `:` on macOS/Linux, `;` on Windows).
- `ZOTERO_CONFIRM_TTL_MS` (default: `600000`, max: `3600000`) — confirmation token TTL for write operations.
- `ZOTERO_TOOL_MODE` (`standard`/`full`, default: `standard`) — tool exposure mode.
- `ZOTERO_WRITE_TOKEN` (default: auto-read from the Zotero profile `prefs.js`) — auth token for the zotero-inspire write endpoint used by file attachment and `zotero_delete`. Set this to override automatic detection.

## Writes require the zotero-inspire plugin

The native Zotero Local API is **read-only** (every `POST`/`DELETE` returns `400 "Endpoint does not support method"`). Item/note creation works through the Connector, but **file attachment** (`zotero_add` + `file_path`) and **deletion** (`zotero_delete`) require the **zotero-inspire** plugin (≥ 3.0.3), which registers an authenticated `POST /connector/zinspireWrite` endpoint. If the plugin is absent, the item write still succeeds and the attachment is reported as `file_attached:false` with a structured `attach_error` (never silently dropped).

## Tool Surface

- `standard`:
  - `zotero_local` (modes: `list_collections`, `list_collection_paths`, `list_items`, `get_item`, `get_item_attachments`, `download_attachment`, `get_attachment_fulltext`, `list_tags`)
  - `zotero_find_items`, `zotero_search_items`, `zotero_get_selected_collection`, `zotero_export_items`
  - `zotero_add` (preview-only; optional `file_path` with `attach_mode` `import`/`link`; returns `confirm_token`)
  - `zotero_delete` (preview-only; `mode` `trash`/`erase`; returns `confirm_token`)
  - `zotero_confirm` (executes a confirmed add or delete)
- `full`: currently identical to `standard` (reserved for future expansion).

### `zotero_find_items` vs `zotero_search_items`

- Use `zotero_search_items` for **interactive browsing/search**: it forwards query params to Zotero Local API and returns a lightweight summary (often good for “find candidates and get item keys”).
- Use `zotero_find_items` for **identifier resolution/dedupe**: you provide identifiers (doi/arXiv/INSPIRE recid/item_key/title) and optional filters; it fetches a limited candidate set and verifies which items actually match (optionally scoped by `collection_key`, and `include_children` to include descendant collections).
- Both tools return the same per-item summary shape under `items` (`item_key`, `item_type`, `title`, `select_uri`, `identifiers`, …).

## Integration with `hep-mcp`

In this monorepo, `@autoresearch/hep-mcp` aggregates `zotero-mcp` tools by default. Set `HEP_ENABLE_ZOTERO=0` to hide Zotero tools in `hep-mcp` (including `hep_import_from_zotero`).
