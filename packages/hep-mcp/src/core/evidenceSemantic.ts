import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_RUN_BUILD_WRITING_EVIDENCE,
  invalidParams,
} from '@autoresearch/shared';
import type { LatexLocatorV1, PdfLocatorV1 } from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from './runs.js';
import { getRunArtifactPath } from './paths.js';
import { writeRunJsonArtifact } from './citations.js';
import { queryProjectEvidence, type EvidenceType, type QueryEvidenceHit, type QueryEvidenceResult } from './evidence.js';
import { parseEmbeddingsJsonl, queryEvidenceByEmbeddings } from './writing/evidence.js';
import { rerankEvidenceCandidates } from './semantics/evidenceRerank.js';

type WritingEvidenceMetaV1 = {
  latex?: {
    catalog_artifact_name?: string;
    embeddings_artifact_name?: string;
    enrichment_artifact_name?: string;
  };
};

function sha256HexString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function makeArtifactName(params: {
  project_id: string;
  paper_id?: string;
  query: string;
  types?: EvidenceType[];
  include_explanation: boolean;
  limit: number;
}): string {
  const material = JSON.stringify({
    project_id: params.project_id,
    paper_id: params.paper_id ?? null,
    query: params.query,
    types: params.types ?? null,
    include_explanation: params.include_explanation,
    limit: params.limit,
  });
  return `evidence_semantic_query_${sha256HexString(material).slice(0, 16)}.json`;
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function safeReadText(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function parseJsonl<T>(content: string): T[] {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const out: T[] = [];
  for (const line of lines) {
    out.push(JSON.parse(line) as T);
  }
  return out;
}

function parseEnrichmentJsonl(content: string): Map<string, number> {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const scores = new Map<string, number>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const evidenceId = typeof parsed.evidence_id === 'string' ? parsed.evidence_id : null;
      const importance = typeof parsed.importance_score === 'number' ? parsed.importance_score : null;
      if (!evidenceId || importance === null) continue;
      if (!Number.isFinite(importance)) continue;
      scores.set(evidenceId, importance);
    } catch {
      continue;
    }
  }
  return scores;
}

export async function queryProjectEvidenceSemantic(params: {
  run_id: string;
  project_id: string;
  paper_id?: string;
  query: string;
  types?: EvidenceType[];
  limit?: number;
  include_explanation?: boolean;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: {
    total_hits: number;
    returned: number;
    semantic: { implemented: boolean; model?: string; source?: string };
    explanation_included: boolean;
  };
}> {
  const run = getRun(params.run_id);
  if (run.project_id !== params.project_id) {
    throw invalidParams('run_id does not belong to project_id', {
      run_id: params.run_id,
      run_project_id: run.project_id,
      project_id: params.project_id,
    });
  }

  const limit = Math.max(1, Math.min(params.limit ?? 10, 150));
  const types = params.types;
  const includeExplanation = params.include_explanation ?? false;

  const metaPath = getRunArtifactPath(params.run_id, 'writing_evidence_meta_v1.json');
  const meta = safeReadJson<WritingEvidenceMetaV1>(metaPath);
  const latexCatalogName = typeof meta?.latex?.catalog_artifact_name === 'string'
    ? meta.latex.catalog_artifact_name
    : 'latex_evidence_catalog.jsonl';
  const latexEmbeddingsName = typeof meta?.latex?.embeddings_artifact_name === 'string'
    ? meta.latex.embeddings_artifact_name
    : 'latex_evidence_embeddings.jsonl';
  const latexEnrichmentName = typeof meta?.latex?.enrichment_artifact_name === 'string'
    ? meta.latex.enrichment_artifact_name
    : 'latex_evidence_enrichment.jsonl';

  const catalogPath = getRunArtifactPath(params.run_id, latexCatalogName);
  const embeddingsPath = getRunArtifactPath(params.run_id, latexEmbeddingsName);
  const enrichmentPath = getRunArtifactPath(params.run_id, latexEnrichmentName);
  const catalogText = safeReadText(catalogPath);
  const embeddingsText = safeReadText(embeddingsPath);
  const enrichmentText = safeReadText(enrichmentPath);

  const runLexicalFallback = async (reason: string, data: Record<string, unknown>) => {
    const lexical = await queryProjectEvidence({
      project_id: params.project_id,
      paper_id: params.paper_id,
      query: params.query,
      types: params.types,
      limit,
    });
    const hits: QueryEvidenceHit[] = lexical.hits.map((hit, index) => ({
      ...hit,
      rank: index + 1,
      retrieval_mode: 'lexical_fallback',
    }));
    const result: QueryEvidenceResult = {
      ...lexical,
      hits,
    };

    const artifactName = makeArtifactName({
      project_id: params.project_id,
      paper_id: params.paper_id,
      query: params.query,
      types: params.types,
      include_explanation: includeExplanation,
      limit,
    });

    const artifact = writeRunJsonArtifact(params.run_id, artifactName, {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: params.run_id,
      semantic: {
        implemented: false,
        source: 'lexical_fallback',
        notes: reason,
      },
      fallback: { used: true, reason, data },
      query: {
        project_id: params.project_id,
        paper_id: params.paper_id ?? null,
        query: params.query,
        types: params.types ?? null,
        include_explanation: false,
        limit,
      },
      result,
      evidence_ids: result.hits.map(h => h.evidence_id),
    });

    return {
      run_id: params.run_id,
      project_id: params.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(params.run_id)}/manifest`,
      artifacts: [artifact],
      summary: {
        total_hits: result.total_hits,
        returned: result.hits.length,
        semantic: { implemented: false, source: 'lexical_fallback' },
        explanation_included: false,
      },
    };
  };

  if (!catalogText || !embeddingsText) {
    return runLexicalFallback('missing_semantic_prerequisites', {
      missing: [
        ...(catalogText ? [] : [{ artifact: latexCatalogName, path: catalogPath }]),
        ...(embeddingsText ? [] : [{ artifact: latexEmbeddingsName, path: embeddingsPath }]),
      ],
      next_actions: [
        {
          tool: HEP_RUN_BUILD_WRITING_EVIDENCE,
          args: { run_id: params.run_id, latex_sources: '<latex_sources[]> (see tool schema)', include_inline_math: true },
          reason: 'Build latex_evidence_catalog.jsonl + latex_evidence_embeddings.jsonl for semantic retrieval.',
        },
        {
          tool: HEP_PROJECT_QUERY_EVIDENCE,
          args: { project_id: params.project_id, paper_id: params.paper_id, query: params.query, types: params.types, limit },
          reason: 'Use lexical evidence query (no embeddings required).',
        },
      ],
    });
  }

  type CatalogItem = {
    evidence_id: string;
    project_id: string;
    paper_id: string;
    type: EvidenceType;
    text: string;
    locator: LatexLocatorV1 | PdfLocatorV1;
  };

  let catalogItems: CatalogItem[];
  try {
    catalogItems = parseJsonl<CatalogItem>(catalogText);
  } catch (err) {
    return runLexicalFallback('malformed_semantic_catalog', {
      artifact: latexCatalogName,
      path: catalogPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let embeddings: ReturnType<typeof parseEmbeddingsJsonl>;
  try {
    embeddings = parseEmbeddingsJsonl({ content: embeddingsText });
  } catch (err) {
    return runLexicalFallback('malformed_semantic_embeddings', {
      artifact: latexEmbeddingsName,
      path: embeddingsPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const dim = embeddings[0]?.vector?.dim;
  if (!dim || typeof dim !== 'number') {
    return runLexicalFallback('invalid_semantic_embeddings_dim', {
      artifact: latexEmbeddingsName,
      path: embeddingsPath,
    });
  }

  const model = embeddings[0]?.model ?? 'unknown';

  const candidateLimit = Math.max(limit, Math.min(200, Math.max(limit * 8, 50)));

  const scored = queryEvidenceByEmbeddings({
    query: params.query,
    dim,
    embeddings: embeddings.map(e => ({
      evidence_id: e.evidence_id,
      vector: e.vector,
      type: e.type,
      paper_id: e.paper_id,
      run_id: e.run_id,
    })),
    catalog: catalogItems.map(it => ({
      evidence_id: it.evidence_id,
      type: it.type,
      text: it.text,
      locator: it.locator,
      paper_id: it.paper_id,
      project_id: it.project_id,
    })),
    limit: candidateLimit,
    include_explanation: includeExplanation,
    filter: {
      types,
      paper_id: params.paper_id,
      project_id: params.project_id,
    },
  });

  const byId = new Map<string, CatalogItem>();
  for (const it of catalogItems) byId.set(it.evidence_id, it);

  if (scored.length === 0) {
    return runLexicalFallback('no_semantic_hits', { model, candidate_limit: candidateLimit });
  }

  const importanceById = enrichmentText ? parseEnrichmentJsonl(enrichmentText) : new Map<string, number>();
  const explanationById = new Map<string, { matched_tokens: string[]; token_overlap_ratio: number }>();
  if (includeExplanation) {
    for (const entry of scored) {
      explanationById.set(entry.evidence_id, {
        matched_tokens: entry.matched_tokens ?? [],
        token_overlap_ratio: entry.token_overlap_ratio ?? 0,
      });
    }
  }

  const reranked = rerankEvidenceCandidates({
    query: params.query,
    candidates: scored.map(entry => ({
      evidence_id: entry.evidence_id,
      semantic_score: entry.score,
      text: byId.get(entry.evidence_id)?.text ?? '',
      importance_score: importanceById.get(entry.evidence_id),
    })),
  });

  const top = reranked[0];
  if (top && top.semantic_score < 0.01 && top.token_overlap_ratio < 0.08) {
    return runLexicalFallback('semantic_low_confidence', {
      model,
      top_semantic_score: top.semantic_score,
      top_token_overlap_ratio: top.token_overlap_ratio,
    });
  }

  const hits: QueryEvidenceHit[] = [];
  const limitHits = reranked.slice(0, limit);
  for (let i = 0; i < limitHits.length; i += 1) {
    const entry = limitHits[i]!;
    const item = byId.get(entry.evidence_id);
    if (!item) continue;
    const explanation = includeExplanation ? explanationById.get(entry.evidence_id) : null;
    hits.push({
      evidence_id: item.evidence_id,
      project_id: item.project_id,
      paper_id: item.paper_id,
      type: item.type,
      score: entry.score,
      semantic_score: entry.semantic_score,
      token_overlap_ratio: entry.token_overlap_ratio,
      importance_score: entry.importance_score,
      retrieval_mode: 'semantic_reranked',
      rank: i + 1,
      matched_tokens: includeExplanation ? explanation?.matched_tokens ?? [] : undefined,
      text_preview: String(item.text ?? '').slice(0, 200),
      locator: item.locator,
    });
  }

  const result: QueryEvidenceResult = {
    project_id: params.project_id,
    query: params.query,
    total_hits: scored.length,
    hits,
  };

  const semantic = {
    implemented: true,
    model,
    source: 'run_artifacts',
    notes: 'Semantic-first retrieval with deterministic rerank (local-only).',
  } as const;

  const artifactName = makeArtifactName({
    project_id: params.project_id,
    paper_id: params.paper_id,
    query: params.query,
    types: params.types,
    include_explanation: includeExplanation,
    limit,
  });

  const artifact = writeRunJsonArtifact(params.run_id, artifactName, {
    version: 1,
    generated_at: new Date().toISOString(),
    run_id: params.run_id,
    semantic,
    fallback: { used: false },
    query: {
      project_id: params.project_id,
      paper_id: params.paper_id ?? null,
      query: params.query,
      types: params.types ?? null,
      include_explanation: includeExplanation,
      limit,
    },
    result,
    evidence_ids: result.hits.map(h => h.evidence_id),
  });

  return {
    run_id: params.run_id,
    project_id: params.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(params.run_id)}/manifest`,
    artifacts: [artifact],
    summary: {
      total_hits: result.total_hits,
      returned: result.hits.length,
      semantic: { implemented: true, model: semantic.model ?? 'unknown', source: semantic.source ?? 'run_artifacts' },
      explanation_included: Boolean(includeExplanation),
    },
  };
}
