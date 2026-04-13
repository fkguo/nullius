import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall as handleOrchToolCall } from '@autoresearch/orchestrator';
import { createFromIdea } from '../../src/tools/create-from-idea.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function makeHandoff(): Record<string, unknown> {
  return {
    campaign_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    idea_id: '33333333-3333-4333-8333-333333333333',
    promoted_at: '2026-03-13T00:00:00Z',
    idea_card: {
      thesis_statement: 'Compile staged idea surfaces into an audited execution plan before any compute approval.',
      testable_hypotheses: ['Hypothesis A'],
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Derive a consistency relation', method: 'structured derivation', estimated_difficulty: 'moderate' },
      ],
      claims: [{ claim_text: 'Claim A', support_type: 'literature', evidence_uris: ['https://inspirehep.net/literature/1'] }],
    },
    grounding_audit: {
      status: 'pass',
      folklore_risk_score: 0.1,
      failures: [],
      timestamp: '2026-03-13T00:00:00Z',
    },
  };
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  delete process.env.HEP_DATA_DIR;
  delete process.env.IDEA_MCP_DATA_DIR;
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('compute bridge contract', () => {
  it('surfaces orch_run_plan_computation as the explicit next step after create_from_idea and returns dry_run artifacts', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    const staged = createFromIdea({ handoff_uri: handoffPath });
    expect(staged.next_actions.map(action => action.tool)).toContain('orch_run_plan_computation');

    const result = await handleOrchToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: staged.run_dir,
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('dry_run');
    expect(payload.execution_plan_path).toBe('computation/execution_plan_v1.json');
    expect(payload.manifest_path).toBe('computation/manifest.json');
    expect(payload.task_ids).toEqual(['task_001']);
  });

  it('returns requires_approval with an A3 packet enriched from execution_plan_v1', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    const staged = createFromIdea({ handoff_uri: handoffPath });
    extractPayload(await handleOrchToolCall(
      'orch_run_create',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        workflow_id: 'computation',
      },
      'full',
    ));

    const result = await handleOrchToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: staged.run_dir,
        dry_run: false,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('requires_approval');
    expect(payload.gate_id).toBe('A3');

    const manifestPath = path.join(hepDataDir, 'runs', staged.run_id, String(payload.manifest_path));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      entry_point: { script: string };
      description: string;
    };
    expect(manifest.entry_point.script).toBe('scripts/hep_provider_runner.py');
    expect(manifest.description).toContain('Provider-backed execution materialized from staged method_spec.run_card');

    const packetJsonPath = path.join(projectRoot, String(payload.packet_json_path));
    const packet = JSON.parse(fs.readFileSync(packetJsonPath, 'utf-8')) as { details_md: string };
    expect(packet.details_md).toContain('Bridge objective');
    expect(packet.details_md).toContain('Execution plan tasks:');
  });

  it('accepts file:// idea handoff refs inside IDEA_MCP_DATA_DIR for computation planning', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const ideaDataDir = makeTmpDir('idea-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, ideaDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    process.env.IDEA_MCP_DATA_DIR = ideaDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(ideaDataDir, 'campaigns', 'handoff-file-uri.json');
    writeJson(handoffPath, makeHandoff());

    const staged = createFromIdea({ handoff_uri: pathToFileURL(handoffPath).href });
    const result = await handleOrchToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: staged.run_dir,
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('dry_run');
    expect(payload.task_ids).toEqual(['task_001']);
  });

  it('keeps staged computation hints usable after the original handoff file is removed', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    const staged = createFromIdea({ handoff_uri: handoffPath });
    fs.rmSync(handoffPath, { force: true });

    const result = await handleOrchToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: staged.run_dir,
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('dry_run');
    expect(payload.task_ids).toEqual(['task_001']);
  });

  it('fails closed when staged hints snapshot provenance drifts from outline seed provenance', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());
    const staged = createFromIdea({ handoff_uri: handoffPath });

    const hintsSnapshotPath = path.join(hepDataDir, 'runs', staged.run_id, 'artifacts', 'idea_handoff_hints_v1.json');
    const snapshot = JSON.parse(fs.readFileSync(hintsSnapshotPath, 'utf-8')) as { source_handoff_uri: string };
    snapshot.source_handoff_uri = 'hep://runs/other-run/artifact/other_handoff.json';
    writeJson(hintsSnapshotPath, snapshot);

    const result = await handleOrchToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: staged.run_dir,
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.error?.message ?? payload.message ?? JSON.stringify(payload)).toContain(
      'source_handoff_uri does not match outline_seed_v1.json provenance',
    );
  });
});
