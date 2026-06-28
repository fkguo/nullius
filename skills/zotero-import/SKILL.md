---
name: zotero-import
description: "Teaches the two-step zotero_add then zotero_confirm pipeline for importing papers into Zotero, including collection selection, file attachment, dedup handling, and non-HEP DOI support.\n"
---

# Zotero Import Workflow

This skill teaches the correct tool-calling sequence for importing papers into Zotero via the `zotero_*` MCP tools.
All Zotero tools are local-only and require Zotero to be running with the Local API enabled (Settings → Advanced → "Allow other applications on this computer to communicate with Zotero").

> **Writes need the zotero-inspire plugin.** Zotero's native Local API is **read-only** — every `POST`/`DELETE` returns `400 "Endpoint does not support method"`. File attachment (`zotero_add` + `file_path`) and deletion (`zotero_delete`) are performed through the **zotero-inspire plugin (≥ 3.0.3)**, which registers an authenticated `POST /connector/zinspireWrite` endpoint. The MCP reads the endpoint token from the Zotero profile `prefs.js` automatically; override with the `ZOTERO_WRITE_TOKEN` env var. Item/note creation still works without the plugin (via the Connector). If the plugin is missing, item writes succeed and the attachment is reported as `file_attached:false` with an `attach_error` (never silently dropped).

## Core Pattern: Two-Step Add/Confirm

Every Zotero write operation follows a preview-then-confirm pattern:

```
zotero_add { source: {...}, ... }     # Step 1: Preview — returns confirm_token
    |
zotero_confirm { confirm_token: "..." } # Step 2: Execute — creates/updates the item
```

The `zotero_add` call resolves metadata, checks for duplicates, and returns a `confirm_token` (valid for 10 minutes). The agent should present the preview to the user, then call `zotero_confirm` to execute.

## Source Types

### INSPIRE (HEP papers)
```json
{ "source": { "type": "inspire", "recid": "1234567" } }
```

### DOI (HEP and non-HEP)
```json
{ "source": { "type": "doi", "doi": "10.1103/PhysRevD.110.030001" } }
```
- HEP DOIs are resolved via INSPIRE first (richer metadata with arXiv IDs, collaborations).
- Non-HEP DOIs automatically fall back to CrossRef (e.g., `10.1063/1.864977`).

### arXiv
```json
{ "source": { "type": "arxiv", "arxiv_id": "2301.12345" } }
```

### Manual item
```json
{
  "source": {
    "type": "item",
    "item": {
      "itemType": "journalArticle",
      "title": "...",
      "creators": [{ "creatorType": "author", "lastName": "...", "firstName": "..." }],
      "DOI": "10.xxx/yyy",
      "date": "2024"
    }
  }
}
```

## Collection Selection

### Option A: Use Zotero UI selection (default)
If `collection_keys` is omitted, the tool writes to whichever collection is currently selected in Zotero's left sidebar. To check:
```
zotero_get_selected_collection {}
```

Before any write, verify that the selected collection is intended for this task. Do not write to
personal, reserved, archival, or project-excluded collections just because they happen to be selected
in the Zotero UI. If the collection name suggests it is reserved, or if the user has named a collection
that must not receive imported papers, stop and ask for an explicit collection key or a different UI
selection. A read-only lookup does not require collection confirmation; a write does.

### Option B: Explicit collection key
```json
{ "source": {...}, "collection_keys": ["ABCD1234"] }
```

### Library root
By default, writing to the library root (no collection) is rejected. Override with:
```json
{ "source": {...}, "allow_library_root": true }
```

## Existing Zotero Items

When the user provides a Zotero select URI such as `zotero://select/library/items/ABCD1234`,
prefer a read-only inspection of that existing item and its attachments before attempting an import.
Use the item key with `zotero_local`, `zotero_find_items`, `zotero_search_items`, or
`zotero_export_items` as appropriate. Do not create a duplicate item from DOI/arXiv metadata unless the
user explicitly asks to import another copy or the existing item is confirmed unsuitable.

## File Attachment

To attach a local file (e.g., a downloaded PDF) to the created item:
```json
{
  "source": { "type": "doi", "doi": "10.xxx/yyy" },
  "file_path": "/absolute/path/to/paper.pdf",
  "attach_mode": "import"
}
```

- The path must be **absolute** and the file must exist.
- Attachment is performed via the zotero-inspire write endpoint (see the note at the top); the native Local API cannot attach files.
- `attach_mode` (default **`import`**):
  - **`import`** — copies the file into Zotero storage. **Never mutates the source file** and is robust to file-management plugins. Recommended default.
  - **`link`** — references the file in place (Zotero stores a path, not a copy). ⚠️ File-management plugins (e.g. **Attanger**, ZotFile) auto-rename/move linked source files based on the parent item's metadata — using `link` may rename your original file on disk. Prefer `import` unless you specifically manage linked files yourself.
- On success the confirm result reports `file_attached: true`, `attach_mode`, and `attachment_key`. On failure it reports `file_attached: false` and a structured `attach_error` (the item write still succeeds).
- Supported formats: PDF, EPUB, HTML, DJVU, DOC/DOCX, and others.

## Deduplication

The `dedupe` parameter controls behavior when the item already exists in Zotero:

| Value | Behavior |
|-------|----------|
| `return_existing` (default) | Return the existing item without changes |
| `update_existing` | Add new collections/tags/notes to the existing item |
| `error_on_existing` | Throw an error if the item exists |

Dedup matches on DOI, arXiv ID, and INSPIRE recid.

## Tags and Notes

```json
{
  "source": { "type": "doi", "doi": "10.xxx/yyy" },
  "tags": ["hep-ph", "review"],
  "note": "Key reference for section 3"
}
```

## Complete Example: Import a non-HEP paper with PDF

```
# 1. Check which collection is selected
zotero_get_selected_collection {}

# 2. Preview the import
zotero_add {
  "source": { "type": "doi", "doi": "10.1063/1.864977" },
  "tags": ["plasma-physics"],
  "file_path": "/path/to/Downloads/hasegawa1983.pdf"
}
# -> Returns confirm_token + preview

# 3. Confirm
zotero_confirm { "confirm_token": "<token from step 2>" }
# -> Item created with PDF attached
```

## Integration with sci-hub

When a paper has been downloaded via sci-hub, the manifest contains the DOI and file path. Use these directly:
```
zotero_add {
  "source": { "type": "doi", "doi": "<DOI from manifest>" },
  "file_path": "<downloaded PDF path>"
}
```

## Common Pitfalls

1. **Token expiry**: Confirm tokens expire after 10 minutes. If expired, re-run `zotero_add`.
2. **Collection not selected**: If Zotero has no collection selected and no `collection_keys` given, the call fails. Check with `zotero_get_selected_collection` first.
3. **Native Local API is read-only**: The native Local API cannot create attachments or delete items (`400 "Endpoint does not support method"`). File attachment and `zotero_delete` route through the zotero-inspire plugin endpoint (see the note at the top). If it is unavailable, item/note creation still works; attachment is reported as `file_attached:false` + `attach_error` rather than silently dropped.
4. **`link` attach mutates source files**: With `attach_mode:"link"`, file-management plugins (Attanger/ZotFile) may rename or move your source file. Use the default `attach_mode:"import"`.
5. **Large metadata**: The `item` source type has a 200KB JSON limit.

## Deleting Items

Delete follows the same preview → confirm pattern (destructive, so it is gated):

```
# 1. Preview — resolves each key's title/type; returns confirm_token
zotero_delete { "item_keys": ["ABCD1234", "EFGH5678"], "mode": "trash" }

# 2. Execute
zotero_confirm { "confirm_token": "<token from step 1>" }
```

- `mode: "trash"` (default) moves items to the Zotero trash — **recoverable**.
- `mode: "erase"` permanently deletes them — **not recoverable**; the preview warns accordingly.
- Missing keys are flagged in the preview and skipped on execute; per-item results are returned (`succeeded`/`skipped`/`failed`).
- Deleting a top-level item removes its child attachments/notes too.

## Tool Reference

| Tool | Purpose |
|------|---------|
| `zotero_get_selected_collection` | Check which collection is selected in Zotero UI |
| `zotero_add` | Preview a Zotero add/update with optional `file_path` (`attach_mode` import/link); returns confirm_token |
| `zotero_delete` | Preview a trash/erase of items by key; returns confirm_token |
| `zotero_confirm` | Execute a previewed write operation (add or delete) |
| `zotero_local` | Query Zotero Local API directly (read operations) |
| `zotero_find_items` | Search existing Zotero items |
| `zotero_search_items` | Full-text search in Zotero library |
| `zotero_export_items` | Export items as BibTeX/CSL-JSON/RIS/etc. |
