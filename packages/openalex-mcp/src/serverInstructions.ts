/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Queries OpenAlex (api.openalex.org) for works, authors, sources and other entities, and downloads open full text from content.openalex.org. ' +
  'OPENALEX_API_KEY is read from the environment (required for semantic search); OPENALEX_MAILTO identifies the caller. ' +
  'Entities accept OpenAlex ids (W…, A…, S…), DOIs and other ids the tool descriptions list; deep pagination uses the returned cursor. ' +
  'Bulk results and downloads are written under OPENALEX_DATA_DIR, else HEP_DATA_DIR/openalex, else ~/.nullius/openalex; OPENALEX_TOOL_MODE=full lists every tool.';
