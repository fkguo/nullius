import type { WritingPacket } from '../types.js';

export interface AssetCoverageResult {
  pass: boolean;
  equations: {
    assigned: string[];
    mentioned: string[];
    substantively_discussed: string[];
    missing: string[];
    shallow: string[];
  };
  figures: {
    assigned: string[];
    mentioned: string[];
    substantively_discussed: string[];
    missing: string[];
    shallow: string[];
  };
  tables: {
    assigned: string[];
    mentioned: string[];
    substantively_discussed: string[];
    missing: string[];
    shallow: string[];
  };
  feedback: string[];
}

const MIN_DISCUSSION_WORDS = 25;
const DISCUSSION_WINDOW_FALLBACK_CHARS = 900;

function countWords(text: string): number {
  const cleaned = String(text ?? '')
    .replace(/\\cite\{[^}]+\}/g, ' ')
    .replace(/\\eqref\{[^}]+\}/g, ' ')
    .replace(/\\ref\{[^}]+\}/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, ' ');
  return cleaned.split(/\s+/).filter(w => w.length > 0).length;
}

function findAllMentionIndices(content: string, patterns: RegExp[]): number[] {
  const indices: number[] = [];
  for (const p of patterns) {
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    const re = new RegExp(p.source, flags);
    for (const m of content.matchAll(re)) {
      if (typeof m.index === 'number') indices.push(m.index);
    }
  }
  return Array.from(new Set(indices)).sort((a, b) => a - b);
}

function extractDiscussionWindow(content: string, mentionIndex: number): string {
  if (!Number.isFinite(mentionIndex) || mentionIndex < 0) return '';

  const paragraphs = content.split(/\n{2,}/).filter(p => p.trim().length > 0);
  if (paragraphs.length === 0) return '';

  // Find paragraph containing mentionIndex using incremental offsets (stable even with repeated text).
  let cursor = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const start = content.indexOf(p, cursor);
    const end = start + p.length;
    cursor = end;

    if (start <= mentionIndex && mentionIndex < end) {
      const next = paragraphs[i + 1];
      return next ? `${p}\n\n${next}` : p;
    }
  }

  const from = Math.max(0, mentionIndex - DISCUSSION_WINDOW_FALLBACK_CHARS);
  const to = Math.min(content.length, mentionIndex + DISCUSSION_WINDOW_FALLBACK_CHARS);
  return content.slice(from, to);
}

function buildAssetPatterns(params: {
  kind: 'equation' | 'figure' | 'table';
  evidence_id: string;
  label?: string;
  number?: string;
}): RegExp[] {
  const patterns: RegExp[] = [];
  const id = params.evidence_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const marker = params.kind === 'equation' ? 'Eq' : params.kind === 'figure' ? 'Fig' : 'Table';
  patterns.push(new RegExp(`${marker}\\[${id}\\]`, 'i'));

  if (params.label) {
    const labelEscaped = params.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(`\\\\(?:eqref|ref)\\{${labelEscaped}\\}`, 'i'));
    patterns.push(new RegExp(labelEscaped, 'i'));
  }

  if (params.number) {
    const numEscaped = params.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kindWord = params.kind === 'equation' ? 'Eq' : params.kind === 'figure' ? '(?:Fig(?:ure)?)' : 'Table';
    patterns.push(new RegExp(`${kindWord}\\.?\\s*\\(?${numEscaped}\\)?`, 'i'));
  }

  return patterns;
}

function verifyKind(params: {
  kind: 'equation' | 'figure' | 'table';
  content: string;
  assets: any[];
}): {
  assigned: string[];
  mentioned: string[];
  substantively_discussed: string[];
  missing: string[];
  shallow: string[];
  feedback: string[];
} {
  const assigned = params.assets.map(a => String(a?.evidence_id ?? '')).filter(Boolean);
  const mentioned: string[] = [];
  const substantively_discussed: string[] = [];
  const missing: string[] = [];
  const shallow: string[] = [];
  const feedback: string[] = [];

  for (const asset of params.assets) {
    const evidence_id = String(asset?.evidence_id ?? '');
    if (!evidence_id) continue;

    const patterns = buildAssetPatterns({
      kind: params.kind,
      evidence_id,
      label: typeof asset?.label === 'string' ? asset.label : undefined,
      number: typeof asset?.number === 'string' ? asset.number : undefined,
    });

    const mentionIndices = findAllMentionIndices(params.content, patterns);
    if (mentionIndices.length === 0) {
      missing.push(evidence_id);
      feedback.push(`${params.kind} ${evidence_id} was NOT referenced. You MUST reference it using the provided marker or label.`);
      continue;
    }

    mentioned.push(evidence_id);

    let bestWords = 0;
    for (const mentionIndex of mentionIndices) {
      const window = extractDiscussionWindow(params.content, mentionIndex);
      const words = countWords(window);
      if (words > bestWords) bestWords = words;
      if (bestWords >= MIN_DISCUSSION_WORDS) break;
    }
    if (bestWords < MIN_DISCUSSION_WORDS) {
      shallow.push(evidence_id);
      feedback.push(`${params.kind} ${evidence_id} was referenced but only has ~${bestWords} words of adjacent discussion; MUST be ≥${MIN_DISCUSSION_WORDS} words.`);
      continue;
    }

    substantively_discussed.push(evidence_id);
  }

  return { assigned, mentioned, substantively_discussed, missing, shallow, feedback };
}

/**
 * Verify that section output covers (mentions + substantive adjacent discussion) all assigned assets.
 *
 * IMPORTANT: This expects `assignedAssets` to reflect the same top-K selection that was injected into the prompt.
 */
export function verifyAssetCoverage(
  sectionOutput: { content?: string },
  assignedAssets: WritingPacket['assigned_assets']
): AssetCoverageResult {
  const content = typeof sectionOutput?.content === 'string' ? sectionOutput.content : '';
  const feedback: string[] = [];

  const eq = verifyKind({ kind: 'equation', content, assets: Array.isArray(assignedAssets?.equations) ? assignedAssets.equations : [] });
  const fig = verifyKind({ kind: 'figure', content, assets: Array.isArray(assignedAssets?.figures) ? assignedAssets.figures : [] });
  const tab = verifyKind({ kind: 'table', content, assets: Array.isArray(assignedAssets?.tables) ? assignedAssets.tables : [] });

  feedback.push(...eq.feedback, ...fig.feedback, ...tab.feedback);

  const pass = eq.missing.length === 0 && eq.shallow.length === 0 &&
    fig.missing.length === 0 && fig.shallow.length === 0 &&
    tab.missing.length === 0 && tab.shallow.length === 0;

  return {
    pass,
    equations: {
      assigned: eq.assigned,
      mentioned: eq.mentioned,
      substantively_discussed: eq.substantively_discussed,
      missing: eq.missing,
      shallow: eq.shallow,
    },
    figures: {
      assigned: fig.assigned,
      mentioned: fig.mentioned,
      substantively_discussed: fig.substantively_discussed,
      missing: fig.missing,
      shallow: fig.shallow,
    },
    tables: {
      assigned: tab.assigned,
      mentioned: tab.mentioned,
      substantively_discussed: tab.substantively_discussed,
      missing: tab.missing,
      shallow: tab.shallow,
    },
    feedback,
  };
}
