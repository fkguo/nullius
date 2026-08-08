import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { runCommand } from '../src/cli-run.js';
import { runDirFor } from '../src/run-paths.js';
import {
  cleanupRegisteredDirs,
  createManifest,
  createPythonStep,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
} from './executeManifestTestUtils.js';

/** The no-flag front door and every lifecycle reader must resolve a run's
 *  directory through ONE definition (runDirFor). The measured failure this
 *  locks out: the front door's default moved to artifacts/runs/ while
 *  verification, final-conclusions, team-summary, and proposal-genesis kept
 *  their own hardcoded <project_root>/<run_id> — so the default-path
 *  lifecycle broke at every step after `run`. */

afterEach(() => {
  cleanupRegisteredDirs();
});

const READERS = [
  'src/orch-tools/verification.ts',
  'src/orch-tools/final-conclusions.ts',
  'src/orch-tools/team-summary.ts',
  'src/computation/skill-proposal-genesis.ts',
  'src/computation/opportunity-proposal-genesis.ts',
  'src/cli-run.ts',
];

describe('run-dir lifecycle consistency', () => {
  it('every lifecycle surface resolves the run dir through runDirFor (no private defaults)', () => {
    const pkgRoot = path.resolve(__dirname, '..');
    for (const rel of READERS) {
      const source = fs.readFileSync(path.join(pkgRoot, rel), 'utf-8');
      expect(source, `${rel} must import the shared run-paths definition`).toMatch(/from '\.\.?\/(?:\.\.\/)?run-paths\.js'/);
      // The old private default: path.join(projectRoot, <runId-ish>) with no
      // runs-root in between. Any re-appearance is a reader striking out on
      // its own again.
      expect(source, `${rel} must not hardcode <project_root>/<run_id>`)
        .not.toMatch(/path\.join\((?:projectRoot|params\.projectRoot), (?:runId|params\.run_id)\)/);
    }
  });

  it('a no-flag front-door run lands where the lifecycle readers look', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    execFileSync('git', ['-C', projectRoot, 'init', '-q']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'T']);
    const runId = 'run-default-path';
    // Stage the computation where the DEFAULT resolution will look for it.
    const runDir = runDirFor(projectRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(
      runDir,
      'scripts/ok.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.json').write_text('{}', encoding='utf-8')\n",
    );
    createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/ok.py', tool: 'python' },
      steps: [{ id: 'ok', tool: 'python', script: 'scripts/ok.py', expected_outputs: ['outputs/ok.json'] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    execFileSync('git', ['-C', projectRoot, 'add', '-A']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-q', '-m', 'c']);

    const out: string[] = [];
    const code = await runCommand(
      {
        command: 'run',
        projectRoot,
        workflowId: 'computation',
        runId,
        runDir: null, // ← the default under test
        manifestPath: null,
        dryRun: false,
      },
      { cwd: projectRoot, stdout: (t: string) => out.push(t), stderr: () => {} },
    );

    expect(code).toBe(0);
    // The execution result sits exactly where runDirFor says — the same
    // resolution verification/final-conclusions/team-summary use.
    expect(fs.existsSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'))).toBe(true);
    const printed = JSON.parse(out.join('')) as { origin_stamp?: { status: string } };
    expect(printed.origin_stamp?.status).toBe('stamped');
  });
});
