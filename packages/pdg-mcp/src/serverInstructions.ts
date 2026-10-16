/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Looks up Particle Data Group particle properties, decays, measurements and references in a local PDG SQLite file; no network access. ' +
  'PDG_DB_PATH must be the absolute path of that file. Particles are selected by name, Monte Carlo id (MCID) or PDG identifier (e.g. S008, S009T). ' +
  'Artifact tools write result files under PDG_DATA_DIR (else HEP_DATA_DIR/pdg) and return pdg:// URIs; artifacts older than PDG_ARTIFACT_TTL_HOURS (default 24) are removed. ' +
  'PDG_TOOL_MODE=full lists every tool.';
