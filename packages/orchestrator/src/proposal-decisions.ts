import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MutationProposalV1, SkillProposalV2 } from '@autoresearch/shared';
import { invalidParams, normalizeSignals } from '@autoresearch/shared';
import { writeJsonAtomic } from './computation/io.js';
import type { RunState } from './types.js';

export type ProposalKind = 'repair' | 'skill' | 'optimize' | 'innovate';
export type ProposalDecision = 'accepted_for_later' | 'dismissed' | 'already_captured';

type ProposalDecisionRecord = {
  proposal_kind: ProposalKind;
  proposal_id: string;
  proposal_fingerprint: string;
  decision: ProposalDecision;
  decided_at: string;
  note: string | null;
  suppress_duplicates: boolean;
};

type ProposalDecisionStore = {
  schema_version: 1;
  decisions: ProposalDecisionRecord[];
};

function storePath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch', 'proposal_decisions_v1.json');
}

function defaultStore(): ProposalDecisionStore {
  return {
    schema_version: 1,
    decisions: [],
  };
}

function hashFingerprint(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function mutationProposalFingerprint(proposal: MutationProposalV1): string {
  return hashFingerprint([
    proposal.mutation_type,
    proposal.gene_id,
    ...normalizeSignals(proposal.signals),
  ]);
}

export function skillProposalFingerprint(proposal: SkillProposalV2): string {
  return hashFingerprint([
    proposal.proposal_type,
    proposal.trigger.pattern_kind ?? '',
    proposal.trigger.workflow_signature ?? '',
    proposal.trigger.signal_pattern ?? '',
    proposal.name,
  ]);
}

export function loadProposalDecisionStore(projectRoot: string): {
  store: ProposalDecisionStore;
  error: Record<string, unknown> | null;
} {
  const filePath = storePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return {
      store: defaultStore(),
      error: {
        code: 'PROPOSAL_DECISION_STORE_MISSING',
        message: `proposal decision store is missing at ${path.relative(projectRoot, filePath).split(path.sep).join('/')}.`,
      },
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProposalDecisionStore;
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.decisions)) {
      throw new Error('proposal decision store has invalid structure');
    }
    return {
      store: parsed,
      error: null,
    };
  } catch (error) {
    return {
      store: defaultStore(),
      error: {
        code: 'PROPOSAL_DECISION_STORE_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function saveProposalDecisionStore(projectRoot: string, store: ProposalDecisionStore): void {
  writeJsonAtomic(storePath(projectRoot), store);
}

export function ensureProposalDecisionStore(projectRoot: string): void {
  const filePath = storePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    saveProposalDecisionStore(projectRoot, defaultStore());
  }
}

function latestDecision(
  store: ProposalDecisionStore,
  proposalKind: ProposalKind,
  proposalFingerprint: string,
): ProposalDecisionRecord | null {
  const matches = store.decisions.filter(
    (item) => item.proposal_kind === proposalKind && item.proposal_fingerprint === proposalFingerprint,
  );
  return matches.length > 0 ? matches[matches.length - 1] ?? null : null;
}

export function decisionOverlayForFingerprint(params: {
  projectRoot: string;
  proposalKind: ProposalKind;
  proposalFingerprint: string;
}): {
  decision: ProposalDecision | null;
  decision_note: string | null;
  decision_ts: string | null;
  duplicates_suppressed: boolean;
  error: Record<string, unknown> | null;
} {
  const { store, error } = loadProposalDecisionStore(params.projectRoot);
  const decision = latestDecision(store, params.proposalKind, params.proposalFingerprint);
  return {
    decision: decision?.decision ?? null,
    decision_note: decision?.note ?? null,
    decision_ts: decision?.decided_at ?? null,
    duplicates_suppressed: decision?.suppress_duplicates ?? false,
    error,
  };
}

export function shouldSuppressProposal(params: {
  projectRoot: string;
  proposalKind: ProposalKind;
  proposalFingerprint: string;
}): {
  suppressed: boolean;
  decision: ProposalDecisionRecord | null;
} {
  ensureProposalDecisionStore(params.projectRoot);
  const { store } = loadProposalDecisionStore(params.projectRoot);
  const decision = latestDecision(store, params.proposalKind, params.proposalFingerprint);
  return {
    suppressed: Boolean(decision?.suppress_duplicates),
    decision,
  };
}

function proposalArtifactKey(kind: ProposalKind): string {
  switch (kind) {
    case 'repair':
      return 'mutation_proposal_repair_v1';
    case 'skill':
      return 'skill_proposal_v2';
    case 'optimize':
      return 'mutation_proposal_optimize_v1';
    case 'innovate':
      return 'mutation_proposal_innovate_v1';
  }
}

type CurrentProposalDescriptor = {
  proposalId: string;
  proposalFingerprint: string;
  proposalPath: string;
};

function readCurrentProposalDescriptor(params: {
  projectRoot: string;
  state: RunState;
  proposalKind: ProposalKind;
}): CurrentProposalDescriptor {
  const artifactKey = proposalArtifactKey(params.proposalKind);
  const pointer = params.state.artifacts?.[artifactKey];
  if (typeof pointer !== 'string' || pointer.length === 0) {
    throw invalidParams(`No current ${params.proposalKind} proposal is available for this run.`, {
      proposal_kind: params.proposalKind,
      run_id: params.state.run_id,
    });
  }
  const proposalPath = path.resolve(params.projectRoot, pointer);
  const root = path.resolve(params.projectRoot);
  const relative = path.relative(root, proposalPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(proposalPath)) {
    throw invalidParams(`Current ${params.proposalKind} proposal pointer is invalid.`, {
      proposal_kind: params.proposalKind,
      pointer,
    });
  }

  if (params.proposalKind === 'skill') {
    const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf-8')) as SkillProposalV2;
    return {
      proposalId: proposal.proposal_id,
      proposalFingerprint: skillProposalFingerprint(proposal),
      proposalPath,
    };
  }
  const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf-8')) as MutationProposalV1;
  if (proposal.mutation_type !== params.proposalKind) {
    throw invalidParams('Current proposal mutation_type does not match requested proposal_kind.', {
      proposal_kind: params.proposalKind,
      mutation_type: proposal.mutation_type,
    });
  }
  return {
    proposalId: proposal.proposal_id,
    proposalFingerprint: mutationProposalFingerprint(proposal),
    proposalPath,
  };
}

export function recordProposalDecision(params: {
  projectRoot: string;
  state: RunState;
  proposalKind: ProposalKind;
  proposalId: string;
  decision: ProposalDecision;
  note?: string;
}): ProposalDecisionRecord {
  ensureProposalDecisionStore(params.projectRoot);
  if (!params.state.run_id) {
    throw invalidParams('proposal decision requires an active run_id in state.', {});
  }
  const current = readCurrentProposalDescriptor({
    projectRoot: params.projectRoot,
    state: params.state,
    proposalKind: params.proposalKind,
  });
  if (current.proposalId !== params.proposalId) {
    throw invalidParams('proposal_id does not match the current proposal artifact for this run.', {
      proposal_kind: params.proposalKind,
      expected: current.proposalId,
      got: params.proposalId,
    });
  }
  const { store } = loadProposalDecisionStore(params.projectRoot);
  const record: ProposalDecisionRecord = {
    proposal_kind: params.proposalKind,
    proposal_id: params.proposalId,
    proposal_fingerprint: current.proposalFingerprint,
    decision: params.decision,
    decided_at: new Date().toISOString(),
    note: params.note ?? null,
    suppress_duplicates: true,
  };
  saveProposalDecisionStore(params.projectRoot, {
    schema_version: 1,
    decisions: [...store.decisions, record],
  });
  return record;
}
