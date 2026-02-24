---
name: zotero-import
description: >
  Teaches the two-step zotero_add -> zotero_confirm pipeline for importing papers into Zotero,
  including collection selection, file attachment, dedup handling, and non-HEP DOI support.
---

# Zotero Import Workflow

This skill teaches the correct tool-calling sequence for importing papers into Zotero via the `zotero_*` MCP tools.
All Zotero tools are local-only and require Zotero to be running with the Local API enabled.

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

### Option B: Explicit collection key
```json
{ "source": {...}, "collection_keys": ["ABCD1234"] }
```

### Library root
By default, writing to the library root (no collection) is rejected. Override with:
```json
{ "source": {...}, "allow_library_root": true }
```

## File Attachment

To attach a local file (e.g., a downloaded PDF) to the created item:
```json
{
  "source": { "type": "doi", "doi": "10.xxx/yyy" },
  "file_path": "/absolute/path/to/paper.pdf"
}
```

- The file is attached as a **linked file** (Zotero stores a reference, not a copy).
- The path must be absolute and the file must exist.
- **Requires Zotero Local API write access** (not available via Connector fallback).
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
  "file_path": "/Users/me/Downloads/hasegawa1983.pdf"
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
3. **Connector vs Local API write**: Some operations (file attachment, multi-collection) require Local API write access enabled in Zotero preferences. The Connector fallback has limitations.
4. **Large metadata**: The `item` source type has a 200KB JSON limit.

## Tool Reference

| Tool | Purpose |
|------|---------|
| `zotero_get_selected_collection` | Check which collection is selected in Zotero UI |
| `zotero_add` | Preview a Zotero add/update (returns confirm_token) |
| `zotero_confirm` | Execute a previewed write operation |
| `zotero_local` | Query Zotero Local API directly (read operations) |
| `zotero_find_items` | Search existing Zotero items |
| `zotero_search_items` | Full-text search in Zotero library |
| `zotero_export_items` | Export items as BibTeX/CSL-JSON/RIS/etc. |
| `zotero_add` | Import with optional `file_path` for PDF attachment |
