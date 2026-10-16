/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Searches arXiv and reads paper metadata and sources from export.arxiv.org and arxiv.org; no credentials are needed. ' +
  'Paper ids are new-style (2301.01234, optional vN) or old-style (hep-ph/0601234); categories look like hep-ph or cond-mat.str-el. ' +
  'arxiv_paper_source with mode=content downloads into ARXIV_DATA_DIR (default <tmpdir>/arxiv-mcp-data); requests are rate-limited across processes. ' +
  'ARXIV_TOOL_MODE=full lists every tool.';
