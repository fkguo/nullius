/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Literature and data tools for high-energy physics: INSPIRE search and analysis, arXiv sources, HEPData, OpenAlex, the local PDG database and the Zotero local API. ' +
  'Papers are addressed by INSPIRE recid, arXiv id or DOI. Pass project_root (an initialized nullius project) to keep caches and downloads under <project_root>/artifacts/hep-mcp; tools that write files put them in output_dir, which requires project_root. ' +
  'Configuration comes from the environment: HEP_DATA_DIR, PDG_DB_PATH, OPENALEX_API_KEY, HEP_ENABLE_ZOTERO, HEP_TOOL_MODE=full for every tool. ' +
  'Destructive tools require _confirm: true.';
