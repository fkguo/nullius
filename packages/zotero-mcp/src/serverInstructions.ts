/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Reads and edits the user\'s Zotero library through the Zotero app\'s local API at http://127.0.0.1:23119, which must be running. ' +
  'Items are addressed by Zotero item keys; zotero_add resolves INSPIRE recids, DOIs and arXiv ids on INSPIRE (CrossRef fallback). ' +
  'zotero_add and zotero_delete only preview and return a confirm_token; zotero_confirm performs the change. ' +
  'Deletes and attachment uploads go through the zotero-inspire plugin endpoint, authorised by ZOTERO_WRITE_TOKEN or the token in the Zotero profile prefs; ZOTERO_TOOL_MODE=full lists every tool.';
