import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MutationProposalV1 } from '@autoresearch/shared';
import { invalidParams } from '@autoresearch/shared';
import type { RunState } from '../types.js';

function readRepairProposalPointer(state: RunState): string | null {
  const pointer = state.artifacts?.mutation_proposal_repair_v1;
  return typeof pointer === 'string' && pointer.length > 0 ? pointer : null;
}

function resolveRepairProposalPath(projectRoot: string, pointer: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, pointer);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidParams('repair mutation proposal pointer escapes project root.', {
      project_root: projectRoot,
      pointer,
    });
  }
  return resolved;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export function readRepairProposalView(projectRoot: string, state: RunState): {
  repair_mutation_proposal: Record<string, unknown> | null;
  repair_mutation_proposal_error: Record<string, unknown> | null;
} {
  const pointer = readRepairProposalPointer(state);
  if (!pointer || !state.run_id) {
    return { repair_mutation_proposal: null, repair_mutation_proposal_error: null };
  }
  try {
    const filePath = resolveRepairProposalPath(projectRoot, pointer);
    if (!fs.existsSync(filePath)) {
      return {
        repair_mutation_proposal: null,
        repair_mutation_proposal_error: {
          code: 'REPAIR_PROPOSAL_MISSING',
          message: `repair mutation proposal pointer exists but file is missing at ${pointer}.`,
        },
      };
    }
    const proposal = readJsonFile<MutationProposalV1>(filePath);
    return {
      repair_mutation_proposal: {
        artifact_path: pointer,
        proposal_id: proposal.proposal_id,
        mutation_type: proposal.mutation_type,
        gene_id: proposal.gene_id,
        gate_level: proposal.gate_level,
        status: proposal.status,
        run_id: proposal.run_id ?? state.run_id,
        signals: proposal.signals,
        blast_severity: proposal.blast_severity ?? null,
        created_at: proposal.created_at,
      },
      repair_mutation_proposal_error: null,
    };
  } catch (error) {
    return {
      repair_mutation_proposal: null,
      repair_mutation_proposal_error: {
        code: 'REPAIR_PROPOSAL_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
