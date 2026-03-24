import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  INSPIRE_THEORETICAL_CONFLICTS,
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
  parseAdjudication,
  type ConflictRationaleV1,
  type ParsedAdjudication,
} from './theoreticalConflict/adjudication.js';
import {
  type DebateAxis,
  buildAdjudicateEdgePrompt,
  isAdjudicateEdgePromptVersion,
  type AdjudicateEdgePromptVersion,
  type EdgeRelation,
} from './theoreticalConflict/prompts.js';

type InputType = 'title' | 'abstract';
type ClaimType = 'interpretation' | 'prediction' | 'methodology' | 'assumption' | 'measurement';
type EvidenceStrength = 'strong' | 'moderate' | 'weak';
type EdgeDecisionStatus = 'adjudicated' | 'abstained';

export interface TheoreticalConflictsResult {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}

type ClaimCandidateV1 = {
  version: 1;
  claim_candidate_id: string;
  input_type: InputType;
  text: string;
  locator?: { recid: string; field?: 'title' | 'abstract'; evidence_id?: string };
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
    decision_source: 'llm_adjudication';
    decision_status: EdgeDecisionStatus;
    reason_code: string;
  };
};

type ConflictCandidateProvenanceV1 = {
  retrieval_strategy: 'semantic_similarity';
};

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
  evidence_strength: EvidenceStrength;
  claim_ids: string[];
};

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

type SparseVector = { dim: number; indices: number[]; values: number[] };

interface TheoreticalConflictsContext {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
}

type PaperStub = { recid: string; title?: string; year?: number; abstract?: string | null };

function extractSamplingText(content: CreateMessageResult['content']): string {
  if (!content) return '';
  if (Array.isArray(content)) {
    const textParts = content
      .filter((block): block is { type: 'text'; text: string } => Boolean(
        block
        && typeof block === 'object'
        && 'type' in block
        && 'text' in block
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
      ))
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
    msg.includes('not support')
    || msg.includes('unsupported')
    || msg.includes('not available')
    || msg.includes('unavailable')
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
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
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

function evidenceStrengthFromCount(n: number): EvidenceStrength {
  if (n >= 3) return 'strong';
  if (n >= 1) return 'moderate';
  return 'weak';
}

function normalizeText(text: string): string {
  return normalizeTextPreserveUnits(text);
}

function normalizePositionText(text: string): string {
  const normalized = normalizeWhitespace(normalizeText(text)).replace(/[.;:]+$/g, '');
  return normalized.length <= 180 ? normalized.toLowerCase() : `${normalized.slice(0, 177).trim().toLowerCase()}...`;
}

function tokenizeForEmbedding(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-zA-Z0-9_:+-]+/g, ' ')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildSparseVector(text: string, dim: number): SparseVector {
  const counts = new Map<number, number>();
  for (const token of tokenizeForEmbedding(text)) {
    const hash = fnv1a32(token);
    const idx = hash % dim;
    const sign = (hash & 1) === 0 ? 1 : -1;
    counts.set(idx, (counts.get(idx) ?? 0) + sign);
  }

  const entries = Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  const indices: number[] = [];
  const values: number[] = [];
  let norm2 = 0;
  for (const [, value] of entries) norm2 += value * value;
  const norm = norm2 > 0 ? Math.sqrt(norm2) : 1;

  for (const [index, value] of entries) {
    if (value === 0) continue;
    indices.push(index);
    values.push(value / norm);
  }

  return { dim, indices, values };
}

function dotSparse(left: SparseVector, right: SparseVector): number {
  if (left.dim !== right.dim) return 0;
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < left.indices.length && j < right.indices.length) {
    const li = left.indices[i]!;
    const rj = right.indices[j]!;
    if (li === rj) {
      sum += (left.values[i] ?? 0) * (right.values[j] ?? 0);
      i++;
      j++;
    } else if (li < rj) {
      i++;
    } else {
      j++;
    }
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
  for (const token of aTokens) {
    if (!bSet.has(token) || seen.has(token)) continue;
    seen.add(token);
    matched.push(token);
    if (matched.length >= cap) break;
  }

  const denom = Math.max(1, Math.min(aTokens.length, bTokens.length));
  return {
    matched_tokens: matched,
    token_overlap_ratio: clamp01(seen.size / denom),
  };
}

function buildCandidateTexts(paper: PaperStub, inputsEffective: InputType[]): Array<{ input_type: InputType; field?: 'title' | 'abstract'; text: string }> {
  const collected: Array<{ input_type: InputType; field?: 'title' | 'abstract'; text: string }> = [];
  if (inputsEffective.includes('title') && paper.title) {
    collected.push({ input_type: 'title', field: 'title', text: paper.title });
  }
  if (inputsEffective.includes('abstract') && paper.abstract) {
    for (const sentence of splitSentences(paper.abstract)) {
      collected.push({ input_type: 'abstract', field: 'abstract', text: sentence });
    }
  }
  return collected;
}

function buildNormalizedClaims(params: {
  candidates: ClaimCandidateV1[];
  papersByRecid: Map<string, PaperStub>;
  subjectEntity: string;
  stableSortEnabled: boolean;
}): NormalizedClaimV1[] {
  const claims: NormalizedClaimV1[] = params.candidates.map(candidate => {
    const recid = candidate.locator?.recid ?? '';
    const meta = params.papersByRecid.get(recid);
    const position = normalizePositionText(candidate.text);
    const confidence = clamp01(
      0.45
      + (candidate.input_type === 'title' ? 0.1 : 0),
    );
    return {
      version: 1 as const,
      claim_id: `cl_${sha256Hex(JSON.stringify({
        recid,
        subject_entity: params.subjectEntity,
        axis: 'other',
        position,
        text: candidate.text.toLowerCase(),
      })).slice(0, 16)}`,
      claim_type: 'interpretation' as const,
      subject_entity: params.subjectEntity,
      axis: 'other' as const,
      position,
      polarity: 'uncertain' as const,
      original_text: candidate.text,
      source: { recid, title: meta?.title, year: meta?.year },
      confidence,
      evidence_refs: recid ? [{ recid, field: candidate.locator?.field }] : undefined,
    };
  });
  return params.stableSortEnabled ? stableSort(claims, claim => claim.claim_id) : claims;
}

function buildDebateNodes(claims: NormalizedClaimV1[], stableSortEnabled: boolean): DebateNodeV1[] {
  const byKey = new Map<string, NormalizedClaimV1[]>();
  for (const claim of claims) {
    const key = `${claim.subject_entity}__${claim.axis}`;
    const list = byKey.get(key) ?? [];
    list.push(claim);
    byKey.set(key, list);
  }

  const nodes: DebateNodeV1[] = [];
  for (const [key, axisClaims] of byKey.entries()) {
    const [subjectEntity, axisRaw] = key.split('__');
    const axis = (axisRaw ?? 'other') as DebateAxis;
    const byPosition = new Map<string, NormalizedClaimV1[]>();
    for (const claim of axisClaims) {
      const list = byPosition.get(claim.position) ?? [];
      list.push(claim);
      byPosition.set(claim.position, list);
    }

    const positions = Array.from(byPosition.entries()).map(([position, groupedClaims]) => ({
      position,
      claims: stableSortEnabled ? stableSort(groupedClaims, claim => claim.claim_id) : groupedClaims,
      support_strength: evidenceStrengthFromCount(groupedClaims.length),
    }));

    nodes.push({
      version: 1,
      subject_entity: subjectEntity ?? 'unknown',
      axis,
      positions: stableSortEnabled ? stableSort(positions, position => position.position) : positions,
    });
  }

  return stableSortEnabled ? stableSort(nodes, node => `${node.subject_entity}__${node.axis}`) : nodes;
}

function buildConflictCandidates(params: {
  debateNodes: DebateNodeV1[];
  stableSortEnabled: boolean;
  maxCandidatesTotal: number;
}): { candidates: ConflictCandidateV1[]; truncated: boolean } {
  const EMBEDDING_DIM = 256;
  const TOP_K_PER_BUCKET = 20;
  const allCandidates: ConflictCandidateV1[] = [];

  for (const node of params.debateNodes) {
    const positions = uniqueStrings(node.positions.map(position => position.position).filter(position => position !== 'unknown'));
    if (positions.length < 2) continue;

    const positionText = new Map<string, string>();
    const positionVector = new Map<string, SparseVector>();
    const positionCount = new Map<string, number>();

    for (const position of positions) {
      const claims = node.positions.find(entry => entry.position === position)?.claims ?? [];
      const joined = claims.map(claim => claim.original_text).join('\n');
      positionText.set(position, joined);
      positionVector.set(position, buildSparseVector(joined, EMBEDDING_DIM));
      positionCount.set(position, claims.length);
    }

    const bucket: ConflictCandidateV1[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i]!;
        const b = positions[j]!;
        const positionA = a.localeCompare(b) <= 0 ? a : b;
        const positionB = a.localeCompare(b) <= 0 ? b : a;
        const claimsA = node.positions.find(entry => entry.position === positionA)?.claims ?? [];
        const claimsB = node.positions.find(entry => entry.position === positionB)?.claims ?? [];
        const claimIds = params.stableSortEnabled
          ? [...claimsA.map(claim => claim.claim_id), ...claimsB.map(claim => claim.claim_id)].sort((left, right) => left.localeCompare(right))
          : [...claimsA.map(claim => claim.claim_id), ...claimsB.map(claim => claim.claim_id)];
        const countA = positionCount.get(positionA) ?? claimsA.length;
        const countB = positionCount.get(positionB) ?? claimsB.length;
        const balance = (countA > 0 && countB > 0) ? clamp01(Math.min(countA, countB) / Math.max(countA, countB)) : 0;

        const vecA = positionVector.get(positionA) ?? buildSparseVector(positionText.get(positionA) ?? '', EMBEDDING_DIM);
        const vecB = positionVector.get(positionB) ?? buildSparseVector(positionText.get(positionB) ?? '', EMBEDDING_DIM);
        const embeddingSimilarity = clamp01((dotSparse(vecA, vecB) + 1) / 2);
        const textA = positionText.get(positionA) ?? '';
        const textB = positionText.get(positionB) ?? '';
        const retrievalExplanation = tokenOverlapExplanation(textA, textB);
        const score = (0.6 * retrievalExplanation.token_overlap_ratio)
          + (0.35 * embeddingSimilarity)
          + (0.05 * balance);

        bucket.push({
          version: 1,
          edge_id: `ed_${sha256Hex(JSON.stringify({
            subject_entity: node.subject_entity,
            axis: node.axis,
            position_a: positionA,
            position_b: positionB,
          })).slice(0, 16)}`,
          subject_entity: node.subject_entity,
          axis: node.axis,
          position_a: positionA,
          position_b: positionB,
          score,
          retrieval_explanation: retrievalExplanation,
          candidate_provenance: {
            retrieval_strategy: 'semantic_similarity',
          },
          embedding_similarity: embeddingSimilarity,
          support_balance: balance,
          claims_a_count: countA,
          claims_b_count: countB,
          evidence_strength: evidenceStrengthFromCount(Math.min(countA, countB)),
          claim_ids: claimIds,
        });
      }
    }

    bucket.sort((left, right) => (right.score - left.score) || left.edge_id.localeCompare(right.edge_id));
    allCandidates.push(...takeTopK(bucket, TOP_K_PER_BUCKET));
  }

  allCandidates.sort((left, right) => (right.score - left.score) || left.edge_id.localeCompare(right.edge_id));
  const trimmed = allCandidates.slice(0, params.maxCandidatesTotal);
  return {
    candidates: params.stableSortEnabled ? stableSort(trimmed, candidate => candidate.edge_id) : trimmed,
    truncated: allCandidates.length > trimmed.length,
  };
}

function buildLlmRequests(params: {
  candidates: ConflictCandidateV1[];
  debateNodes: DebateNodeV1[];
  promptVersion: AdjudicateEdgePromptVersion;
  generatedAt: string;
  maxRequests: number;
  stableSortEnabled: boolean;
}): LlmRequestV1[] {
  const ranked = [...params.candidates].sort((left, right) => (right.score - left.score) || left.edge_id.localeCompare(right.edge_id));
  const requests: LlmRequestV1[] = ranked.slice(0, params.maxRequests).map(candidate => {
    const node = params.debateNodes.find(entry => entry.subject_entity === candidate.subject_entity && entry.axis === candidate.axis);
    const claimsA = node?.positions.find(position => position.position === candidate.position_a)?.claims ?? [];
    const claimsB = node?.positions.find(position => position.position === candidate.position_b)?.claims ?? [];
    const claimsAForPrompt = takeTopK(
      (params.stableSortEnabled ? stableSort(claimsA, claim => claim.claim_id) : claimsA).map(claim => ({
        recid: claim.source.recid,
        title: claim.source.title,
        year: claim.source.year,
        text: claim.original_text,
      })),
      5,
    );
    const claimsBForPrompt = takeTopK(
      (params.stableSortEnabled ? stableSort(claimsB, claim => claim.claim_id) : claimsB).map(claim => ({
        recid: claim.source.recid,
        title: claim.source.title,
        year: claim.source.year,
        text: claim.original_text,
      })),
      5,
    );
    const requestId = `rq_${sha256Hex(JSON.stringify({ edge_id: candidate.edge_id, prompt_version: params.promptVersion })).slice(0, 16)}`;
    const prompt = buildAdjudicateEdgePrompt({
      prompt_version: params.promptVersion,
      subject_entity: candidate.subject_entity,
      axis: candidate.axis,
      position_a: candidate.position_a,
      position_b: candidate.position_b,
      claims_a: claimsAForPrompt,
      claims_b: claimsBForPrompt,
    });
    return {
      version: 1 as const,
      generated_at: params.generatedAt,
      request_id: requestId,
      prompt_version: params.promptVersion,
      kind: 'adjudicate_edge' as const,
      edge_id: candidate.edge_id,
      subject_entity: candidate.subject_entity,
      axis: candidate.axis,
      position_a: candidate.position_a,
      position_b: candidate.position_b,
      score: candidate.score,
      claims_a: claimsAForPrompt,
      claims_b: claimsBForPrompt,
      prompt,
    };
  });
  return params.stableSortEnabled ? stableSort(requests, request => request.request_id) : requests;
}

async function collectAdjudications(params: {
  requests: LlmRequestV1[];
  ctx: TheoreticalConflictsContext;
  runId: string;
}): Promise<{
  responsesJsonl: Array<Record<string, unknown>>;
  adjudications: Map<string, ParsedAdjudication>;
}> {
  if (params.requests.length === 0) {
    return { responsesJsonl: [], adjudications: new Map<string, ParsedAdjudication>() };
  }
  if (!params.ctx.createMessage) {
    throw invalidParams('Theoretical conflict adjudication requires MCP client sampling support (createMessage).', {
      run_id: params.runId,
    });
  }

  const responsesJsonl: Array<Record<string, unknown>> = [];
  const adjudications = new Map<string, ParsedAdjudication>();

  for (const request of params.requests) {
    let response: CreateMessageResult;
    try {
      response = await params.ctx.createMessage({
        messages: [{
          role: 'user',
          content: { type: 'text', text: request.prompt },
        }],
        maxTokens: 800,
        metadata: buildToolSamplingMetadata({
          tool: INSPIRE_THEORETICAL_CONFLICTS,
          module: 'sem04_theoretical_conflicts',
          promptVersion: request.prompt_version,
          costClass: 'high',
          context: { request_id: request.request_id, run_id: params.runId },
        }),
      });
    } catch (error) {
      if (isSamplingUnavailableError(error)) {
        throw invalidParams('Theoretical conflict adjudication requires MCP client sampling support (createMessage).', {
          run_id: params.runId,
          request_id: request.request_id,
          sampling_error: errorMessage(error),
        });
      }
      throw invalidParams('Theoretical conflict adjudication failed before returning a valid model response.', {
        run_id: params.runId,
        request_id: request.request_id,
        sampling_error: errorMessage(error),
      });
    }

    const parsed = parseAdjudication(extractSamplingText(response.content));
    if (!parsed) {
      throw invalidParams('Theoretical conflict adjudication returned an invalid response.', {
        run_id: params.runId,
        request_id: request.request_id,
      });
    }

    adjudications.set(request.request_id, parsed);
    responsesJsonl.push({
      version: 1,
      generated_at: nowIso(),
      request_id: request.request_id,
      ok: true,
      parsed,
      model: response.model ?? null,
      raw: extractSamplingText(response.content),
    });
  }

  return { responsesJsonl, adjudications };
}

function buildEdges(params: {
  requests: LlmRequestV1[];
  candidatesByEdgeId: Map<string, ConflictCandidateV1>;
  adjudications: Map<string, ParsedAdjudication>;
}): ConflictEdgeV1[] {
  return params.requests.map(request => {
    const candidate = params.candidatesByEdgeId.get(request.edge_id);
    const adjudication = params.adjudications.get(request.request_id);
    if (!candidate || !adjudication) {
      throw new Error(`Missing adjudication payload for ${request.request_id}`);
    }
    return {
      version: 1,
      edge_id: candidate.edge_id,
      subject_entity: candidate.subject_entity,
      axis: candidate.axis,
      position_a: candidate.position_a,
      position_b: candidate.position_b,
      relation: adjudication.relation,
      confidence: adjudication.confidence,
      reasoning: adjudication.reasoning,
      compatibility_note: adjudication.compatibility_note,
      adjudication_category: adjudication.rationale.category,
      rationale: adjudication.rationale,
      evidence_strength: candidate.evidence_strength,
      claim_ids: candidate.claim_ids,
      provenance: {
        decision_source: 'llm_adjudication',
        decision_status: adjudication.abstain ? 'abstained' : 'adjudicated',
        reason_code: adjudication.abstain ? 'model_abstained' : 'model_response',
      },
    };
  });
}

export async function performTheoreticalConflicts(params: {
  run_id: string;
  recids: string[];
  subject_entity?: string;
  inputs?: InputType[];
  max_papers?: number;
  max_claim_candidates_per_paper?: number;
  max_candidates_total?: number;
  max_llm_requests?: number;
  prompt_version?: string;
  stable_sort?: boolean;
}, ctx: TheoreticalConflictsContext = {}): Promise<TheoreticalConflictsResult> {
  const run = getRun(params.run_id);
  const runStartedAt = nowIso();
  const stableSortEnabled = params.stable_sort ?? true;
  const promptVersionRaw = params.prompt_version ?? 'v2';
  if (!isAdjudicateEdgePromptVersion(promptVersionRaw)) {
    throw invalidParams('Unknown prompt_version for theoretical adjudication', {
      prompt_version: promptVersionRaw,
      supported: ['v1', 'v2'],
    });
  }
  const promptVersion = promptVersionRaw as AdjudicateEdgePromptVersion;

  const warnings: string[] = [];
  const inputsRequested: InputType[] = (params.inputs && params.inputs.length > 0)
    ? params.inputs
    : ['title', 'abstract'];
  const inputsEffective = inputsRequested;

  const recids = uniqueStrings(params.recids);
  const maxPapers = Math.max(1, Math.min(params.max_papers ?? recids.length, recids.length));
  const maxPerPaper = Math.max(1, Math.min(params.max_claim_candidates_per_paper ?? 20, 200));
  const maxCandidatesTotal = Math.max(1, Math.min(params.max_candidates_total ?? 200, 5000));
  const maxLlmRequests = Math.max(1, Math.min(params.max_llm_requests ?? maxCandidatesTotal, maxCandidatesTotal));
  const orderedRecids = stableSortEnabled
    ? recids.slice(0, maxPapers).sort((left, right) => left.localeCompare(right))
    : recids.slice(0, maxPapers);
  const subjectEntity = params.subject_entity?.trim() || 'unknown';

  const sourceStatus: Array<{ recid: string; status: 'success' | 'failed'; stage: 'fetch' | 'extract'; error?: string }> = [];
  const papers: PaperStub[] = [];
  for (const recid of orderedRecids) {
    try {
      const paper = await api.getPaper(recid);
      papers.push({ recid, title: paper.title, year: paper.year, abstract: paper.abstract ?? null });
      sourceStatus.push({ recid, status: 'success', stage: 'fetch' });
    } catch (error) {
      sourceStatus.push({ recid, status: 'failed', stage: 'fetch', error: errorMessage(error) });
    }
  }

  const paperMetaByRecid = new Map(papers.map(paper => [paper.recid, paper]));
  const candidatesById = new Set<string>();
  const candidates: ClaimCandidateV1[] = [];
  for (const paper of papers) {
    const perPaper: ClaimCandidateV1[] = [];
    for (const item of buildCandidateTexts(paper, inputsEffective)) {
      const text = normalizeWhitespace(item.text);
      if (!text) continue;
      const claimCandidateId = `cc_${sha256Hex(JSON.stringify({ recid: paper.recid, input_type: item.input_type, text })).slice(0, 16)}`;
      if (candidatesById.has(claimCandidateId)) continue;
      candidatesById.add(claimCandidateId);
      perPaper.push({
        version: 1,
        claim_candidate_id: claimCandidateId,
        input_type: item.input_type,
        text,
        locator: item.field ? { recid: paper.recid, field: item.field } : { recid: paper.recid },
      });
    }
    candidates.push(...perPaper.slice(0, maxPerPaper));
    sourceStatus.push({ recid: paper.recid, status: 'success', stage: 'extract' });
  }

  const candidatesFinal = stableSortEnabled
    ? stableSort(candidates.slice(0, maxPapers * maxPerPaper), candidate => candidate.claim_candidate_id)
    : candidates.slice(0, maxPapers * maxPerPaper);
  const claimsFinal = buildNormalizedClaims({
    candidates: candidatesFinal,
    papersByRecid: paperMetaByRecid,
    subjectEntity,
    stableSortEnabled,
  });
  const debateNodesFinal = buildDebateNodes(claimsFinal, stableSortEnabled);
  const conflictCandidateResult = buildConflictCandidates({
    debateNodes: debateNodesFinal,
    stableSortEnabled,
    maxCandidatesTotal,
  });
  if (conflictCandidateResult.truncated) {
    warnings.push(`conflict_candidates_truncated:max_candidates_total=${maxCandidatesTotal}`);
  }

  const requestsFinal = buildLlmRequests({
    candidates: conflictCandidateResult.candidates,
    debateNodes: debateNodesFinal,
    promptVersion,
    generatedAt: runStartedAt,
    maxRequests: maxLlmRequests,
    stableSortEnabled,
  });
  if (conflictCandidateResult.candidates.length > requestsFinal.length) {
    warnings.push(`llm_requests_truncated:max_llm_requests=${maxLlmRequests}`);
  }

  const { responsesJsonl, adjudications } = await collectAdjudications({
    requests: requestsFinal,
    ctx,
    runId: params.run_id,
  });
  const candidatesByEdgeId = new Map(conflictCandidateResult.candidates.map(candidate => [candidate.edge_id, candidate]));
  const edgesFinal = buildEdges({
    requests: requestsFinal,
    candidatesByEdgeId,
    adjudications,
  });

  const configSnapshot = {
    prompt_version: promptVersion,
    adjudication_mode: 'internal_sampling_only',
    stable_sort: stableSortEnabled,
    inputs_requested: inputsRequested,
    inputs_effective: inputsEffective,
    max_papers: maxPapers,
    max_claim_candidates_per_paper: maxPerPaper,
    max_candidates_total: maxCandidatesTotal,
    max_llm_requests: maxLlmRequests,
    embedding: { model: 'hashing_fnv1a32_dim256_v1', dim: 256 },
    selection: { top_k_per_bucket: 20 },
  };

  const artifacts: RunArtifactRef[] = [];
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_meta_v1.json', {
    version: 1,
    generated_at: runStartedAt,
    run_id: params.run_id,
    project_id: run.project_id,
    config_snapshot: configSnapshot,
    warnings,
    counts: {
      papers_input: params.recids.length,
      papers_used: orderedRecids.length,
      papers_fetched: papers.length,
      papers_failed: sourceStatus.filter(status => status.stage === 'fetch' && status.status === 'failed').length,
      claim_candidates: candidatesFinal.length,
      claims_normalized: claimsFinal.length,
      conflict_candidates: conflictCandidateResult.candidates.length,
      llm_requests: requestsFinal.length,
      llm_responses: responsesJsonl.length,
      edges: edgesFinal.length,
    },
  }));

  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_source_status_v1.json', {
    version: 1,
    generated_at: runStartedAt,
    run_id: params.run_id,
    config_snapshot: configSnapshot,
    sources: sourceStatus,
    summary: {
      papers_input: params.recids.length,
      papers_used: orderedRecids.length,
      papers_fetched: papers.length,
      papers_failed: sourceStatus.filter(status => status.stage === 'fetch' && status.status === 'failed').length,
      claim_candidates: candidatesFinal.length,
      claims_normalized: claimsFinal.length,
      conflict_candidates: conflictCandidateResult.candidates.length,
      llm_requests: requestsFinal.length,
      llm_responses: responsesJsonl.length,
      edges: edgesFinal.length,
    },
    warnings,
  }));

  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_claim_candidates.jsonl', candidatesFinal));
  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_claims_normalized.jsonl', claimsFinal));
  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_conflict_candidates.jsonl', conflictCandidateResult.candidates));
  artifacts.push(writeRunJsonlArtifact(params.run_id, 'theoretical_llm_requests.jsonl', requestsFinal));
  artifacts.push(writeRunJsonlArtifact(
    params.run_id,
    'theoretical_llm_responses.jsonl',
    stableSortEnabled ? stableSort(responsesJsonl, response => String(response.request_id ?? '')) : responsesJsonl,
  ));
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_debate_map_v1.json', debateNodesFinal));

  const conflictsPayload = {
    version: 1,
    generated_at: runStartedAt,
    run_id: params.run_id,
    subject_entity: subjectEntity,
    prompt_version: promptVersion,
    config_snapshot: configSnapshot,
    conflicts: edgesFinal,
    summary: {
      claim_candidates: candidatesFinal.length,
      claims_normalized: claimsFinal.length,
      candidates_evaluated: conflictCandidateResult.candidates.length,
      llm_requests: requestsFinal.length,
      llm_responses_ok: responsesJsonl.filter(response => response.ok === true).length,
      edges: edgesFinal.length,
    },
    artifacts: {
      meta_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_meta_v1.json'),
      source_status_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_source_status_v1.json'),
      claim_candidates_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_claim_candidates.jsonl'),
      claims_normalized_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_claims_normalized.jsonl'),
      conflict_candidates_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_conflict_candidates.jsonl'),
      llm_requests_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_llm_requests.jsonl'),
      llm_responses_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_llm_responses.jsonl'),
      debate_map_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_debate_map_v1.json'),
      conflicts_uri: makeHepRunArtifactUri(params.run_id, 'theoretical_conflicts_v1.json'),
    },
    warnings,
  };
  artifacts.push(writeRunJsonArtifact(params.run_id, 'theoretical_conflicts_v1.json', conflictsPayload));

  return {
    run_id: params.run_id,
    project_id: run.project_id,
    manifest_uri: makeHepRunManifestUri(params.run_id),
    artifacts,
    summary: conflictsPayload.summary,
  };
}
