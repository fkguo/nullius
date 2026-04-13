import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadStagedIdeaSurfaceFromRunDir,
  parseIdeaHandoffRecord,
  readIdeaHandoffRecord,
  stageIdeaArtifactsIntoRun,
} from '../src/index.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function makeHandoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    idea_id: '33333333-3333-4333-8333-333333333333',
    promoted_at: '2026-03-13T00:00:00Z',
    idea_card: {
      thesis_statement: 'Canonical staged-idea parsing should stay generic and fail closed.',
      claims: [{ claim_text: 'Claim A', support_type: 'literature', evidence_uris: ['https://inspirehep.net/literature/1'] }],
      testable_hypotheses: ['Hypothesis A'],
      required_observables: ['observable_a'],
      candidate_formalisms: ['dispersion'],
      minimal_compute_plan: [
        {
          step: 'Derive a consistency relation',
          method: 'structured derivation',
          estimated_difficulty: 'moderate',
        },
      ],
      method_spec: {
        family: 'dispersion',
        target: 'HLbL',
      },
    },
    grounding_audit: {
      status: 'pass',
      folklore_risk_score: 0.1,
      failures: [],
      timestamp: '2026-03-13T00:00:00Z',
    },
    ...overrides,
  };
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('staged idea artifacts contract', () => {
  it('owns canonical IdeaHandoffC2 to outline/hints mapping, including provenance and method_spec', () => {
    const handoffUri = '/tmp/idea_handoff_c2_v1.json';
    const { outlineSeed, hintsSnapshot } = parseIdeaHandoffRecord({
      handoffRecord: makeHandoff(),
      handoffUri,
    });

    expect(outlineSeed).toMatchObject({
      thesis: 'Canonical staged-idea parsing should stay generic and fail closed.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: handoffUri,
    });
    expect(hintsSnapshot).toMatchObject({
      version: 1,
      source_handoff_uri: handoffUri,
      hints: {
        campaign_id: '11111111-1111-4111-8111-111111111111',
        node_id: '22222222-2222-4222-8222-222222222222',
        idea_id: '33333333-3333-4333-8333-333333333333',
        promoted_at: '2026-03-13T00:00:00Z',
        required_observables: ['observable_a'],
        candidate_formalisms: ['dispersion'],
        method_spec: {
          family: 'dispersion',
          target: 'HLbL',
        },
      },
    });
    expect(hintsSnapshot.hints?.minimal_compute_plan).toEqual([
      {
        step: 'Derive a consistency relation',
        method: 'structured derivation',
        estimated_difficulty: 'moderate',
      },
    ]);
  });

  it('validates generic IdeaHandoffC2 guardrails before any provider-local staging runs', () => {
    const cases: Array<{ label: string; handoffRecord: Record<string, unknown>; message: RegExp }> = [
      {
        label: 'missing campaign_id',
        handoffRecord: (() => {
          const handoff = makeHandoff();
          delete handoff.campaign_id;
          return handoff;
        })(),
        message: /missing campaign_id/i,
      },
      {
        label: 'non-uuid node_id',
        handoffRecord: makeHandoff({ node_id: 'not-a-uuid' }),
        message: /node_id.*uuid/i,
      },
      {
        label: 'non-iso promoted_at',
        handoffRecord: makeHandoff({ promoted_at: 'not-a-datetime' }),
        message: /promoted_at.*date-time/i,
      },
      {
        label: 'grounding audit fail',
        handoffRecord: makeHandoff({
          grounding_audit: {
            status: 'fail',
            folklore_risk_score: 0.9,
            failures: ['unsupported claim'],
            timestamp: '2026-03-13T00:00:00Z',
          },
        }),
        message: /grounding_audit\.status=pass/i,
      },
      {
        label: 'reduction audit missing',
        handoffRecord: makeHandoff({
          reduction_report: { abstract_problem: 'bridge_problem', strategy: 'problem_reduction' },
        }),
        message: /requires reduction_audit/i,
      },
      {
        label: 'missing idea_card',
        handoffRecord: (() => {
          const handoff = makeHandoff();
          delete handoff.idea_card;
          return handoff;
        })(),
        message: /missing idea_card/i,
      },
      {
        label: 'empty claims',
        handoffRecord: makeHandoff({
          idea_card: {
            ...(makeHandoff().idea_card as Record<string, unknown>),
            claims: [],
          },
        }),
        message: /claims/i,
      },
      {
        label: 'non-string hypothesis',
        handoffRecord: makeHandoff({
          idea_card: {
            ...(makeHandoff().idea_card as Record<string, unknown>),
            testable_hypotheses: ['valid', 42, null],
          },
        }),
        message: /testable_hypotheses\[1\].*string/i,
      },
    ];

    for (const testCase of cases) {
      expect(() => parseIdeaHandoffRecord({
        handoffRecord: testCase.handoffRecord,
        handoffUri: `/tmp/${testCase.label}.json`,
      })).toThrow(testCase.message);
    }
  });

  it('stages canonical artifacts and loads planning-visible hints from the snapshot without reparsing the source handoff', () => {
    const tmpDir = makeTmpDir('staged-idea-artifacts-');
    CLEANUP_DIRS.push(tmpDir);
    const runDir = path.join(tmpDir, 'run-001');
    const handoffPath = path.join(tmpDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    stageIdeaArtifactsIntoRun({
      handoffRecord: readIdeaHandoffRecord(handoffPath),
      handoffUri: handoffPath,
      runDir,
    });

    fs.rmSync(handoffPath, { force: true });

    const staged = loadStagedIdeaSurfaceFromRunDir(runDir);
    expect(staged.outline_seed_path).toBe('artifacts/outline_seed_v1.json');
    expect(staged.outline).toMatchObject({
      thesis: 'Canonical staged-idea parsing should stay generic and fail closed.',
      source_handoff_uri: handoffPath,
    });
    expect(staged.hints).toMatchObject({
      campaign_id: '11111111-1111-4111-8111-111111111111',
      method_spec: {
        family: 'dispersion',
        target: 'HLbL',
      },
    });
  });

  it('fails closed when the staged hints snapshot is missing instead of falling back to source handoff parsing', () => {
    const tmpDir = makeTmpDir('staged-idea-artifacts-');
    CLEANUP_DIRS.push(tmpDir);
    const runDir = path.join(tmpDir, 'run-002');
    const handoffPath = path.join(tmpDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    stageIdeaArtifactsIntoRun({
      handoffRecord: readIdeaHandoffRecord(handoffPath),
      handoffUri: handoffPath,
      runDir,
    });
    fs.rmSync(path.join(runDir, 'artifacts', 'idea_handoff_hints_v1.json'), { force: true });

    expect(() => loadStagedIdeaSurfaceFromRunDir(runDir)).toThrow(/idea_handoff_hints_v1\.json missing for run/i);
  });

  it('fails closed when staged hints provenance drifts from outline provenance', () => {
    const tmpDir = makeTmpDir('staged-idea-artifacts-');
    CLEANUP_DIRS.push(tmpDir);
    const runDir = path.join(tmpDir, 'run-003');
    const handoffPath = path.join(tmpDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    stageIdeaArtifactsIntoRun({
      handoffRecord: readIdeaHandoffRecord(handoffPath),
      handoffUri: handoffPath,
      runDir,
    });

    const hintsSnapshotPath = path.join(runDir, 'artifacts', 'idea_handoff_hints_v1.json');
    const hintsSnapshot = JSON.parse(fs.readFileSync(hintsSnapshotPath, 'utf-8')) as {
      source_handoff_uri: string;
    };
    hintsSnapshot.source_handoff_uri = 'hep://runs/other-run/artifact/other_handoff.json';
    writeJson(hintsSnapshotPath, hintsSnapshot);

    expect(() => loadStagedIdeaSurfaceFromRunDir(runDir)).toThrow(
      /source_handoff_uri does not match outline_seed_v1\.json provenance/i,
    );
  });
});
