import { randomUUID } from 'node:crypto';
import type { IntegrityReport } from '../src/model/integrity-report.js';
import type { ResearchEvent } from '../src/model/research-event.js';
import type { ResearchOutcome, ResearchOutcomeStatus } from '../src/model/research-outcome.js';
import type { ResearchStrategy } from '../src/model/research-strategy.js';
import { assignContentAddress, sha256Hex } from '../src/protocol/index.js';

export function createStrategy(): ResearchStrategy {
  const strategy: ResearchStrategy = {
    schema_version: 1,
    strategy_id: '',
    name: 'Bootstrap contour strategy',
    description: 'Agent-native strategy for bounded contour analysis.',
    objective: 'Derive a stable bounded result.',
    method: {
      approach: 'symbolic contour deformation',
      tools: ['Mathematica', 'Lean4'],
    },
    domain: 'hep-th',
    validation_criteria: [
      {
        name: 'cross_check',
        method: 'compare against an independent derivation',
        required: true,
      },
    ],
    preset: 'verify',
    tags: ['agent-native'],
  };

  return assignContentAddress(strategy, 'strategy_id');
}

export function createOutcome(
  strategy: ResearchStrategy,
  overrides: Partial<ResearchOutcome> = {},
): ResearchOutcome {
  const status = overrides.status ?? ('verified' satisfies ResearchOutcomeStatus);
  const outcome: ResearchOutcome = {
    schema_version: 1,
    outcome_id: '',
    lineage_id: overrides.lineage_id ?? randomUUID(),
    version: overrides.version ?? 1,
    strategy_ref: strategy.strategy_id,
    status,
    metrics: {
      mass_gap: {
        value: { central: 1.25 },
        uncertainty: 0.01,
        unit: 'GeV',
        method: 'resummed contour fit',
      },
    },
    artifacts: [
      {
        uri: 'rep://run-1/outcomes/mass-gap.json',
        kind: 'outcome',
        sha256: sha256Hex('artifact:mass-gap'),
        size_bytes: 128,
        produced_by: 'agent-alpha',
        created_at: '2026-03-24T00:00:00.000Z',
      },
    ],
    integrity_report_ref: overrides.integrity_report_ref,
    reproducibility_status: overrides.reproducibility_status ?? 'verified',
    rdi_scores:
      overrides.rdi_scores ??
      (status === 'verified'
        ? {
            gate_passed: true,
            novelty: 0.5,
            generality: 0.25,
            significance: 0.75,
            citation_impact: 1,
            rank_score: 0.6,
          }
        : undefined),
    produced_by: {
      agent_id: 'agent-alpha',
      run_id: 'run-1',
      tool_versions: { Mathematica: '14.0' },
    },
    created_at: overrides.created_at ?? '2026-03-24T00:00:00.000Z',
    supersedes: overrides.supersedes,
    superseded_by: overrides.superseded_by,
    tags: ['agent-native'],
  };

  return assignContentAddress(outcome, 'outcome_id');
}

export function createIntegrityReport(outcome: ResearchOutcome, status: IntegrityReport['overall_status'] = 'pass'): IntegrityReport {
  const report: IntegrityReport = {
    schema_version: 1,
    report_id: '',
    target_ref: {
      uri: `rep://run-1/outcomes/${outcome.outcome_id}.json`,
      kind: 'outcome',
      schema_version: 1,
      sha256: outcome.outcome_id,
      size_bytes: 256,
      produced_by: 'agent-beta',
      created_at: '2026-03-24T00:00:00.000Z',
    },
    checks: [
      {
        check_id: 'cross_check',
        check_name: 'Cross-check',
        status: status === 'fail' ? 'fail' : 'pass',
        severity: 'blocking',
        message: status === 'fail' ? 'Blocking mismatch detected.' : 'Cross-check succeeded.',
      },
    ],
    overall_status: status,
    blocking_failures: status === 'fail' ? ['cross_check'] : [],
    domain: 'hep-th',
    created_at: '2026-03-24T00:00:00.000Z',
  };

  return assignContentAddress(report, 'report_id');
}

export function createOutcomePublishedEvent(outcome: ResearchOutcome): ResearchEvent {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    event_type: 'outcome_published',
    timestamp: '2026-03-24T00:00:00.000Z',
    run_id: 'run-1',
    payload: {
      outcome_id: outcome.outcome_id,
      strategy_ref: outcome.strategy_ref,
      rdi_rank_score: 0.6,
    },
  };
}
