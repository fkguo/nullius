import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => {
    throw new Error('spawnSync must not be called by compute bridge pre-approval paths');
  }),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { bridgeStagedIdeaToComputation } from '../src/computation/bridge.js';
import {
  cleanupRegisteredDirs,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
  writeJson,
} from './executeManifestTestUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const executionPlanSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../meta/schemas/execution_plan_v1.schema.json'), 'utf-8'),
) as Record<string, unknown>;

function stagedIdeaSurface() {
  return {
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: 'Bridge staged hypotheses into a provider-neutral execution plan before any compute approval.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A', 'Hypothesis B'],
      source_handoff_uri: 'hep://runs/source-run/artifact/idea_handoff_c2_v1.json',
    },
    hints: {
      campaign_id: '00000000-0000-0000-0000-000000000001',
      node_id: '00000000-0000-0000-0000-000000000002',
      idea_id: '00000000-0000-0000-0000-000000000003',
      promoted_at: '2026-03-13T00:00:00Z',
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Assemble consistency equations', method: 'structured derivation', estimated_difficulty: 'moderate' },
      ],
    },
  };
}

afterEach(() => {
  spawnSyncMock.mockClear();
  cleanupRegisteredDirs();
});

describe('compute bridge', () => {
  it('compiles staged idea input into execution_plan_v1 and returns dry_run without spawning a process', async () => {
    const projectRoot = makeTmpDir();
    const runDir = path.join(projectRoot, 'run-bridge-dry');
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    writeJson(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), stagedIdeaSurface().outline);

    const result = await bridgeStagedIdeaToComputation({
      dryRun: true,
      projectRoot,
      runDir,
      runId: 'run-bridge-dry',
      stagedIdea: stagedIdeaSurface(),
    });

    expect(result.status).toBe('dry_run');
    expect(result.execution_plan_path).toBe('computation/execution_plan_v1.json');
    expect(result.manifest_path).toBe('computation/manifest.json');
    expect(spawnSyncMock).not.toHaveBeenCalled();

    const planPath = path.join(runDir, result.execution_plan_path);
    const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(executionPlanSchema);
    const executionPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    expect(validate(executionPlan), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect((executionPlan.tasks as Array<Record<string, unknown>>)[0]?.capabilities).toContain('observable_estimation');
  });

  it('stops at requires_approval with an enriched A3 packet and still performs zero execution', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-approval';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    writeJson(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), stagedIdeaSurface().outline);
    initRunState(projectRoot, runId);

    const result = await bridgeStagedIdeaToComputation({
      dryRun: false,
      projectRoot,
      runDir,
      runId,
      stagedIdea: stagedIdeaSurface(),
    });

    expect(result.status).toBe('requires_approval');
    expect(result.gate_id).toBe('A3');
    expect(spawnSyncMock).not.toHaveBeenCalled();

    const packetPath = path.join(projectRoot, result.packet_json_path);
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf-8')) as { details_md: string; risks: string[] };
    expect(packet.details_md).toContain('Bridge objective');
    expect(packet.details_md).toContain('Required observables: observable_a');
    expect(packet.risks.some(risk => risk.includes('Bridge-generated stubs'))).toBe(true);
  });

  it('fails closed when A3 is already satisfied and still never executes via the bridge surface', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-approved';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    writeJson(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), stagedIdeaSurface().outline);
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    await expect(() =>
      bridgeStagedIdeaToComputation({
        dryRun: false,
        projectRoot,
        runDir,
        runId,
        stagedIdea: stagedIdeaSurface(),
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({
        validation_layer: 'approval_boundary',
        gate_id: 'A3',
        manifest_path: 'computation/manifest.json',
      }),
    });
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals'))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('fails closed on invalid staged input and never creates an approval request', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-invalid';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(runDir, { recursive: true });
    initRunState(projectRoot, runId);

    await expect(() =>
      bridgeStagedIdeaToComputation({
        dryRun: false,
        projectRoot,
        runDir,
        runId,
        stagedIdea: {
          outline_seed_path: 'artifacts/outline_seed_v1.json',
          outline: { thesis: '', claims: [], hypotheses: [], source_handoff_uri: '' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({ validation_layer: 'staged_input' }),
    });
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals'))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
