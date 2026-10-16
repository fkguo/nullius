/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Searches HEPData (hepdata.net) for experimental measurement records and returns their tables; no credentials are needed. ' +
  'hepdata_search returns integer hepdata_id values for hepdata_get_record, which lists the table_id values for hepdata_get_table. ' +
  'hepdata_download (requires _confirm: true) writes the submission under HEPDATA_DATA_DIR, else HEP_DATA_DIR/hepdata, else ~/.hep-mcp/hepdata. ' +
  'HEPDATA_TOOL_MODE=full lists every tool.';
