import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createFromIdea } from '../../src/tools/create-from-idea.js';
import { getRun } from '../../src/core/runs.js';

function makeHandoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    idea_id: '33333333-3333-4333-8333-333333333333',
    promoted_at: '2026-01-01T00:00:00Z',
    idea_card: {
      thesis_statement: 'Dispersive constraints can tighten hadronic light-by-light uncertainty in muon g-2.',
      testable_hypotheses: [
        'Dispersion-improved inputs reduce model spread in a_mu^{HLbL}',
      ],
      claims: [
        {
          claim_text: 'Data-driven constraints can reduce dominant hadronic uncertainties.',
          support_type: 'literature',
          evidence_uris: ['https://inspirehep.net/literature/12345'],
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

describe('idea-runs integration contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-idea-runs-contract-'));
    process.env.HEP_DATA_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'runs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HEP_DATA_DIR;
    delete process.env.IDEA_MCP_DATA_DIR;
  });

  it('enforces artifact naming and path contract for created run', () => {
    const handoffPath = path.join(tmpDir, 'idea_handoff_c2_v1.json');
    fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()), 'utf-8');

    const result = createFromIdea({ handoff_uri: handoffPath });

    const runDir = path.join(tmpDir, 'runs', result.run_id);
    const artifactsDir = path.join(runDir, 'artifacts');
    const argsSnapshotPath = path.join(artifactsDir, 'args_snapshot.json');
    const outlineSeedPath = path.join(artifactsDir, 'outline_seed_v1.json');

    expect(result.run_dir).toBe(runDir);
    expect(fs.existsSync(argsSnapshotPath)).toBe(true);
    expect(fs.existsSync(outlineSeedPath)).toBe(true);
    expect(result.manifest_uri).toBe(`hep://runs/${encodeURIComponent(result.run_id)}/manifest`);
    expect(result.outline_seed_uri).toBe(
      `hep://runs/${encodeURIComponent(result.run_id)}/artifact/outline_seed_v1.json`,
    );
  });

  it('keeps key cross references consistent across result, manifest, args snapshot, and outline seed', () => {
    const handoffPath = path.join(tmpDir, 'handoff-xref.json');
    fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()), 'utf-8');

    const result = createFromIdea({ handoff_uri: handoffPath, run_label: 'xref-check' });
    const manifest = getRun(result.run_id);

    const argsSnapshotPath = path.join(tmpDir, 'runs', result.run_id, 'artifacts', 'args_snapshot.json');
    const argsSnapshot = JSON.parse(fs.readFileSync(argsSnapshotPath, 'utf-8')) as {
      run_id: string;
      project_id: string;
      args_snapshot: {
        source: string;
        handoff_uri: string;
        run_label?: string;
      };
    };

    const outlineSeedPath = path.join(tmpDir, 'runs', result.run_id, 'artifacts', 'outline_seed_v1.json');
    const outlineSeed = JSON.parse(fs.readFileSync(outlineSeedPath, 'utf-8')) as {
      source_handoff_uri: string;
    };

    expect(manifest.run_id).toBe(result.run_id);
    expect(result.manifest_uri).toContain(encodeURIComponent(result.run_id));
    expect(result.outline_seed_uri).toContain(encodeURIComponent(result.run_id));

    expect(argsSnapshot.run_id).toBe(result.run_id);
    expect(argsSnapshot.project_id).toBe(result.project_id);
    expect(argsSnapshot.args_snapshot.source).toBe('create_from_idea');
    expect(argsSnapshot.args_snapshot.handoff_uri).toBe(handoffPath);
    expect(argsSnapshot.args_snapshot.run_label).toBe('xref-check');

    expect(outlineSeed.source_handoff_uri).toBe(handoffPath);
  });

  it('accepts file:// handoff refs inside IDEA_MCP_DATA_DIR and preserves provenance', () => {
    const ideaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-handoff-contract-'));
    try {
      process.env.IDEA_MCP_DATA_DIR = ideaDir;
      const handoffPath = path.join(ideaDir, 'handoff-file-uri.json');
      fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()), 'utf-8');

      const handoffUri = pathToFileURL(handoffPath).href;
      const result = createFromIdea({ handoff_uri: handoffUri });
      const outlineSeedPath = path.join(tmpDir, 'runs', result.run_id, 'artifacts', 'outline_seed_v1.json');
      const outlineSeed = JSON.parse(fs.readFileSync(outlineSeedPath, 'utf-8')) as {
        source_handoff_uri: string;
      };

      expect(outlineSeed.source_handoff_uri).toBe(handoffUri);
    } finally {
      fs.rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('fails closed when file:// handoff refs are used without IDEA_MCP_DATA_DIR', () => {
    const ideaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-handoff-contract-'));
    try {
      const handoffPath = path.join(ideaDir, 'handoff-file-uri.json');
      fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()), 'utf-8');

      expect(() => createFromIdea({ handoff_uri: pathToFileURL(handoffPath).href })).toThrow(
        'file:// handoff_uri requires IDEA_MCP_DATA_DIR to be set',
      );
    } finally {
      fs.rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('fails closed when file:// handoff refs point outside IDEA_MCP_DATA_DIR', () => {
    const ideaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-handoff-contract-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-handoff-outside-'));
    try {
      process.env.IDEA_MCP_DATA_DIR = ideaDir;
      const handoffPath = path.join(outsideDir, 'handoff-file-uri.json');
      fs.writeFileSync(handoffPath, JSON.stringify(makeHandoff()), 'utf-8');

      expect(() => createFromIdea({ handoff_uri: pathToFileURL(handoffPath).href })).toThrow(
        'handoff_uri must be within',
      );
    } finally {
      fs.rmSync(ideaDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
