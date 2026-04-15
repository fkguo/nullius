import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MutationProposalV1 } from '@autoresearch/shared';
import { invalidParams } from '@autoresearch/shared';
import type { RunState } from '../types.js';
import { decisionOverlayForFingerprint, mutationProposalFingerprint } from '../proposal-decisions.js';

function readMutationProposalPointer(state: RunState, artifactKey: string): string | null {
  const pointer = state.artifacts?.[artifactKey];
  return typeof pointer === 'string' && pointer.length > 0 ? pointer : null;
}

function resolveMutationProposalPath(projectRoot: string, pointer: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, pointer);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidParams('mutation proposal pointer escapes project root.', {
      project_root: projectRoot,
      pointer,
    });
  }
  return resolved;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readMutationProposalView(params: {
  projectRoot: string;
  state: RunState;
  artifactKey: string;
  missingCode: string;
  invalidCode: string;
}): {
  proposal: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
} {
  const pointer = readMutationProposalPointer(params.state, params.artifactKey);
  if (!pointer || !params.state.run_id) {
    return { proposal: null, error: null };
  }
  try {
    const filePath = resolveMutationProposalPath(params.projectRoot, pointer);
    if (!fs.existsSync(filePath)) {
      return {
        proposal: null,
        error: {
          code: params.missingCode,
          message: `mutation proposal pointer exists but file is missing at ${pointer}.`,
        },
      };
    }
    const proposal = readJsonFile<MutationProposalV1>(filePath);
    const overlay = decisionOverlayForFingerprint({
      projectRoot: params.projectRoot,
      proposalKind: params.artifactKey === 'mutation_proposal_repair_v1'
        ? 'repair'
        : params.artifactKey === 'mutation_proposal_optimize_v1'
          ? 'optimize'
          : 'innovate',
      proposalFingerprint: mutationProposalFingerprint(proposal),
    });
    return {
      proposal: {
        artifact_path: pointer,
        proposal_id: proposal.proposal_id,
        mutation_type: proposal.mutation_type,
        gene_id: proposal.gene_id,
        gate_level: proposal.gate_level,
        status: proposal.status,
        run_id: proposal.run_id ?? params.state.run_id,
        signals: proposal.signals,
        blast_severity: proposal.blast_severity ?? null,
        created_at: proposal.created_at,
        decision: overlay.decision,
        decision_note: overlay.decision_note,
        decision_ts: overlay.decision_ts,
        duplicates_suppressed: overlay.duplicates_suppressed,
      },
      error: overlay.error,
    };
  } catch (error) {
    return {
      proposal: null,
      error: {
        code: params.invalidCode,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function readRepairProposalView(projectRoot: string, state: RunState): {
  repair_mutation_proposal: Record<string, unknown> | null;
  repair_mutation_proposal_error: Record<string, unknown> | null;
} {
  const view = readMutationProposalView({
    projectRoot,
    state,
    artifactKey: 'mutation_proposal_repair_v1',
    missingCode: 'REPAIR_PROPOSAL_MISSING',
    invalidCode: 'REPAIR_PROPOSAL_INVALID',
  });
  return {
    repair_mutation_proposal: view.proposal,
    repair_mutation_proposal_error: view.error,
  };
}

export function readOptimizeProposalView(projectRoot: string, state: RunState): {
  optimize_mutation_proposal: Record<string, unknown> | null;
  optimize_mutation_proposal_error: Record<string, unknown> | null;
} {
  const view = readMutationProposalView({
    projectRoot,
    state,
    artifactKey: 'mutation_proposal_optimize_v1',
    missingCode: 'OPTIMIZE_PROPOSAL_MISSING',
    invalidCode: 'OPTIMIZE_PROPOSAL_INVALID',
  });
  return {
    optimize_mutation_proposal: view.proposal,
    optimize_mutation_proposal_error: view.error,
  };
}

export function readInnovateProposalView(projectRoot: string, state: RunState): {
  innovate_mutation_proposal: Record<string, unknown> | null;
  innovate_mutation_proposal_error: Record<string, unknown> | null;
} {
  const view = readMutationProposalView({
    projectRoot,
    state,
    artifactKey: 'mutation_proposal_innovate_v1',
    missingCode: 'INNOVATE_PROPOSAL_MISSING',
    invalidCode: 'INNOVATE_PROPOSAL_INVALID',
  });
  return {
    innovate_mutation_proposal: view.proposal,
    innovate_mutation_proposal_error: view.error,
  };
}
