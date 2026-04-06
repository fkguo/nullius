import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  classifyPerturbation,
  runEvalSet,
  type EvalCase,
  type PerturbationClassification,
  type PerturbationExpectation,
  type PerturbationProbe,
} from '../../src/eval/index.js';
import { assertEvalSnapshot, readEvalSetFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

type ProtocolInput = {
  scenario: string;
  query: string;
};

type ProtocolExpected = {
  expectation: PerturbationExpectation;
  allowed_error_codes?: string[];
  required_next_action_tools?: string[];
};

type ProtocolActual = {
  classification: PerturbationClassification;
  canonical: PerturbationProbe;
  perturbed: PerturbationProbe;
};

type QueryFixture = {
  projectId: string;
  runId: string;
};

type ToolCallSpec = {
  tool: string;
  args: Record<string, unknown>;
};

function readResourceText(uri: string): string {
  const resource = readHepResource(uri);
  if (!('text' in resource)) {
    throw new Error(`Expected text resource: ${uri}`);
  }
  return resource.text;
}

function readTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find(item => item.type === 'text' && typeof item.text === 'string');
  return block?.text ?? '{}';
}

function normalizePreview(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeSuccessSignature(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];

  const directHits = (payload as { hits?: Array<Record<string, unknown>> }).hits;
  if (Array.isArray(directHits)) {
    return directHits
      .slice(0, 5)
      .map(hit => normalizePreview(hit.text_preview ?? hit.evidence_id))
      .filter(Boolean);
  }

  const artifactUri = Array.isArray((payload as { artifacts?: Array<{ uri?: string }> }).artifacts)
    ? (payload as { artifacts?: Array<{ uri?: string }> }).artifacts?.[0]?.uri
    : undefined;
  if (!artifactUri) return [];

  const artifact = JSON.parse(readResourceText(artifactUri)) as {
    fallback?: { reason?: string };
    result?: { hits?: Array<Record<string, unknown>> };
  };
  const hits = Array.isArray(artifact.result?.hits) ? artifact.result!.hits : [];
  const signature = hits
    .slice(0, 5)
    .map(hit => normalizePreview(hit.text_preview ?? hit.evidence_id))
    .filter(Boolean);
  if (artifact.fallback?.reason) {
    return [`fallback:${artifact.fallback.reason}`, ...signature];
  }
  return signature;
}

async function runProbe(spec: ToolCallSpec): Promise<PerturbationProbe> {
  const result = await handleToolCall(spec.tool, spec.args);
  const payload = JSON.parse(readTextBlock(result)) as {
    error?: { code?: string; data?: { next_actions?: Array<{ tool?: string }> } };
  };

  if (result.isError) {
    return {
      ok: false,
      error_code: payload.error?.code ?? null,
      next_action_tools: (payload.error?.data?.next_actions ?? [])
        .map(action => action.tool)
        .filter((tool): tool is string => typeof tool === 'string'),
    };
  }

  return {
    ok: true,
    success_signature: normalizeSuccessSignature(payload),
  };
}

async function buildFixture(): Promise<QueryFixture> {
  const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
  const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

  const projectRes = await handleToolCall('hep_project_create', {
    name: 'Protocol Perturbation Eval',
    description: 'eval-protocol-perturbation',
  });
  const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

  await handleToolCall('hep_project_build_evidence', {
    project_id: project.project_id,
    main_tex_path: mainTexPath,
    include_cross_refs: true,
  });

  const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
  const run = JSON.parse(runRes.content[0].text) as { run_id: string };

  const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
    run_id: run.run_id,
    latex_sources: [{ main_tex_path: mainTexPath, include_cross_refs: true, paper_id: 'paper_shared' }],
    max_evidence_items: 200,
    embedding_dim: 64,
  });
  expect(buildRes.isError).not.toBe(true);

  return {
    projectId: project.project_id,
    runId: run.run_id,
  };
}

function scenarioSpecs(fixture: QueryFixture, input: ProtocolInput): { canonical: ToolCallSpec; perturbed: ToolCallSpec } {
  const sharedLexicalArgs = {
    project_id: fixture.projectId,
    query: input.query,
    limit: 5,
    types: ['paragraph'],
  };
  const sharedSemanticArgs = {
    run_id: fixture.runId,
    project_id: fixture.projectId,
    query: input.query,
    limit: 3,
    types: ['paragraph'],
    include_explanation: true,
  };

  switch (input.scenario) {
    case 'lexical_default_vs_explicit_mode':
      return {
        canonical: { tool: 'hep_project_query_evidence', args: sharedLexicalArgs },
        perturbed: {
          tool: 'hep_project_query_evidence',
          args: { ...sharedLexicalArgs, mode: 'lexical', include_explanation: true },
        },
      };
    case 'lexical_budget_noise_falls_back':
      return {
        canonical: { tool: 'hep_project_query_evidence', args: sharedLexicalArgs },
        perturbed: {
          tool: 'hep_project_query_evidence',
          args: { ...sharedLexicalArgs, concurrency: -100, limit: '\r\t999' },
        },
      };
    case 'semantic_explicit_vs_implicit_mode':
      return {
        canonical: {
          tool: 'hep_project_query_evidence',
          args: { ...sharedSemanticArgs, mode: 'semantic' },
        },
        perturbed: {
          tool: 'hep_project_query_evidence',
          args: sharedSemanticArgs,
        },
      };
    case 'semantic_legacy_vs_unified':
      return {
        canonical: {
          tool: 'hep_project_query_evidence_semantic',
          args: sharedSemanticArgs,
        },
        perturbed: {
          tool: 'hep_project_query_evidence',
          args: { ...sharedSemanticArgs, mode: 'semantic' },
        },
      };
    case 'semantic_missing_run_id_unified_fail_closed':
      return {
        canonical: {
          tool: 'hep_project_query_evidence',
          args: { ...sharedSemanticArgs, mode: 'semantic' },
        },
        perturbed: {
          tool: 'hep_project_query_evidence',
          args: {
            project_id: fixture.projectId,
            query: input.query,
            limit: 3,
            types: ['paragraph'],
            mode: 'semantic',
          },
        },
      };
    case 'semantic_missing_run_id_legacy_fail_closed':
      return {
        canonical: {
          tool: 'hep_project_query_evidence_semantic',
          args: sharedSemanticArgs,
        },
        perturbed: {
          tool: 'hep_project_query_evidence_semantic',
          args: {
            project_id: fixture.projectId,
            query: input.query,
            limit: 3,
            types: ['paragraph'],
            include_explanation: true,
          },
        },
      };
    default:
      throw new Error(`Unknown protocol perturbation scenario: ${input.scenario}`);
  }
}

describe('eval: protocol perturbation harness for evidence query front-door surfaces', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-perturbation-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('distinguishes retained canonical success from acceptable fail-closed rejection', async () => {
    const evalSet = readEvalSetFixture('protocol_perturbation_evidence_query_eval.json');
    const fixture = await buildFixture();

    const report = await runEvalSet<ProtocolInput, ProtocolActual>(evalSet, {
      run: async (input, evalCase) => {
        const specs = scenarioSpecs(fixture, input);
        const canonical = await runProbe(specs.canonical);
        const perturbed = await runProbe(specs.perturbed);
        const expected = evalCase.expected as ProtocolExpected;
        const classified = classifyPerturbation({
          expectation: expected.expectation,
          canonical,
          perturbed,
          allowed_error_codes: expected.allowed_error_codes,
          required_next_action_tools: expected.required_next_action_tools,
        });
        return {
          classification: classified.classification,
          canonical,
          perturbed,
        };
      },
      judge: (expected, actual, evalCase: EvalCase) => {
        const exp = expected as ProtocolExpected;
        const classified = classifyPerturbation({
          expectation: exp.expectation,
          canonical: actual.canonical,
          perturbed: actual.perturbed,
          allowed_error_codes: exp.allowed_error_codes,
          required_next_action_tools: exp.required_next_action_tools,
        });
        return {
          passed: classified.passed,
          metrics: {
            canonical_success_retained: actual.classification === 'canonical_success_retained' ? 1 : 0,
            acceptable_fail_closed_rejection: actual.classification === 'acceptable_fail_closed_rejection' ? 1 : 0,
            overfit_failure: actual.classification === 'overfit_failure' ? 1 : 0,
            bad_shortcut_success: actual.classification === 'bad_shortcut_success' ? 1 : 0,
          },
        };
      },
      aggregate: results => ({
        canonical_success_retained: results.filter(
          result => result.actual?.classification === 'canonical_success_retained',
        ).length,
        acceptable_fail_closed_rejection: results.filter(
          result => result.actual?.classification === 'acceptable_fail_closed_rejection',
        ).length,
        overfit_failure: results.filter(
          result => result.actual?.classification === 'overfit_failure',
        ).length,
        bad_shortcut_success: results.filter(
          result => result.actual?.classification === 'bad_shortcut_success',
        ).length,
      }),
    });

    const simplified = {
      summary: {
        total: report.summary.total,
        passed: report.summary.passed,
        failed: report.summary.failed,
        passRate: report.summary.passRate,
        taskSuccessRate: report.summary.taskSuccessRate,
        partialProgressMean: report.summary.partialProgressMean,
      },
      aggregateMetrics: report.aggregateMetrics,
      caseResults: report.caseResults.map(result => ({
        caseId: result.caseId,
        passed: result.passed,
        classification: result.actual?.classification ?? null,
        canonical_ok: result.actual?.canonical.ok ?? null,
        perturbed_ok: result.actual?.perturbed.ok ?? null,
        perturbed_error_code: result.actual?.perturbed.error_code ?? null,
        next_action_tools: result.actual?.perturbed.next_action_tools ?? [],
      })),
    };
    assertEvalSnapshot('protocol_perturbation_evidence_query', simplified);

    expect(report.summary.total).toBe(6);
    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.canonical_success_retained).toBe(4);
    expect(report.aggregateMetrics.acceptable_fail_closed_rejection).toBe(2);
    expect(report.aggregateMetrics.overfit_failure).toBe(0);
    expect(report.aggregateMetrics.bad_shortcut_success).toBe(0);
  });

  it('does not treat a perturbed fail-closed rejection as acceptable when the canonical path already failed', () => {
    const classified = classifyPerturbation({
      expectation: 'fail_closed',
      canonical: {
        ok: false,
        error_code: 'INVALID_PARAMS',
        next_action_tools: ['hep_project_query_evidence'],
      },
      perturbed: {
        ok: false,
        error_code: 'INVALID_PARAMS',
        next_action_tools: ['hep_project_query_evidence'],
      },
      required_next_action_tools: ['hep_project_query_evidence'],
    });

    expect(classified).toEqual({
      classification: 'overfit_failure',
      passed: false,
    });
  });
});
