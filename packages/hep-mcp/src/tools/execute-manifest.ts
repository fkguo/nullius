import * as path from 'path';
import { z } from 'zod';
import { executeComputationManifest } from '@autoresearch/orchestrator';
import { getRun } from '../core/runs.js';
import { getRunDir } from '../core/paths.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';

export const HepRunExecuteManifestToolSchema = z.object({
  _confirm: z.boolean().optional().describe('Must be true to execute this destructive operation.'),
  project_root: z.string().min(1).describe('Absolute path to the orchestrator project root that owns .autoresearch/.'),
  run_id: z.string().min(1).describe('Run identifier created by hep_run_create.'),
  manifest_path: z.string().min(1).describe('Path to computation manifest, relative to run_dir or absolute within run_dir/computation/.'),
  dry_run: z.boolean().optional().default(false).describe('Validate the manifest without requesting approval or executing any step.'),
});

export type HepRunExecuteManifestParams = z.output<typeof HepRunExecuteManifestToolSchema>;

export async function executeManifest(
  params: HepRunExecuteManifestParams,
) {
  getRun(params.run_id);
  const runDir = getRunDir(params.run_id);
  const manifestPath = resolvePathWithinParent(runDir, params.manifest_path, 'manifest_path');
  resolvePathWithinParent(path.join(runDir, 'computation'), manifestPath, 'manifest_path');
  return executeComputationManifest({
    dryRun: params.dry_run,
    manifestPath,
    projectRoot: params.project_root,
    runDir,
    runId: params.run_id,
  });
}
