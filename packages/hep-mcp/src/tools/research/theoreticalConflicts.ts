import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  INSPIRE_CRITICAL_RESEARCH,
  invalidParams,
} from '@autoresearch/shared';
import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';

import * as api from '../../api/client.js';
import { writeRunJsonArtifact } from '../../core/citations.js';
import { getRunArtifactPath } from '../../core/paths.js';
import { getRun, type RunArtifactRef } from '../../core/runs.js';
import { createHepRunArtifactRef, makeHepRunArtifactUri, makeHepRunManifestUri } from '../../core/runArtifactUri.js';
import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';
import { buildToolSamplingMetadata } from '../../core/sampling-metadata.js';
import {
  collectLexiconRetrievalPrior,
  type DebateAxis,
  type LexiconRetrievalPriorV1,
} from './theoreticalConflict/lexicon.js';
import {
  defaultRationaleForRelation,
  parseAdjudication,
  type ConflictRationaleV1,
  type ParsedAdjudication,
} from './theoreticalConflict/adjudication.js';
import {
  buildAdjudicateEdgePrompt,
  isAdjudicateEdgePromptVersion,
  type AdjudicateEdgePromptVersion,
} from './theoreticalConflict/prompts.js';

type InputType = 'title' | 'abstract' | 'citation_context' | 'evidence_paragraph';
type ClaimType = 'interpretation' | 'prediction' | 'methodology' | 'assumption' | 'measurement';

type EdgeRelation = 'contradict' | 'compatible' | 'different_scope' | 'unclear';
type EvidenceStrength = 'strong' | 'moderate' | 'weak';
type EdgeDecisionStatus = 'adjudicated' | 'fallback' | 'abstained' | 'pending_client';

export interface TheoreticalConflictsResult {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions?: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}

type ClaimCandidateV1 = {
  version: 1;
  claim_candidate_id: string;
  input_type: InputType;
  text: string;
  locator?: { recid: string; field?: 'title' | 'abstract'; evidence_id?: string };
  subject_entity_hint?: string;
  trigger_signals?: string[];
  retrieval_prior?: LexiconRetrievalPriorV1;
};

type NormalizedClaimV1 = {
  version: 1;
  claim_id: string;
  claim_type: ClaimType;
  subject_entity: string;
  axis: DebateAxis;
  position: string;
  polarity: 'assert' | 'support' | 'disfavor' | 'uncertain';
  qualifiers?: string[];
  original_text: string;
  source: { recid: string; title?: string; year?: number };
  confidence: number;
  evidence_refs?: Array<{ recid: string; field?: 'title' | 'abstract'; evidence_id?: string }>;
  retrieval_prior?: LexiconRetrievalPriorV1;
};

type DebateNodeV1 = {
  version: 1;
  subject_entity: string;
  axis: DebateAxis;
  positions: Array<{
    position: string;
    claims: NormalizedClaimV1[];
    support_strength: EvidenceStrength;
  }>;
};

type ConflictEdgeV1 = {
  version: 1;
  edge_id: string;
  subject_entity: string;
  axis: DebateAxis;
  position_a: string;
  position_b: string;
  relation: EdgeRelation;
  confidence: number;
  reasoning?: string;
  compatibility_note?: string;
  adjudication_category?: ConflictRationaleV1['category'];
  rationale?: ConflictRationaleV1;
  evidence_strength: EvidenceStrength;
  claim_ids: string[];
  provenance: {
    decision_source: 'llm_adjudication' | 'fallback_uncertain';
    decision_status: EdgeDecisionStatus;
    reason_code: string;
    used_retrieval_prior: boolean;
    retrieval_prior_sources: string[];
    retrieval_prior_hits: string[];
  };
};

type ConflictCandidateProvenanceV1 = {
  retrieval_strategy: 'semantic_similarity';
  used_retrieval_prior: boolean;
  retrieval_prior_sources: string[];
  retrieval_prior_hits: string[];
};

type LlmMode = 'passthrough' | 'client' | 'internal';

type LlmRequestV1 = {
  version: 1;
  generated_at: string;
  request_id: string;
  prompt_version: string;
  kind: 'adjudicate_edge';
  edge_id: string;
  subject_entity: string;
  axis: DebateAxis;
  position_a: string;
  position_b: string;
  score?: number;
  claims_a: Array<{ recid: string; title?: string; year?: number; text: string }>;
  claims_b: Array<{ recid: string; title?: string; year?: number; text: string }>;
  prompt: string;
};

type ClientLlmResponseInput = {
  request_id: string;
  json_response: unknown;
  model?: string;
  created_at?: string;
  [key: string]: unknown;
};

type SparseVector = { dim: number; indices: number[]; values: number[] };

interface TheoreticalConflictsContext {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
}

function extractSamplingText(content: CreateMessageResult['content']): string {
  if (!content) return '';
  if (Array.isArray(content)) {
    const textParts = content
      .filter((block): block is { type: 'text'; text: string } => {
        return Boolean(
          block
          && typeof block === 'object'
          && 'type' in block
          && 'text' in block
          && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string'
        );
      })
      .map(block => block.text.trim())
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('\n');
    return JSON.stringify(content);
  }
  if (typeof content === 'object' && !Array.isArray(content) && 'type' in content && content.type === 'text') {
    return typeof content.text === 'string' ? content.text : '';
  }
  return JSON.stringify(content);
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown_error');
}

function errorCode(err: unknown): number | string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  const direct = record.code;
  if (typeof direct === 'number' || typeof direct === 'string') return direct;
  const nested = record.error;
  if (!nested || typeof nested !== 'object') return undefined;
  const nestedCode = (nested as Record<string, unknown>).code;
  return (typeof nestedCode === 'number' || typeof nestedCode === 'string') ? nestedCode : undefined;
}

function isSamplingUnavailableError(err: unknown): boolean {
  const code = errorCode(err);
  if (code === -32601 || code === '-32601') return true;

  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('method not found')) return true;
  if (msg.includes('create message') && (msg.includes('not support') || msg.includes('unsupported'))) return true;
  if (msg.includes('createmessage') && (msg.includes('not support') || msg.includes('unsupported'))) return true;
  if (msg.includes('sampling') && (
    msg.includes('not support') ||
    msg.includes('unsupported') ||
    msg.includes('not available') ||
    msg.includes('unavailable')
  )) {
    return true;
  }
  return false;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function writeRunJsonlArtifact(runId: string, artifactName: string, rows: unknown[]): RunArtifactRef {
  const p = getRunArtifactPath(runId, artifactName);
  const lines = rows.map(r => JSON.stringify(r));
  fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf-8');
  return createHepRunArtifactRef(runId, artifactName, 'application/x-ndjson');
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitSentences(text: string): string[] {
  const t = normalizeWhitespace(text);
  if (!t) return [];
  return t
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

const TRIGGER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'we_propose', re: /\bwe\s+propose\b/i },
  { name: 'we_interpret', re: /\bwe\s+interpret\b/i },
  { name: 'we_argue', re: /\bwe\s+argue\b/i },
  { name: 'we_conclude', re: /\bwe\s+conclude\b/i },
  { name: 'favors', re: /\bfavor(?:s|ed|ing)?\b/i },
  { name: 'disfavors', re: /\bdisfavor(?:s|ed|ing)?\b/i },
  { name: 'inconsistent', re: /\binconsistent\s+with\b/i },
  { name: 'compatible', re: /\bcompatible\s+with\b/i },
];

function guessPolarity(text: string): NormalizedClaimV1['polarity'] {
  const lower = text.toLowerCase();
  if (/\bdisfavor\b|\brule\s+out\b|\bexclude\b/.test(lower)) return 'disfavor';
  if (/\bfavor\b|\bsupport\b/.test(lower)) return 'support';
  if (/\buncertain\b|\bmaybe\b|\bpossible\b/.test(lower)) return 'uncertain';
  return 'assert';
}

function evidenceStrengthFromCount(n: number): EvidenceStrength {
  if (n >= 3) return 'strong';
  if (n >= 1) return 'moderate';
  return 'weak';
}

function normalizeText(text: string): string {
  return normalizeTextPreserveUnits(text);
}

function tokenizeForEmbedding(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-zA-Z0-9_:+-]+/g, ' ')
    .split(' ')
    .map(t => t.trim())
    .filter(Boolean);
}

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function buildSparseVector(text: string, dim: number): SparseVector {
  const counts = new Map<number, number>();
  const tokens = tokenizeForEmbedding(text);
  for (const token of tokens) {
    const h = fnv1a32(token);
    const idx = h % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    counts.set(idx, (counts.get(idx) ?? 0) + sign);
  }

  const entries = Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  const indices: number[] = [];
  const values: number[] = [];
  let norm2 = 0;
  for (const [, v] of entries) norm2 += v * v;
  const norm = norm2 > 0 ? Math.sqrt(norm2) : 1;

  for (const [i, v] of entries) {
    if (v === 0) continue;
    indices.push(i);
    values.push(v / norm);
  }

  return { dim, indices, values };
}

function dotSparse(a: SparseVector, b: SparseVector): number {
  if (a.dim !== b.dim) return 0;
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.indices.length && j < b.indices.length) {
    const ai = a.indices[i]!;
    const bj = b.indices[j]!;
    if (ai === bj) {
      sum += (a.values[i] ?? 0) * (b.values[j] ?? 0);
      i++;
      j++;
      continue;
    }
    if (ai < bj) i++;
    else j++;
  }
  return sum;
}

function tokenOverlapExplanation(aText: string, bText: string, cap: number = 40): { matched_tokens: string[]; token_overlap_ratio: number } {
  const aTokens = tokenizeForEmbedding(aText);
  const bTokens = tokenizeForEmbedding(bText);
  if (aTokens.length === 0 || bTokens.length === 0) return { matched_tokens: [], token_overlap_ratio: 0 };
  const bSet = new Set(bTokens);
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const t of aTokens) {
    if (!bSet.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    matched.push(t);
    if (matched.length >= cap) break;
  }
  const denom = Math.max(1, Math.min(aTokens.length, bTokens.length));
  return {
    matched_tokens: matched,
    token_overlap_ratio: clamp01(seen.size / denom),
  };
}

function extractEntityHint(text: string): string | undefined {
  const t = normalizeWhitespace(text);
  if (!t) return undefined;
  const m = t.match(/\b[A-Z][A-Za-z]{0,3}\(\s*\d{3,5}\s*\)\b/);
  if (m && m[0]) return normalizeWhitespace(m[0]);
  const tcc = t.match(/\bT(?:_\{?cc\}?|cc)\b/i);
  if (tcc && tcc[0]) return normalizeWhitespace(tcc[0]);
  return undefined;
}

function derivePositionLabel(text: string, subjectEntity: string): string {
  const normalized = normalizeWhitespace(text).replace(/[.;:]+$/g, '');
  if (!normalized) return 'claim';

  let cleaned = normalized
    .replace(/^(?:we|our (?:results|analysis|study))\s+(?:propose|interpret|argue|conclude|find|show|demonstrate|suggest)\s+(?:that\s+)?/i, '')
    .replace(/^(?:this paper|this work)\s+(?:argues?|proposes?|suggests?)\s+(?:that\s+)?/i, '')
    .replace(/^(?:it|this|the result)\s+(?:is|are)\s+/i, '')
    .replace(/^(?:a|an|the)\s+/i, '');

  if (subjectEntity && subjectEntity !== 'unknown') {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(subjectEntity), 'ig'), ' ');
  }

  cleaned = cleaned
    .replace(/^[,:;-]+\s*/g, '')
    .replace(/\b(?:for|of|in|on|with|via|using|from|to)\s*$/i, '')
    .replace(/^\b(?:is|are|can be|may be|as)\b\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = (cleaned || normalized)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean)
    .slice(0, 12);
  return (tokens.join(' ') || 'claim').toLowerCase();
}

function stableSort<T>(items: T[], key: (t: T) => string): T[] {
  const copy = [...items];
  copy.sort((a, b) => key(a).localeCompare(key(b)));
  return copy;
}

function takeTopK<T>(items: T[], k: number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return items;
  return items.slice(0, k);
}

export async function performTheoreticalConflicts(params: {
  run_id: string;
  recids: string[];
  options: {
    subject_entity?: string;
    inputs?: InputType[];
    max_papers?: number;
    max_claim_candidates_per_paper?: number;
    max_candidates_total?: number;
    llm_mode?: LlmMode;
    max_llm_requests?: number;
    strict_llm?: boolean;
    prompt_version?: string;
    stable_sort?: boolean;
    client_llm_responses?: ClientLlmResponseInput[];
  };
}, ctx: TheoreticalConflictsContext = {}): Promise<TheoreticalConflictsResult> {
  const run = getRun(params.run_id);
  const runStartedAt = nowIso();
  const stableSortEnabled = params.options.stable_sort ?? true;
  const llmMode: LlmMode = params.options.llm_mode ?? 'passthrough';
  const strictLlm = params.options.strict_llm ?? false;

  const promptVersionRaw = params.options.prompt_version ?? 'v2';
  if (!isAdjudicateEdgePromptVersion(promptVersionRaw)) {
    throw invalidParams('Unknown prompt_version for theoretical adjudication', {
      prompt_version: promptVersionRaw,
      supported: ['v1', 'v2'],
    });
  }
  const promptVersion = promptVersionRaw as AdjudicateEdgePromptVersion;

  const warnings: string[] = [];

  const inputsRequested: InputType[] = (params.options.inputs && params.options.inputs.length > 0)
    ? params.options.inputs
    : ['title', 'abstract'];
  const inputsEffective = inputsRequested.filter(t => t === 'title' || t === 'abstract');
  const unsupportedInputs = inputsRequested.filter(t => t !== 'title' && t !== 'abstract');
  if (unsupportedInputs.length > 0) warnings.push(`unsupported_inputs_ignored:${unsupportedInputs.join(',')}`);

  const maxPapers = Math.max(1, Math.min(params.options.max_papers ?? params.recids.length, params.recids.length));
  const maxPerPaper = Math.max(1, Math.min(params.options.max_claim_candidates_per_paper ?? 20, 200));
  const maxCandidatesTotal = Math.max(1, Math.min(params.options.max_candidates_total ?? 200, 5000));
  const maxLlmRequests = Math.max(1, Math.min(params.options.max_llm_requests ?? 50, 5000));

  const recids = uniqueStrings(params.recids).slice(0, maxPapers);
  const recidsOrdered = stableSortEnabled ? recids.slice().sort((a, b) => a.localeCompare(b)) : recids;

  const subjectEntityDefault = params.options.subject_entity?.trim() || 'unknown';

  const sourceStatus: Array<{ recid: string; status: 'success' | 'failed'; stage: 'fetch' | 'extract' | 'llm'; error?: string }> = [];
  const papers: Array<{ recid: string; title?: string; year?: number; abstract?: string | null }> = [];

  for (const recid of recidsOrdered) {
    try {
      const paper = await api.getPaper(recid);
      papers.push({ recid, title: paper.title, year: paper.year, abstract: paper.abstract ?? null });
      sourceStatus.push({ recid, status: 'success', stage: 'fetch' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sourceStatus.push({ recid, status: 'failed', stage: 'fetch', error: msg });
    }
  }

  const candidates: ClaimCandidateV1[] = [];
  const candidatesById = new Set<string>();

  for (const paper of papers) {
    const collected: Array<{ input_type: InputType; field?: 'title' | 'abstract'; text: string }> = [];
    if (inputsEffective.includes('title') && paper.title) {
      collected.push({ input_type: 'title', field: 'title', text: paper.title });
    }
    if (inputsEffective.includes('abstract') && paper.abstract) {
      collected.push({ input_type: 'abstract', field: 'abstract', text: paper.abstract });
    }

    const perPaper: ClaimCandidateV1[] = [];
    for (const item of collected) {
      const sentences = item.input_type === 'title' ? [item.text] : splitSentences(item.text);
      for (const s of sentences) {
        const text = normalizeWhitespace(s);
        if (!text) continue;

        const triggerSignals = TRIGGER_PATTERNS.filter(p => p.re.test(text)).map(p => p.name);
        const retrievalPrior = collectLexiconRetrievalPrior(text);

        // Titles remain admissible as open-world claim summaries. Lexicon hits can help retrieval, but
        // may not suppress or finalize a conflict decision.
        if (item.input_type !== 'title' && triggerSignals.length === 0 && !retrievalPrior) continue;

        const claimCandidateId = `cc_${sha256Hex(JSON.stringify({ recid: paper.recid, input_type: item.input_type, text })).slice(0, 16)}`;
        if (candidatesById.has(claimCandidateId)) continue;
        candidatesById.add(claimCandidateId);

        const entityHint = subjectEntityDefault !== 'unknown' ? subjectEntityDefault : (extractEntityHint(text) ?? 'unknown');

        perPaper.push({
          version: 1,
          claim_candidate_id: claimCandidateId,
          input_type: item.input_type,
          text,
          locator: item.field ? { recid: paper.recid, field: item.field } : { recid: paper.recid },
          subject_entity_hint: entityHint !== 'unknown' ? entityHint : undefined,
          trigger_signals: [...triggerSignals, ...(retrievalPrior?.hits ?? [])].length > 0
            ? [...triggerSignals, ...(retrievalPrior?.hits ?? [])]
            : undefined,
          retrieval_prior: retrievalPrior ?? undefined,
        });
      }
    }

    candidates.push(...perPaper.slice(0, maxPerPaper));
    sourceStatus.push({ recid: paper.recid, status: 'success', stage: 'extract' });
  }

  const maxClaimCandidates = Math.min(5000, maxPapers * maxPerPaper);
  const candidatesFinal = stableSortEnabled
    ? stableSort(candidates.slice(0, maxClaimCandidates), c => c.claim_candidate_id)
    : candidates.slice(0, maxClaimCandidates);

  const paperMetaByRecid = new Map(papers.map(p => [p.recid, p]));

  // Baseline normalization (0 LLM).
  const claims: NormalizedClaimV1[] = candidatesFinal.map(c => {
    const position = derivePositionLabel(
      c.text,
      subjectEntityDefault !== 'unknown' ? subjectEntityDefault : (c.subject_entity_hint?.trim() || 'unknown'),
    );
    const polarity = guessPolarity(c.text);
    const triggerCount = Array.isArray(c.trigger_signals) ? c.trigger_signals.length : 0;
    const confidenceBase = c.input_type === 'title' ? 0.45 : 0.35;
    const confidence = clamp01(
      confidenceBase
      + Math.min(0.2, triggerCount * 0.05)
      + (c.retrieval_prior ? 0.05 : 0),
    );

    const effectiveEntity = subjectEntityDefault !== 'unknown' ? subjectEntityDefault : (c.subject_entity_hint?.trim() || 'unknown');
    const claimId = `cl_${sha256Hex(JSON.stringify({
      recid: c.locator?.recid ?? '',
      subject_entity: effectiveEntity,
      axis: 'other',
      position,
      text: c.text.toLowerCase(),
    })).slice(0, 16)}`;

    const recid = c.locator?.recid ?? '';
    const meta = paperMetaByRecid.get(recid);
    return {
      version: 1,
      claim_id: claimId,
      claim_type: 'interpretation',
      subject_entity: effectiveEntity,
      axis: 'other',
      position,
      polarity,
      original_text: c.text,
      source: { recid, title: meta?.title, year: meta?.year },
      confidence,
      evidence_refs: recid ? [{ recid, field: c.locator?.field }] : undefined,
      retrieval_prior: c.retrieval_prior,
    };
  });

  const claimsFinal = stableSortEnabled ? stableSort(claims, c => c.claim_id) : claims;

  // Debate map: group by subject_entity + axis.
  const byKey = new Map<string, NormalizedClaimV1[]>();
  for (const c of claimsFinal) {
    const key = `${c.subject_entity}__${c.axis}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }

  const debateNodes: DebateNodeV1[] = [];
  for (const [key, axisClaims] of byKey.entries()) {
    const [subjectEntity, axisRaw] = key.split('__');
    const axis = (axisRaw ?? 'other') as DebateAxis;

    const byPos = new Map<string, NormalizedClaimV1[]>();
    for (const c of axisClaims) {
      const list = byPos.get(c.position) ?? [];
      list.push(c);
      byPos.set(c.position, list);
    }

    const positions = Array.from(byPos.entries()).map(([position, cs]) => ({
      position,
      claims: stableSortEnabled ? stableSort(cs, x => x.claim_id) : cs,
      support_strength: evidenceStrengthFromCount(cs.length),
    }));

    debateNodes.push({
      version: 1,
      subject_entity: subjectEntity ?? 'unknown',
      axis,
      positions: stableSortEnabled ? stableSort(positions, p => p.position) : positions,
    });
  }

  const debateNodesFinal = stableSortEnabled
    ? stableSort(debateNodes, n => `${n.subject_entity}__${n.axis}`)
    : debateNodes;

  const EMBEDDING_DIM = 256;
  const TOP_K_PER_BUCKET = 20;

  type ConflictCandidateV1 = {
    version: 1;
    edge_id: string;
    subject_entity: string;
    axis: DebateAxis;
    position_a: string;
    position_b: string;
    score: number;
    retrieval_explanation: { matched_tokens: string[]; token_overlap_ratio: number };
    candidate_provenance: ConflictCandidateProvenanceV1;
    embedding_similarity: number;
    support_balance: number;
    claims_a_count: number;
    claims_b_count: number;
    baseline_relation: EdgeRelation;
    baseline_confidence: number;
    evidence_strength: EvidenceStrength;
    claim_ids: string[];
  };

  const conflictCandidatesAll: ConflictCandidateV1[] = [];
  for (const node of debateNodesFinal) {
    const positions = node.positions.map(p => p.position).filter(p => p !== 'unknown');
    const uniquePositions = uniqueStrings(positions);
    if (uniquePositions.length < 2) continue;

    const positionText = new Map<string, string>();
    const positionVec = new Map<string, SparseVector>();
    const positionCount = new Map<string, number>();

    for (const pos of uniquePositions) {
      const cs = node.positions.find(p => p.position === pos)?.claims ?? [];
      const joined = cs.map(c => c.original_text).join('\n');
      positionText.set(pos, joined);
      positionVec.set(pos, buildSparseVector(joined, EMBEDDING_DIM));
      positionCount.set(pos, cs.length);
    }

    const bucket: ConflictCandidateV1[] = [];
    for (let i = 0; i < uniquePositions.length; i++) {
      for (let j = i + 1; j < uniquePositions.length; j++) {
        const a = uniquePositions[i]!;
        const b = uniquePositions[j]!;
        const posA = a.localeCompare(b) <= 0 ? a : b;
        const posB = a.localeCompare(b) <= 0 ? b : a;

        const edgeId = `ed_${sha256Hex(JSON.stringify({
          subject_entity: node.subject_entity,
          axis: node.axis,
          position_a: posA,
          position_b: posB,
        })).slice(0, 16)}`;

        const claimsA = node.positions.find(p => p.position === posA)?.claims ?? [];
        const claimsB = node.positions.find(p => p.position === posB)?.claims ?? [];
        const claimIds = stableSortEnabled
          ? [...claimsA.map(c => c.claim_id), ...claimsB.map(c => c.claim_id)].sort((x, y) => x.localeCompare(y))
          : [...claimsA.map(c => c.claim_id), ...claimsB.map(c => c.claim_id)];

        const countA = positionCount.get(posA) ?? claimsA.length;
        const countB = positionCount.get(posB) ?? claimsB.length;
        const balance = (countA > 0 && countB > 0) ? clamp01(Math.min(countA, countB) / Math.max(countA, countB)) : 0;

        const vecA = positionVec.get(posA) ?? buildSparseVector(positionText.get(posA) ?? '', EMBEDDING_DIM);
        const vecB = positionVec.get(posB) ?? buildSparseVector(positionText.get(posB) ?? '', EMBEDDING_DIM);
        const embeddingSim = clamp01((dotSparse(vecA, vecB) + 1) / 2);

        const textA = positionText.get(posA) ?? '';
        const textB = positionText.get(posB) ?? '';
        const explanation = tokenOverlapExplanation(textA, textB);
        const retrievalPriorHits = uniqueStrings([
          ...claimsA.flatMap(claim => claim.retrieval_prior?.hits ?? []),
          ...claimsB.flatMap(claim => claim.retrieval_prior?.hits ?? []),
        ]);
        const usedRetrievalPrior = retrievalPriorHits.length > 0;
        const priorBoost = usedRetrievalPrior ? 0.1 : 0;
        const baselineRelation: EdgeRelation = 'unclear';
        const baselineConfidence = usedRetrievalPrior ? 0.3 : 0.25;
        const score = (0.5 * explanation.token_overlap_ratio) + (0.5 * embeddingSim) + (0.3 * balance) + priorBoost;

        bucket.push({
          version: 1,
          edge_id: edgeId,
          subject_entity: node.subject_entity,
          axis: node.axis,
          position_a: posA,
          position_b: posB,
          score,
          retrieval_explanation: explanation,
          candidate_provenance: {
            retrieval_strategy: 'semantic_similarity',
            used_retrieval_prior: usedRetrievalPrior,
            retrieval_prior_sources: usedRetrievalPrior ? ['provider_local_lexicon'] : [],
            retrieval_prior_hits: retrievalPriorHits,
          },
          embedding_similarity: embeddingSim,
          support_balance: balance,
          claims_a_count: countA,
          claims_b_count: countB,
          baseline_relation: baselineRelation,
          baseline_confidence: baselineConfidence,
          evidence_strength: evidenceStrengthFromCount(Math.min(countA, countB)),
          claim_ids: claimIds,
        });
      }
    }

    bucket.sort((x, y) => (y.score - x.score) || x.edge_id.localeCompare(y.edge_id));
    conflictCandidatesAll.push(...takeTopK(bucket, TOP_K_PER_BUCKET));
  }

  conflictCandidatesAll.sort((x, y) => (y.score - x.score) || x.edge_id.localeCompare(y.edge_id));
  const conflictCandidatesFinal = conflictCandidatesAll.slice(0, maxCandidatesTotal);
  if (conflictCandidatesAll.length > conflictCandidatesFinal.length) {
    warnings.push(`conflict_candidates_truncated:max_candidates_total=${maxCandidatesTotal}`);
  }

  const edgesFinal: ConflictEdgeV1[] = (stableSortEnabled ? stableSort(conflictCandidatesFinal, c => c.edge_id) : conflictCandidatesFinal)
    .map(c => ({
      version: 1,
      edge_id: c.edge_id,
      subject_entity: c.subject_entity,
      axis: c.axis,
      position_a: c.position_a,
      position_b: c.position_b,
      relation: c.baseline_relation,
      confidence: c.baseline_confidence,
      adjudication_category: defaultRationaleForRelation(c.baseline_relation).category,
      rationale: defaultRationaleForRelation(c.baseline_relation),
      evidence_strength: c.evidence_strength,
      claim_ids: c.claim_ids,
      provenance: {
        decision_source: 'fallback_uncertain',
        decision_status: llmMode === 'client' ? 'pending_client' : 'fallback',
        reason_code: llmMode === 'client' ? 'pending_client_response' : 'passthrough_mode',
        used_retrieval_prior: c.candidate_provenance.used_retrieval_prior,
        retrieval_prior_sources: c.candidate_provenance.retrieval_prior_sources,
        retrieval_prior_hits: c.candidate_provenance.retrieval_prior_hits,
      },
    }));

  const candidatesForRequests = [...conflictCandidatesFinal].sort((a, b) => (b.score - a.score) || a.edge_id.localeCompare(b.edge_id));
  const requests: LlmRequestV1[] = candidatesForRequests.slice(0, maxLlmRequests).map(cand => {
    const node = debateNodesFinal.find(n => n.subject_entity === cand.subject_entity && n.axis === cand.axis);
    const claimsA = node?.positions.find(p => p.position === cand.position_a)?.claims ?? [];
    const claimsB = node?.positions.find(p => p.position === cand.position_b)?.claims ?? [];
    const reqId = `rq_${sha256Hex(JSON.stringify({ edge_id: cand.edge_id, prompt_version: promptVersion })).slice(0, 16)}`;

    const claimsAForPrompt = takeTopK(
      (stableSortEnabled ? stableSort(claimsA, x => x.claim_id) : claimsA).map(c => ({
        recid: c.source.recid,
        title: c.source.title,
        year: c.source.year,
        text: c.original_text,
      })),
      5
    );
    const claimsBForPrompt = takeTopK(
      (stableSortEnabled ? stableSort(claimsB, x => x.claim_id) : claimsB).map(c => ({
        recid: c.source.recid,
        title: c.source.title,
        year: c.source.year,
        text: c.original_text,
      })),
      5
    );

    const prompt = buildAdjudicateEdgePrompt({
      prompt_version: promptVersion,
      subject_entity: cand.subject_entity,
      axis: cand.axis,
      position_a: cand.position_a,
      position_b: cand.position_b,
      claims_a: claimsAForPrompt,
      claims_b: claimsBForPrompt,
    });

    return {
      version: 1,
      generated_at: runStartedAt,
      request_id: reqId,
      prompt_version: promptVersion,
      kind: 'adjudicate_edge',
      edge_id: cand.edge_id,
      subject_entity: cand.subject_entity,
      axis: cand.axis,
      position_a: cand.position_a,
      position_b: cand.position_b,
      score: cand.score,
      claims_a: claimsAForPrompt,
      claims_b: claimsBForPrompt,
      prompt,
    };
  });

  const requestsFinal = stableSortEnabled ? stableSort(requests, r => r.request_id) : requests;

  const responseInputs = Array.isArray(params.options.client_llm_responses) ? params.options.client_llm_responses : [];
  const hasClientResponses = llmMode === 'client' && responseInputs.length > 0;

  const byRequestId = new Map<string, LlmRequestV1>();
  for (const r of requestsFinal) byRequestId.set(r.request_id, r);

  const responsesJsonl: Array<Record<string, unknown>> = [];
  const adjudications = new Map<string, ParsedAdjudication>();
  const responseOutcomeByRequest = new Map<string, { decision_status: EdgeDecisionStatus; reason_code: string }>();
  let strictFailure: { request_id: string; error: string } | null = null;

  async function collectInternalResponses(): Promise<ClientLlmResponseInput[]> {
    if (requestsFinal.length === 0) return [];
    const createMessage = ctx.createMessage;
    if (!createMessage) {
      throw invalidParams("llm_mode='internal' requires MCP client sampling support (createMessage)", {
        llm_mode: llmMode,
      });
    }

    const out: ClientLlmResponseInput[] = [];

    for (const req of requestsFinal) {
      try {
        const samplingRequest: CreateMessageRequestParamsBase = {
          messages: [{
            role: 'user',
            content: { type: 'text', text: req.prompt },
          }],
          maxTokens: 800,
          metadata: buildToolSamplingMetadata({
            tool: INSPIRE_CRITICAL_RESEARCH,
            module: 'sem04_theoretical_conflicts',
            promptVersion: req.prompt_version,
            costClass: 'high',
            context: { mode: 'theoretical', request_id: req.request_id, run_id: params.run_id },
          }),
        };

        const response = await createMessage(samplingRequest);
        const rawText = extractSamplingText(response.content);
        out.push({
          request_id: req.request_id,
          json_response: rawText,
          model: response.model,
          created_at: nowIso(),
        });
      } catch (err) {
        if (isSamplingUnavailableError(err)) {
          throw invalidParams("llm_mode='internal' requires MCP client sampling support (createMessage)", {
            llm_mode: llmMode,
            sampling_error: errorMessage(err),
          });
        }

        out.push({
          request_id: req.request_id,
          json_response: '',
          created_at: nowIso(),
          error: errorMessage(err),
        });
      }
    }

    return out;
  }

  const effectiveResponseInputs: ClientLlmResponseInput[] =
    llmMode === 'internal'
      ? await collectInternalResponses()
      : responseInputs;

  const shouldConsumeLlmResponses =
    (llmMode === 'client' && responseInputs.length > 0) ||
    (llmMode === 'internal' && effectiveResponseInputs.length > 0);

  if (shouldConsumeLlmResponses) {
    for (const resp of effectiveResponseInputs) {
      const requestId = String(resp.request_id ?? '').trim();
      if (!requestId) continue;

      if (!byRequestId.has(requestId)) {
        responsesJsonl.push({
          version: 1,
          generated_at: runStartedAt,
          request_id: requestId,
          ok: false,
          parse_error: 'unknown_request_id',
          model: typeof resp.model === 'string' ? resp.model : null,
          created_at: typeof resp.created_at === 'string' ? resp.created_at : null,
          raw: resp.json_response,
        });
        if (!strictFailure) strictFailure = { request_id: requestId, error: 'unknown_request_id' };
        continue;
      }

      const errorField = resp.error;
      if (typeof errorField === 'string' && errorField.trim()) {
        responseOutcomeByRequest.set(requestId, {
          decision_status: 'fallback',
          reason_code: 'llm_call_error',
        });
        responsesJsonl.push({
          version: 1,
          generated_at: runStartedAt,
          request_id: requestId,
          ok: false,
          parse_error: 'llm_call_error',
          error: errorField.trim(),
          model: typeof resp.model === 'string' ? resp.model : null,
          created_at: typeof resp.created_at === 'string' ? resp.created_at : null,
          raw: resp.json_response,
        });
        if (!strictFailure) strictFailure = { request_id: requestId, error: 'llm_call_error' };
        continue;
      }

      const parsed = parseAdjudication(resp.json_response);
      if (!parsed) {
        const err = 'invalid_json_response';
        responseOutcomeByRequest.set(requestId, {
          decision_status: 'fallback',
          reason_code: err,
        });
        responsesJsonl.push({
          version: 1,
          generated_at: runStartedAt,
          request_id: requestId,
          ok: false,
          parse_error: err,
          model: typeof resp.model === 'string' ? resp.model : null,
          created_at: typeof resp.created_at === 'string' ? resp.created_at : null,
          raw: resp.json_response,
        });
        if (!strictFailure) strictFailure = { request_id: requestId, error: err };
        continue;
      }

      adjudications.set(requestId, parsed);
      responseOutcomeByRequest.set(requestId, {
        decision_status: parsed.abstain ? 'abstained' : 'adjudicated',
        reason_code: parsed.abstain ? 'model_abstained' : 'model_response',
      });
      responsesJsonl.push({
        version: 1,
        generated_at: runStartedAt,
        request_id: requestId,
        ok: true,
        parsed,
        model: typeof resp.model === 'string' ? resp.model : null,
        created_at: typeof resp.created_at === 'string' ? resp.created_at : null,
        raw: resp.json_response,
      });
    }
  } else if (llmMode === 'internal' && requestsFinal.length === 0) {
    warnings.push('internal_sampling_skipped:no_llm_requests');
  } else if (llmMode === 'client' && responseInputs.length === 0 && params.options.client_llm_responses) {
    warnings.push('client_llm_responses_ignored:llm_mode_not_client_or_empty');
  }

  // Apply adjudications to edges (best-effort).
  const edgesAdjudicated: ConflictEdgeV1[] = edgesFinal.map(edge => {
    const reqId = `rq_${sha256Hex(JSON.stringify({ edge_id: edge.edge_id, prompt_version: promptVersion })).slice(0, 16)}`;
    const outcome = responseOutcomeByRequest.get(reqId);
    const adjudicated = adjudications.get(reqId);
    if (!outcome && !adjudicated) return edge;
    if (!adjudicated) {
      return {
        ...edge,
        provenance: {
          ...edge.provenance,
          decision_source: 'fallback_uncertain',
          decision_status: outcome?.decision_status ?? edge.provenance.decision_status,
          reason_code: outcome?.reason_code ?? edge.provenance.reason_code,
        },
      };
    }
    return {
      ...edge,
      relation: adjudicated.relation,
      confidence: adjudicated.confidence,
      reasoning: adjudicated.reasoning,
      compatibility_note: adjudicated.compatibility_note,
      adjudication_category: adjudicated.rationale.category,
      rationale: adjudicated.rationale,
      provenance: {
        ...edge.provenance,
        decision_source: 'llm_adjudication',
        decision_status: outcome?.decision_status ?? (adjudicated.abstain ? 'abstained' : 'adjudicated'),
        reason_code: outcome?.reason_code ?? (adjudicated.abstain ? 'model_abstained' : 'model_response'),
      },
    };
  });

  // ── Artifacts (Evidence-first)
  const artifacts: RunArtifactRef[] = [];

  const configSnapshot = {
    prompt_version: promptVersion,
    llm_mode: llmMode,
    strict_llm: strictLlm,
    stable_sort: stableSortEnabled,
    inputs_requested: inputsRequested,
    inputs_effective: inputsEffective,
    max_papers: maxPapers,
    max_claim_candidates_per_paper: maxPerPaper,
    max_candidates_total: maxCandidatesTotal,
    max_llm_requests: maxLlmRequests,
    embedding: { model: `hashing_fnv1a32_dim${EMBEDDING_DIM}_v1`, dim: EMBEDDING_DIM },
    selection: { top_k_per_bucket: TOP_K_PER_BUCKET },
  };

  const metaPayload = {
    version: 1,
    generated_at: runStartedAt,
    run_id: params.run_id,
    project_id: run.project_id,
    config_snapshot: configSnapshot,
    warnings,
    counts: {
      papers_input: params.recids.length,
      papers_used: recidsOrdered.length,
      papers_fetched: papers.length,
      papers_failed: sourceStatus.filter(s => s.stage === 'fetch' && s.status === 'failed').length,
      claim_candidates: candidatesFinal.length,
      claims_normalized: claimsFinal.length,
      conflict_candidates: conflictCandidatesFinal.length,
      edges: edgesFinal.length,
      llm_requests: requestsFinal.length,
      llm_responses: responsesJsonl.length,
      llm_responses_ok: responsesJsonl.filter(r => r.ok === true).length,
      llm_responses_failed: responsesJsonl.filter(r => r.ok === false).length,
    },
  };
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_meta_v1.json', metaPayload));

  const sourceStatusPayload = {
    version: 1,
    generated_at: runStartedAt,
    run_id: params.run_id,
    config_snapshot: configSnapshot,
    sources: sourceStatus,
    summary: {
      papers_input: params.recids.length,
      papers_used: recidsOrdered.length,
      papers_fetched: papers.length,
      papers_failed: sourceStatus.filter(s => s.stage === 'fetch' && s.status === 'failed').length,
      claim_candidates: candidatesFinal.length,
      claims_normalized: claimsFinal.length,
      conflict_candidates: conflictCandidatesFinal.length,
      edges: edgesFinal.length,
      llm_requests: requestsFinal.length,
      llm_responses: responsesJsonl.length,
      llm_mode: llmMode,
    },
    warnings,
  };
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_source_status_v1.json', sourceStatusPayload));

  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_claim_candidates.jsonl', candidatesFinal));
  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_claims_normalized.jsonl', claimsFinal));
  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_conflict_candidates.jsonl', conflictCandidatesFinal));
  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_llm_requests.jsonl', requestsFinal));
  if (responsesJsonl.length > 0) {
    artifacts.push(writeRunJsonlArtifact(
      params.run_id,
      'theoretical_llm_responses.jsonl',
      stableSortEnabled ? stableSort(responsesJsonl, r => String(r.request_id ?? '')) : responsesJsonl
    ));
  }
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_debate_map_v1.json', debateNodesFinal));

  const conflictsPayload = {
    version: 1,
    generated_at: runStartedAt,
    run_id: params.run_id,
    subject_entity: subjectEntityDefault,
    llm_mode: llmMode,
    prompt_version: promptVersion,
    config_snapshot: configSnapshot,
    conflicts: edgesAdjudicated,
    summary: {
      claim_candidates: candidatesFinal.length,
      claims_normalized: claimsFinal.length,
      candidates_evaluated: conflictCandidatesFinal.length,
      edges: edgesAdjudicated.length,
      llm_requests: requestsFinal.length,
      llm_responses_ok: responsesJsonl.filter(r => r.ok === true).length,
      llm_responses_failed: responsesJsonl.filter(r => r.ok === false).length,
    },
    artifacts: {
      meta_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_meta_v1.json'),
      source_status_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_source_status_v1.json'),
      claim_candidates_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_claim_candidates.jsonl'),
      claims_normalized_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_claims_normalized.jsonl'),
      conflict_candidates_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_conflict_candidates.jsonl'),
      llm_requests_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_llm_requests.jsonl'),
      llm_responses_uri: responsesJsonl.length > 0 ? makeHepRunArtifactUri(params.run_id, 'theoretical_llm_responses.jsonl') : null,
      debate_map_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_debate_map_v1.json'),
      conflicts_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_conflicts_v1.json'),
    },
    warnings,
  };
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_conflicts_v1.json', conflictsPayload));

  if (strictLlm && strictFailure) {
    throw invalidParams('LLM response parse failed in strict mode', {
      request_id: strictFailure.request_id,
      error: strictFailure.error,
      prompt_version: promptVersion,
    });
  }

  const nextActions: TheoreticalConflictsResult['next_actions'] = [];
  if (llmMode === 'client' && !hasClientResponses && requestsFinal.length > 0) {
    nextActions.push({
      tool: INSPIRE_CRITICAL_RESEARCH,
      args: {
        mode: 'theoretical',
        recids: recidsOrdered,
        run_id: params.run_id,
        options: {
          ...params.options,
          llm_mode: 'client',
          prompt_version: promptVersion,
          client_llm_responses: [{ request_id: '<from theoretical_llm_requests.jsonl>', json_response: { relation: '...', confidence: 0.9, reasoning: '...', rationale: { summary: '...', assumption_differences: [], observable_differences: [], scope_notes: [] } } }],
        },
      },
      reason: 'Phase B: submit client LLM responses to produce adjudicated Conflict Edges.',
    });
  }

  return {
    run_id: params.run_id,
    project_id: run.project_id,
    manifest_uri: makeHepRunManifestUri(params.run_id),
    artifacts,
    summary: conflictsPayload.summary,
    next_actions: nextActions.length > 0 ? nextActions : undefined,
  };
}
