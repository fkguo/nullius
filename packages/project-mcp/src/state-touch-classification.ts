import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Project reads also depend on the current anchor; mutation hints are not sufficient. */
export function isStateTouchingProjectMcp(root: string, name: string, args: Record<string, unknown>): boolean {
  // Discovery, response recovery and the canonical anchor refresh must remain available.
  if (['project_capabilities', 'project_delivery_read', 'orch_run_status'].includes(name)) return false;
  if (name === 'project_cli' && args.action === 'status') return false;
  // A delivery lock creates .nullius before the bootstrap worker starts. Only a
  // project with no state may initialize without an anchor; re-init can mutate it.
  if ((name === 'project_cli' && args.action === 'init') || name === 'orch_run_create') {
    return existsSync(join(root, '.nullius/state.json'));
  }
  return true;
}
