import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createFromIdea } from '../../src/tools/create-from-idea.js';

function makeHandoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: '00000000-0000-0000-0000-000000000001',
    node_id: '00000000-0000-0000-0000-000000000002',
    idea_id: '00000000-0000-0000-0000-000000000003',
    promoted_at: '2026-01-01T00:00:00Z',
    idea_card: {
      thesis_statement: 'Anomalous magnetic moment of the muon receives significant contributions from light-by-light scattering at two loops.',
      testable_hypotheses: [
        'The two-loop LbL contribution shifts a_mu by O(10^-10)',
        'Pseudoscalar pole dominance accounts for >60% of the LbL contribution',
      ],
      required_observables: ['a_mu'],
      minimal_compute_plan: [
        { step: 'Evaluate two-loop diagrams', method: 'FeynCalc', estimated_difficulty: 'challenging' },
      ],
      claims: [
        {
          claim_text: 'LbL scattering is the dominant hadronic uncertainty in a_mu.',
          support_type: 'literature',
          evidence_uris: ['https://inspirehep.net/literature/12345'],
        },
        {
          claim_text: 'Pseudoscalar TFF dominates the LbL contribution.',
          support_type: 'calculation',
          evidence_uris: ['https://inspirehep.net/literature/67890'],
        },
      ],
    },
    grounding_audit: {
      status: 'pass',
      folklore_risk_score: 0.1,
      failures: [],
      timestamp: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

describe('createFromIdea (NEW-CONN-04)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-create-from-idea-'));
    process.env.HEP_DATA_DIR = tmpDir;
    // Ensure projects + runs dirs exist
    fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'runs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HEP_DATA_DIR;
  });

  it('creates project + run + outline_seed from file path handoff', () => {
    const handoffPath = path.join(tmpDir, 'handoff.json');
    fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()));

    const result = createFromIdea({ handoff_uri: handoffPath });

    expect(result.run_id).toBeTruthy();
    expect(result.project_id).toBeTruthy();
    expect(result.manifest_uri).toMatch(/^hep:\/\/runs\//);
    expect(result.outline_seed_uri).toMatch(/outline_seed_v1\.json/);

    // Verify outline_seed_v1.json was written
    const runDir = path.join(tmpDir, 'runs', result.run_id);
    const seedPath = path.join(runDir, 'artifacts', 'outline_seed_v1.json');
    expect(fs.existsSync(seedPath)).toBe(true);

    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed.thesis).toContain('Anomalous magnetic moment');
    expect(seed.claims).toHaveLength(2);
    expect(seed.hypotheses).toHaveLength(2);
    expect(seed.source_handoff_uri).toBe(handoffPath);
  });

  it('reuses existing project_id if provided', () => {
    // Create a project first
    const projectId = 'existing-proj';
    const projectDir = path.join(tmpDir, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        project_id: projectId,
        name: 'Existing Project',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );

    const handoffPath = path.join(tmpDir, 'handoff.json');
    fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()));

    const result = createFromIdea({ handoff_uri: handoffPath, project_id: projectId });

    expect(result.project_id).toBe(projectId);
  });

  it('auto-creates project with truncated thesis as name', () => {
    const longThesis = 'A'.repeat(200);
    const handoff = makeHandoff();
    (handoff.idea_card as Record<string, unknown>).thesis_statement = longThesis;

    const handoffPath = path.join(tmpDir, 'handoff.json');
    fs.writeFileSync(handoffPath, JSON.stringify(handoff));

    const result = createFromIdea({ handoff_uri: handoffPath });

    // Check that the project was created with truncated name
    const projectJsonPath = path.join(tmpDir, 'projects', result.project_id, 'project.json');
    const project = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    expect(project.name.length).toBeLessThanOrEqual(82); // 80 chars + ellipsis character
  });

  it('returns hint-only next_actions including the explicit compute bridge step', () => {
    const handoffPath = path.join(tmpDir, 'handoff.json');
    fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()));

    const result = createFromIdea({ handoff_uri: handoffPath });

    expect(result.next_actions).toHaveLength(3);
    const toolNames = result.next_actions.map(a => a.tool);
    expect(toolNames).toContain('hep_run_plan_computation');
    expect(toolNames).toContain('inspire_search');
    expect(toolNames).toContain('hep_project_build_evidence');

    // next_actions are hint-only: tool + reason, no args
    for (const action of result.next_actions) {
      expect(action).toHaveProperty('tool');
      expect(action).toHaveProperty('reason');
      expect(Object.keys(action)).toEqual(['tool', 'reason']);
    }
  });

  it('resolves hep:// URI handoff', () => {
    // Create a source run with the handoff as an artifact
    const sourceRunId = 'source-run-001';
    const sourceRunDir = path.join(tmpDir, 'runs', sourceRunId);
    fs.mkdirSync(path.join(sourceRunDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRunDir, 'manifest.json'),
      JSON.stringify({
        run_id: sourceRunId,
        project_id: 'source-proj',
        status: 'done',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        steps: [],
      }),
    );
    fs.writeFileSync(
      path.join(sourceRunDir, 'artifacts', 'idea_handoff_c2_v1.json'),
      JSON.stringify(makeHandoff()),
    );

    // Also need a project for the source run
    const projDir = path.join(tmpDir, 'projects', 'source-proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 'project.json'),
      JSON.stringify({
        project_id: 'source-proj',
        name: 'Source',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );

    const uri = `hep://runs/${sourceRunId}/artifact/idea_handoff_c2_v1.json`;
    const result = createFromIdea({ handoff_uri: uri });

    expect(result.run_id).toBeTruthy();
    expect(result.project_id).toBeTruthy();

    const runDir = path.join(tmpDir, 'runs', result.run_id);
    const seedPath = path.join(runDir, 'artifacts', 'outline_seed_v1.json');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed.source_handoff_uri).toBe(uri);
  });

  it('throws when handoff file does not exist (within HEP_DATA_DIR)', () => {
    const missingPath = path.join(tmpDir, 'nonexistent.json');
    expect(() =>
      createFromIdea({ handoff_uri: missingPath }),
    ).toThrow(/not found/i);
  });

  it('throws when file path is outside HEP_DATA_DIR', () => {
    expect(() =>
      createFromIdea({ handoff_uri: '/tmp/outside-data-dir.json' }),
    ).toThrow(/must be within/);
  });

  it('throws when idea_card is missing', () => {
    const handoffPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(handoffPath, JSON.stringify({ campaign_id: 'x' }));

    expect(() =>
      createFromIdea({ handoff_uri: handoffPath }),
    ).toThrow(/idea_card/i);
  });

  it('throws when claims are empty', () => {
    const handoff = makeHandoff();
    (handoff.idea_card as Record<string, unknown>).claims = [];
    const handoffPath = path.join(tmpDir, 'empty-claims.json');
    fs.writeFileSync(handoffPath, JSON.stringify(handoff));

    expect(() =>
      createFromIdea({ handoff_uri: handoffPath }),
    ).toThrow(/claims/i);
  });

  it('throws when testable_hypotheses contains non-string elements', () => {
    const handoff = makeHandoff();
    (handoff.idea_card as Record<string, unknown>).testable_hypotheses = ['valid', 42, null];
    const handoffPath = path.join(tmpDir, 'bad-hypotheses.json');
    fs.writeFileSync(handoffPath, JSON.stringify(handoff));

    expect(() =>
      createFromIdea({ handoff_uri: handoffPath }),
    ).toThrow(/testable_hypotheses\[1\].*string/i);
  });
});
