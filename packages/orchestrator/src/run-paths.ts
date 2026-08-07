import * as path from 'node:path';

/** The canonical run root, relative to the project root. Every run the
 *  control plane creates by default lives here — it is one of the two
 *  stampable run roots, so a front-door run is visible to the traceability
 *  read model and receives its automatic launch stamp. */
export const RUNS_ROOT_RELATIVE = path.join('artifacts', 'runs');

/** The default on-disk directory for a run id. ONE definition: the writer
 *  (the run front door) and every reader (verification, final-conclusions,
 *  team summary, proposal genesis) must resolve a run's location through
 *  this function — a reader hardcoding its own default is how the
 *  run→verify→conclude lifecycle silently breaks apart. */
export function runDirFor(projectRoot: string, runId: string): string {
  return path.join(projectRoot, RUNS_ROOT_RELATIVE, runId);
}
