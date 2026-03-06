import { createHash } from 'crypto';
import { canonicalQuantityKey } from './quantityCanonical.js';
import { adjudicateQuantityPair, type QuantitySamplingContext } from './quantityAdjudicator.js';
import type { QuantityMentionV1 } from './quantityTypes.js';
import { tokenOverlapRatio, tokenizeQuantityText } from './quantityText.js';
import { unitPairIncompatible } from './quantityUnits.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stableUnknownKey(mention: QuantityMentionV1): string {
  const hash = sha256Hex(JSON.stringify(mention)).slice(0, 10);
  return `unknown_${hash}`;
}

type Group<T> = {
  key: string;
  representative: QuantityMentionV1;
  representativeTokens: string[];
  kindHint: string | null;
  items: T[];
};

function kindOfCanonicalKey(key: string): string | null {
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  return key.slice(0, idx) || null;
}

export type QuantityClusteringStatsV1 = {
  comparisons: number;
  llm_used: number;
  budget_exhausted: boolean;
  matched: number;
  created: number;
  renamed_from_unknown: number;
};

export async function clusterByQuantity<T>(params: {
  items: Array<{ item: T; mention: QuantityMentionV1 }>;
  ctx?: QuantitySamplingContext;
  max_comparisons?: number;
  min_match_confidence?: number;
  prompt_version?: string;
}): Promise<{ groups: Map<string, T[]>; stats: QuantityClusteringStatsV1 }> {
  const maxComparisons = Math.max(0, Math.min(params.max_comparisons ?? 400, 20_000));
  const minMatchConfidence = Math.max(0, Math.min(params.min_match_confidence ?? 0.6, 1));
  const promptVersion = params.prompt_version ?? 'v1';

  const groups: Array<Group<T>> = [];
  const stats: QuantityClusteringStatsV1 = {
    comparisons: 0,
    llm_used: 0,
    budget_exhausted: false,
    matched: 0,
    created: 0,
    renamed_from_unknown: 0,
  };

  for (const entry of params.items) {
    const mentionTokens = tokenizeQuantityText(`${entry.mention.quantity} ${entry.mention.context}`.trim());
    const canonicalKey = canonicalQuantityKey(entry.mention);
    const kindHint = canonicalKey === 'unknown' ? null : kindOfCanonicalKey(canonicalKey);

    const candidates = groups
      .map((group, index) => ({
        index,
        group,
        overlap: tokenOverlapRatio(mentionTokens, group.representativeTokens),
      }))
      .filter(c => {
        if (c.overlap < 0.12) return false;
        if (kindHint && c.group.kindHint && kindHint !== c.group.kindHint) return false;
        if (unitPairIncompatible(entry.mention, c.group.representative)) return false;
        return true;
      })
      .sort((left, right) => right.overlap - left.overlap || left.index - right.index)
      .slice(0, 6);

    let assigned = false;

    for (const candidate of candidates) {
      if (stats.comparisons >= maxComparisons) {
        stats.budget_exhausted = true;
        break;
      }

      stats.comparisons += 1;
      const adjudication = await adjudicateQuantityPair(
        entry.mention,
        candidate.group.representative,
        params.ctx,
        { prompt_version: promptVersion },
      );

      if (adjudication.provenance.backend === 'mcp_sampling' && !adjudication.provenance.used_fallback) {
        stats.llm_used += 1;
      }

      if (adjudication.decision !== 'match') continue;
      if (adjudication.confidence < minMatchConfidence) continue;

      candidate.group.items.push(entry.item);
      assigned = true;
      stats.matched += 1;

      if (candidate.group.key.startsWith('unknown_') && adjudication.canonical_quantity !== 'unknown') {
        candidate.group.key = adjudication.canonical_quantity;
        candidate.group.kindHint = kindOfCanonicalKey(candidate.group.key);
        stats.renamed_from_unknown += 1;
      }
      break;
    }

    if (!assigned) {
      const key = canonicalKey === 'unknown' ? stableUnknownKey(entry.mention) : canonicalKey;
      groups.push({
        key,
        representative: entry.mention,
        representativeTokens: mentionTokens,
        kindHint,
        items: [entry.item],
      });
      stats.created += 1;
    }
  }

  const out = new Map<string, T[]>();
  for (const group of groups) {
    const existing = out.get(group.key);
    if (existing) existing.push(...group.items);
    else out.set(group.key, [...group.items]);
  }

  return { groups: out, stats };
}

