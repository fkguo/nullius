import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeComputationManifest } from '../src/computation/index.js';
import {
  cleanupRegisteredDirs,
  createManifest,
  createPythonStep,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
} from './executeManifestTestUtils.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

interface StatusFile {
  status: string;
  errors: string[];
  steps: Array<{
    id: string;
    status: string;
    skip_reason: string | null;
  }>;
}

function readStatus(runDir: string): StatusFile {
  return JSON.parse(
    fs.readFileSync(path.join(runDir, 'computation', 'execution_status.json'), 'utf-8'),
  ) as StatusFile;
}

function scaffoldThreeStepProject(onFailure?: 'fail-fast' | 'continue'): {
  projectRoot: string;
  runDir: string;
  runId: string;
  manifestPath: string;
} {
  const projectRoot = makeTmpDir();
  registerCleanup(projectRoot);
  const runId = 'run-failure-policy';
  const runDir = path.join(projectRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const manager = initRunState(projectRoot, runId);
  markA3Satisfied(manager, 'A3-0001');

  createPythonStep(runDir, 'scripts/a_fail.py', 'import sys\nsys.exit(3)\n');
  createPythonStep(
    runDir,
    'scripts/b_ok.py',
    "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/b.txt').write_text('b\\n', encoding='utf-8')\n",
  );
  createPythonStep(
    runDir,
    'scripts/c_child.py',
    "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/c.txt').write_text('c\\n', encoding='utf-8')\n",
  );

  const manifestPath = createManifest(runDir, {
    schema_version: 1,
    ...(onFailure ? { on_failure: onFailure } : {}),
    entry_point: { script: 'scripts/a_fail.py', tool: 'python' },
    steps: [
      { id: 'a_fail', tool: 'python', script: 'scripts/a_fail.py' },
      { id: 'b_ok', tool: 'python', script: 'scripts/b_ok.py', expected_outputs: ['outputs/b.txt'] },
      {
        id: 'c_child',
        tool: 'python',
        script: 'scripts/c_child.py',
        depends_on: ['a_fail'],
        expected_outputs: ['outputs/c.txt'],
      },
    ],
    environment: { python_version: '3.11', platform: 'any' },
    dependencies: {},
  });
  return { projectRoot, runDir, runId, manifestPath };
}

describe('computation manifest failure policy (on_failure)', () => {
  it('fail-fast (default) stops at the first failed step and leaves later steps pending', async () => {
    const { projectRoot, runDir, runId, manifestPath } = scaffoldThreeStepProject();

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('failed');

    const status = readStatus(runDir);
    expect(status.status).toBe('failed');
    expect(status.steps.find(step => step.id === 'a_fail')?.status).toBe('failed');
    expect(status.steps.find(step => step.id === 'b_ok')?.status).toBe('pending');
    expect(status.steps.find(step => step.id === 'c_child')?.status).toBe('pending');
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'b.txt'))).toBe(false);
  });

  it('continue keeps executing independent steps, skips dependents, and still ends failed', async () => {
    const { projectRoot, runDir, runId, manifestPath } = scaffoldThreeStepProject('continue');

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.errors.some(message => message.includes("step 'a_fail' exited with code 3"))).toBe(true);
    }

    const status = readStatus(runDir);
    expect(status.status).toBe('failed');
    expect(status.steps.find(step => step.id === 'a_fail')?.status).toBe('failed');
    expect(status.steps.find(step => step.id === 'b_ok')?.status).toBe('completed');
    const child = status.steps.find(step => step.id === 'c_child');
    expect(child?.status).toBe('skipped');
    expect(child?.skip_reason).toContain('a_fail');
    // The independent step's paid-for output survives the failed run.
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'c.txt'))).toBe(false);
    expect(status.errors.some(message => message.includes('on_failure=continue'))).toBe(true);
  });

  it('rejects unknown on_failure values at manifest validation', async () => {
    const { projectRoot, runDir, runId, manifestPath } = scaffoldThreeStepProject();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    manifest.on_failure = 'sometimes';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    await expect(
      executeComputationManifest({ manifestPath, projectRoot, runDir, runId }),
    ).rejects.toThrow(/computation_manifest_v1 validation/);
  });
});

describe('computation manifest step gates', () => {
  function scaffoldGatedProject(gates: string[]): {
    projectRoot: string;
    runDir: string;
    runId: string;
    manifestPath: string;
    manager: ReturnType<typeof initRunState>;
  } {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runId = 'run-gated';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const manager = initRunState(projectRoot, runId);

    createPythonStep(
      runDir,
      'scripts/gated.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/gated.txt').write_text('ran\\n', encoding='utf-8')\n",
    );
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/gated.py', tool: 'python' },
      steps: [
        {
          id: 'gated',
          tool: 'python',
          script: 'scripts/gated.py',
          expected_outputs: ['outputs/gated.txt'],
          gates,
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    return { projectRoot, runDir, runId, manifestPath, manager };
  }

  it('fails a step closed when a named gate is not satisfied, without executing it', async () => {
    const { projectRoot, runDir, runId, manifestPath } = scaffoldGatedProject(['A3']);

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(
        result.errors.some(message =>
          message.includes("step 'gated' requires unsatisfied approval gate(s): A3"),
        ),
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'gated.txt'))).toBe(false);
  });

  it('executes a gated step once the gate is recorded as satisfied', async () => {
    const { projectRoot, runDir, runId, manifestPath, manager } = scaffoldGatedProject(['A3']);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'gated.txt'))).toBe(true);
  });

  it('rejects unknown gate ids at preparation (an unknown gate can never be satisfied)', async () => {
    const { projectRoot, runDir, runId, manifestPath } = scaffoldGatedProject(['Z9']);

    await expect(
      executeComputationManifest({ manifestPath, projectRoot, runDir, runId }),
    ).rejects.toThrow(/unknown approval gate 'Z9'/);
  });

  it('rejects duplicate gate ids on one step', async () => {
    const { projectRoot, runDir, runId, manifestPath } = scaffoldGatedProject(['A3', 'A3']);

    await expect(
      executeComputationManifest({ manifestPath, projectRoot, runDir, runId }),
    ).rejects.toThrow(/more than once/);
  });
});
