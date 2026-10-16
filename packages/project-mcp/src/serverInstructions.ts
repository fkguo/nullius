/** Server-level usage guidance sent to hosts in the MCP initialize result. */
export const SERVER_INSTRUCTIONS =
  'Gives a host access to one bound nullius research project: bounded file read/upload, the run tools of the orchestrator and typed nullius CLI actions. ' +
  'The project root comes from NULLIUS_PROJECT_ROOT and must lie outside the nullius checkout; tools never reach outside it. ' +
  'Mutating calls take a stable delivery_id and return a delivery handle: poll project_delivery_read and reuse the same delivery_id after a disconnect, never a new one for the same request. ' +
  'Local code execution is trusted, not OS-sandboxed; approvals stay with the local host.';
