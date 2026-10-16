/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Literature and data tools for high-energy physics: INSPIRE search and analysis, arXiv sources, HEPData, OpenAlex, the local PDG database and the Zotero app\'s local API. ' +
  'Papers are addressed by INSPIRE recid, arXiv id or DOI. With project_root (an initialized nullius project) the hep-mcp caches, downloads and PDG data of a call live under <project_root>/artifacts/hep-mcp; tools that write research outputs take an output_dir that you choose inside project_root, outside the reserved areas its parameter description lists (artifacts/hep-mcp/ among them). ' +
  'Paper sources fetched by the arXiv and INSPIRE parsing tools go to ARXIV_DATA_DIR (else <tmpdir>/arxiv-mcp-data); HEPData and OpenAlex keep HEPDATA_DATA_DIR and OPENALEX_DATA_DIR (else under HEP_DATA_DIR). ' +
  'Other configuration: PDG_DB_PATH, OPENALEX_API_KEY, HEP_ENABLE_ZOTERO, HEP_TOOL_MODE=full for every tool. ' +
  'Tools marked destructive by risk level require _confirm: true; Zotero changes instead use the confirm_token from zotero_add or zotero_delete, passed to zotero_confirm.';
