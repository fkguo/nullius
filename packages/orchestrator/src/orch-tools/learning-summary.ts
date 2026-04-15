import type { RunState } from '../types.js';
import { readInnovateProposalView, readOptimizeProposalView, readRepairProposalView } from './repair-proposal.js';
import { readSkillProposalView } from './skill-proposal.js';

type ProposalView = Record<string, unknown> | null;
type LearningSummaryEntry = {
  kind: string;
  proposal_id: unknown;
  status: unknown;
  summary: string | null;
  top_signals?: string[];
  pattern_kind?: unknown;
};

function firstSignals(proposal: ProposalView): string[] {
  const signals = proposal?.signals;
  return Array.isArray(signals)
    ? signals.filter((value): value is string => typeof value === 'string').slice(0, 3)
    : [];
}

function whySuggested(kind: string, proposal: ProposalView): string | null {
  if (!proposal) return null;
  switch (kind) {
    case 'repair':
      return 'Repeated failed compute signals matched the same repair-worthy pattern more than once.';
    case 'skill': {
      const trigger = proposal.trigger;
      const patternKind = trigger && typeof trigger === 'object' ? (trigger as Record<string, unknown>).pattern_kind : null;
      if (patternKind === 'package_usage_pattern') {
        return 'The same successful package/workflow pattern repeated across runs and now looks reusable as a playbook.';
      }
      return 'The same agent-trace pattern repeated enough times to justify a reusable skill suggestion.';
    }
    case 'optimize':
      return 'The same successful workflow repeated often enough to suggest a local optimization opportunity.';
    case 'innovate':
      return 'A repeated successful multi-ecosystem workflow suggests a higher-level innovation opportunity.';
    default:
      return null;
  }
}

export function readLearningSummaryView(projectRoot: string, state: RunState): {
  learning_summary: Record<string, unknown> | null;
  learning_summary_error: Record<string, unknown> | null;
} {
  const repair = readRepairProposalView(projectRoot, state);
  const optimize = readOptimizeProposalView(projectRoot, state);
  const innovate = readInnovateProposalView(projectRoot, state);
  const skill = readSkillProposalView(projectRoot, state);

  const entries = [
    repair.repair_mutation_proposal
      ? {
          kind: 'repair',
          proposal_id: repair.repair_mutation_proposal.proposal_id,
          status: repair.repair_mutation_proposal.status,
          summary: whySuggested('repair', repair.repair_mutation_proposal),
          top_signals: firstSignals(repair.repair_mutation_proposal),
        }
      : null,
    skill.skill_proposal
      ? {
          kind: 'skill',
          proposal_id: skill.skill_proposal.proposal_id,
          status: skill.skill_proposal.status,
          summary: whySuggested('skill', skill.skill_proposal),
          pattern_kind: skill.skill_proposal.trigger && typeof skill.skill_proposal.trigger === 'object'
            ? (skill.skill_proposal.trigger as Record<string, unknown>).pattern_kind ?? null
            : null,
        }
      : null,
    optimize.optimize_mutation_proposal
      ? {
          kind: 'optimize',
          proposal_id: optimize.optimize_mutation_proposal.proposal_id,
          status: optimize.optimize_mutation_proposal.status,
          summary: whySuggested('optimize', optimize.optimize_mutation_proposal),
          top_signals: firstSignals(optimize.optimize_mutation_proposal),
        }
      : null,
    innovate.innovate_mutation_proposal
      ? {
          kind: 'innovate',
          proposal_id: innovate.innovate_mutation_proposal.proposal_id,
          status: innovate.innovate_mutation_proposal.status,
          summary: whySuggested('innovate', innovate.innovate_mutation_proposal),
          top_signals: firstSignals(innovate.innovate_mutation_proposal),
        }
      : null,
  ].filter(Boolean) as LearningSummaryEntry[];

  const errors = [
    repair.repair_mutation_proposal_error,
    skill.skill_proposal_error,
    optimize.optimize_mutation_proposal_error,
    innovate.innovate_mutation_proposal_error,
  ].filter((value): value is Record<string, unknown> => value !== null);

  if (entries.length === 0 && errors.length === 0) {
    return { learning_summary: null, learning_summary_error: null };
  }

  return {
    learning_summary: {
      current_run_id: state.run_id,
      proposal_count: entries.length,
      entries,
    },
    learning_summary_error: errors.length > 0
      ? {
          code: 'LEARNING_SUMMARY_PARTIAL',
          message: `Built learning summary with ${errors.length} proposal read error(s).`,
          proposal_errors: errors,
        }
      : null,
  };
}
