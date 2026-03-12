import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeComputationManifest } from '../src/computation/index.js';
import {
  cleanupRegisteredDirs,
  createManifest,
  createPythonStep,
  extractArtifactPaths,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
} from './executeManifestTestUtils.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

describe('executeComputationManifest', () => {
  it('supports dry_run validation without executing any step', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runDir = path.join(projectRoot, 'run-dry');
    fs.mkdirSync(runDir, { recursive: true });

    createPythonStep(
      runDir,
      'scripts/write_result.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/result.txt').write_text('ran\\n', encoding='utf-8')\n",
    );

    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/write_result.py', tool: 'python' },
      steps: [
        {
          id: 'write_result',
          tool: 'python',
          script: 'scripts/write_result.py',
          expected_outputs: ['outputs/result.txt'],
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });

    const result = await executeComputationManifest({
      dryRun: true,
      manifestPath,
      projectRoot,
      runDir,
      runId: 'run-dry',
    });

    expect(result.status).toBe('dry_run');
    expect(result.validated).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'result.txt'))).toBe(false);
  });

  it('executes successfully when A3 is already satisfied and persists stable status artifacts', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runId = 'run-success';
    const runDir = path.join(projectRoot, 'run-success');
    fs.mkdirSync(runDir, { recursive: true });

    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    createPythonStep(
      runDir,
      'scripts/write_ok.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.json').write_text('{\"ok\": true}\\n', encoding='utf-8')\n",
    );

    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/write_ok.py', tool: 'python' },
      steps: [
        {
          id: 'write_ok',
          tool: 'python',
          script: 'scripts/write_ok.py',
          expected_outputs: ['outputs/ok.json'],
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'ok.json'))).toBe(true);

    expect(extractArtifactPaths(result)?.execution_status).toBeTruthy();
    const state = manager.readState();
    expect(state.run_status).toBe('completed');
  });

  it('rejects manifests whose scripts escape the run directory', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runDir = path.join(projectRoot, 'run-unsafe');
    fs.mkdirSync(runDir, { recursive: true });

    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: '../outside.py', tool: 'python' },
      steps: [
        {
          id: 'unsafe_step',
          tool: 'python',
          script: '../outside.py',
          expected_outputs: ['outputs/nope.txt'],
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });

    await expect(
      executeComputationManifest({
        manifestPath,
        projectRoot,
        runDir,
        runId: 'run-unsafe',
      }),
    ).rejects.toThrow(/manifest|script|within/i);
  });

  it('rejects blocked commands before any step executes', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runDir = path.join(projectRoot, 'run-blocked');
    fs.mkdirSync(runDir, { recursive: true });

    createPythonStep(
      runDir,
      'scripts/write_if_called.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/blocked.txt').write_text('should-not-run\\n', encoding='utf-8')\n",
    );

    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/write_if_called.py', tool: 'bash', args: ['chmod', '777'] },
      steps: [
        {
          id: 'blocked_step',
          tool: 'bash',
          script: 'scripts/write_if_called.py',
          args: ['chmod', '777'],
          expected_outputs: ['outputs/blocked.txt'],
        },
      ],
      environment: { platform: 'any' },
      dependencies: {},
    });

    await expect(
      executeComputationManifest({
        manifestPath,
        projectRoot,
        runDir,
        runId: 'run-blocked',
      }),
    ).rejects.toThrow(/blocked command/i);

    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'blocked.txt'))).toBe(false);
  });

  it('creates an A3 approval packet and performs no partial execution before approval', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runId = 'run-needs-approval';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const manager = initRunState(projectRoot, runId);

    createPythonStep(
      runDir,
      'scripts/write_later.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/result.txt').write_text('approved\\n', encoding='utf-8')\n",
    );

    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/write_later.py', tool: 'python' },
      steps: [
        {
          id: 'write_later',
          tool: 'python',
          script: 'scripts/write_later.py',
          expected_outputs: ['outputs/result.txt'],
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
      computation_budget: { max_runtime_minutes: 5 },
    });

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('requires_approval');
    expect(result.requires_approval).toBe(true);
    expect(result.approval_id).toBe('A3-0001');
    expect(fs.existsSync(path.join(projectRoot, result.packet_path))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'result.txt'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'computation', 'execution_status.json'))).toBe(false);

    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval?.approval_id).toBe('A3-0001');
  });
});
