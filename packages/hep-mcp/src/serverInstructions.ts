/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Literature and data tools for high-energy physics: INSPIRE search and analysis, arXiv sources, HEPData, OpenAlex, the local PDG database and the Zotero app\'s local API. ' +
  'Papers are addressed by INSPIRE recid, arXiv id or DOI. With project_root (an initialized nullius project) the INSPIRE, PDG and download data of a call live under <project_root>/artifacts/hep-mcp, and tools with output_dir write there; the arXiv, HEPData and OpenAlex tools keep their own data dirs (ARXIV_DATA_DIR, else <tmpdir>/arxiv-mcp-data; HEPDATA_DATA_DIR or OPENALEX_DATA_DIR, else under HEP_DATA_DIR). ' +
  'Configuration comes from the environment: HEP_DATA_DIR, PDG_DB_PATH, OPENALEX_API_KEY, HEP_ENABLE_ZOTERO, HEP_TOOL_MODE=full for every tool. ' +
  'Tools marked destructive by risk level require _confirm: true; Zotero changes instead use the confirm_token returned by zotero_add or zotero_delete, passed to zotero_confirm.';
