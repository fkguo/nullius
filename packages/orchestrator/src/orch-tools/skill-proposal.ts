import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunState } from '../types.js';
import type { SkillProposalV2 } from '@autoresearch/shared';
import { invalidParams } from '@autoresearch/shared';

function readSkillProposalPointer(state: RunState): string | null {
  const pointer = state.artifacts?.skill_proposal_v2;
  return typeof pointer === 'string' && pointer.length > 0 ? pointer : null;
}

function resolveSkillProposalPath(projectRoot: string, pointer: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, pointer);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidParams('skill proposal pointer escapes project root.', {
      project_root: projectRoot,
      pointer,
    });
  }
  return resolved;
}

export function readSkillProposalView(projectRoot: string, state: RunState): {
  skill_proposal: Record<string, unknown> | null;
  skill_proposal_error: Record<string, unknown> | null;
} {
  const pointer = readSkillProposalPointer(state);
  if (!pointer || !state.run_id) {
    return { skill_proposal: null, skill_proposal_error: null };
  }
  try {
    const filePath = resolveSkillProposalPath(projectRoot, pointer);
    if (!fs.existsSync(filePath)) {
      return {
        skill_proposal: null,
        skill_proposal_error: {
          code: 'SKILL_PROPOSAL_MISSING',
          message: `skill proposal pointer exists but file is missing at ${pointer}.`,
        },
      };
    }
    const proposal = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SkillProposalV2;
    return {
      skill_proposal: {
        artifact_path: pointer,
        proposal_id: proposal.proposal_id,
        proposal_type: proposal.proposal_type,
        origin: proposal.origin,
        name: proposal.name,
        gate_level: proposal.gate_level,
        status: proposal.status,
        trigger: proposal.trigger,
        action: proposal.action,
        created_at: proposal.created_at,
      },
      skill_proposal_error: null,
    };
  } catch (error) {
    return {
      skill_proposal: null,
      skill_proposal_error: {
        code: 'SKILL_PROPOSAL_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
