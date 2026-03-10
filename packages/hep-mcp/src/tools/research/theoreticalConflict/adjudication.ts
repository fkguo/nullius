import { isEdgeRelation } from './prompts.js';
import type { EdgeRelation } from './prompts.js';

type RationaleCategory = 'conflicting' | 'compatible' | 'not_comparable' | 'unclear';

export type ConflictRationaleV1 = {
  category: RationaleCategory;
  summary: string;
  assumption_differences: string[];
  observable_differences: string[];
  scope_notes: string[];
};

export type ParsedAdjudication = {
  relation: EdgeRelation;
  confidence: number;
  reasoning: string;
  compatibility_note?: string;
  rationale: ConflictRationaleV1;
  abstain?: boolean;
};

function parseJsonPayload(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return input;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return input;
    }
  }
}


function relationToCategory(relation: EdgeRelation): RationaleCategory {
  if (relation === 'contradict') return 'conflicting';
  if (relation === 'different_scope') return 'not_comparable';
  return relation;
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function defaultRationaleForRelation(relation: EdgeRelation, summary?: string): ConflictRationaleV1 {
  return {
    category: relationToCategory(relation),
    summary: summary?.trim() || (
      relation === 'contradict'
        ? 'Candidate positions look mutually incompatible.'
        : relation === 'different_scope'
          ? 'Candidate positions appear to address different assumptions or observables.'
          : relation === 'compatible'
            ? 'Candidate positions appear jointly satisfiable.'
            : 'Available evidence is insufficient for a stable adjudication.'
    ),
    assumption_differences: [],
    observable_differences: [],
    scope_notes: relation === 'different_scope' ? ['Heuristic prefilter marked this edge as scope-separated.'] : [],
  };
}

export function parseAdjudication(input: unknown): ParsedAdjudication | null {
  const obj = parseJsonPayload(input);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const abstain = record.abstain === true;
  if (abstain) {
    const reasoning = String(record.reasoning ?? record.reason ?? '').trim() || 'Model abstained from adjudicating this edge.';
    const rationaleRecord = record.rationale && typeof record.rationale === 'object' && !Array.isArray(record.rationale)
      ? record.rationale as Record<string, unknown>
      : null;
    const rationale = rationaleRecord
      ? {
          category: 'unclear' as const,
          summary: String(rationaleRecord.summary ?? reasoning).trim() || reasoning,
          assumption_differences: normalizeStringArray(rationaleRecord.assumption_differences),
          observable_differences: normalizeStringArray(rationaleRecord.observable_differences),
          scope_notes: normalizeStringArray(rationaleRecord.scope_notes),
        }
      : defaultRationaleForRelation('unclear', reasoning);
    return {
      relation: 'unclear',
      confidence: 0,
      reasoning,
      rationale,
      abstain: true,
    };
  }

  const relationRaw = String(record.relation ?? '').trim();
  if (!isEdgeRelation(relationRaw)) return null;
  const relation = relationRaw as EdgeRelation;
  const confidence = Number(record.confidence);
  const reasoning = String(record.reasoning ?? '').trim();
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !reasoning) return null;
  const compatibility_note = typeof record.compatibility_note === 'string' && record.compatibility_note.trim()
    ? record.compatibility_note.trim()
    : undefined;

  const rationaleRecord = record.rationale && typeof record.rationale === 'object' && !Array.isArray(record.rationale)
    ? record.rationale as Record<string, unknown>
    : null;
  const rationale = rationaleRecord
    ? {
        category: relationToCategory(relation),
        summary: String(rationaleRecord.summary ?? reasoning).trim() || reasoning,
        assumption_differences: normalizeStringArray(rationaleRecord.assumption_differences),
        observable_differences: normalizeStringArray(rationaleRecord.observable_differences),
        scope_notes: normalizeStringArray(rationaleRecord.scope_notes),
      }
    : defaultRationaleForRelation(relation, reasoning);

  return { relation, confidence, reasoning, compatibility_note, rationale };
}
