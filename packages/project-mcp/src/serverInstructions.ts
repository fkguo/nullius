/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Gives a host access to one bound nullius research project: bounded file read and upload, the run tools of the orchestrator and typed nullius CLI actions. ' +
  'The project root comes from NULLIUS_PROJECT_ROOT and must lie outside the nullius checkout; file and path arguments are confined to it, but project scripts and checkers run by the computation and verification tools are trusted local code, not sandboxed. ' +
  'Background tools (stateful run tools and mutating CLI actions) take a stable delivery_id and return a delivery handle: poll project_delivery_read and reuse the same delivery_id after a disconnect. ' +
  'project_file_write runs at once, guarded by expected_sha256; the two sampling tools run while the client stays connected and have no delivery_id. Approvals stay with the local host.';
