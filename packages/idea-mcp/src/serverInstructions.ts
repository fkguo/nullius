/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Creates and steers idea campaigns in a local idea store; no network access. ' +
  'IDEA_MCP_DATA_DIR (required, outside the nullius checkout) holds the store; IDEA_MCP_CONTRACT_DIR optionally points at the contract schemas. ' +
  'campaign_id and seed ids are short ids; every mutating call takes an idempotency_key, and a repeat with the same key and arguments returns the stored result. ' +
  'idea_campaign_complete is final and requires _confirm: true.';
