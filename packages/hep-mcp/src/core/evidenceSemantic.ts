import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_RUN_BUILD_WRITING_EVIDENCE,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from './runs.js';
import { getRunArtifactPath } from './paths.js';
import { writeRunJsonArtifact } from './citations.js';
import { queryProjectEvidence, type EvidenceType, type QueryEvidenceHit, type QueryEvidenceResult } from './evidence.js';
import { buildRetrievalSubstrateSnapshot } from './evidenceRetrievalSubstrate.js';
import { buildEvidenceLocalization, type LocalizationCandidate, type LocalizationCatalogItem } from './evidence-localization/localize.js';
import { parseEmbeddingsJsonl, queryEvidenceByEmbeddings } from './writing/evidence.js';
import { rerankEvidenceCandidates } from './semantics/evidenceRerank.js';

type WritingEvidenceMetaV1 = {
  source_status_artifact?: string;
  latex?: {
    catalog_artifact_name?: string;
    embeddings_artifact_name?: string;
    enrichment_artifact_name?: string;
  };
  pdf?: {
    catalog_uri?: string | null;
    output_prefix?: string;
    embeddings_artifact_name?: string;
    enrichment_artifact_name?: string;
  } | null;
};

type WritingEvidenceSourceStatusV1 = {
  sources?: Array<{
    source_kind?: 'latex' | 'pdf';
    paper_id?: string;
    status?: 'success' | 'failed' | 'skipped';
  }>;
};

type SurfaceLoadStatus = {
  status: 'loaded' | 'missing' | 'invalid';
  item_count: number;
  artifact?: string;
  reason?: string;
};

type SurfaceStatuses = {
  latex: SurfaceLoadStatus;
  pdf: SurfaceLoadStatus;
};

type CatalogItem = LocalizationCatalogItem;

type ParsedEmbedding = ReturnType<typeof parseEmbeddingsJsonl>[number];

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
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
  const out: T[] = [];
  for (const line of lines) out.push(JSON.parse(line) as T);
  return out;
}

function parseEnrichmentJsonl(content: string): Map<string, number> {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
  const scores = new Map<string, number>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const evidenceId = typeof parsed.evidence_id === 'string' ? parsed.evidence_id : null;
      const importance = typeof parsed.importance_score === 'number' ? parsed.importance_score : null;
      if (!evidenceId || importance === null || !Number.isFinite(importance)) continue;
      scores.set(evidenceId, importance);
    } catch {
      continue;
    }
  }
  return scores;
}

function artifactNameFromUri(uri: string | null | undefined): string | null {
  if (!uri || typeof uri !== 'string') return null;
  const marker = '/artifact/';
  const index = uri.indexOf(marker);
  if (index < 0) return null;
  try {
    return decodeURIComponent(uri.slice(index + marker.length));
  } catch {
    return uri.slice(index + marker.length);
  }
}

function resolvePdfPaperId(sourceStatus: WritingEvidenceSourceStatusV1 | null): string | undefined {
  const latexPapers = (sourceStatus?.sources ?? [])
    .filter(source => source.source_kind === 'latex' && source.status === 'success' && typeof source.paper_id === 'string')
    .map(source => source.paper_id as string);
  return latexPapers.length === 1 ? latexPapers[0] : undefined;
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
    localization?: {
      availability: string;
      requested_unit?: string;
      localized_hits: number;
      fallback_hits: number;
      abstained_hits: number;
    };
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
  const includeExplanation = params.include_explanation ?? false;
  const types = params.types;

  const metaPath = getRunArtifactPath(params.run_id, 'writing_evidence_meta_v1.json');
  const meta = safeReadJson<WritingEvidenceMetaV1>(metaPath);
  const sourceStatusPath = meta?.source_status_artifact
    ? getRunArtifactPath(params.run_id, meta.source_status_artifact)
    : null;
  const sourceStatus = sourceStatusPath ? safeReadJson<WritingEvidenceSourceStatusV1>(sourceStatusPath) : null;
  const resolvedPdfPaperId = resolvePdfPaperId(sourceStatus);

  const surfaceStatuses: SurfaceStatuses = {
    latex: { status: 'missing', item_count: 0 },
    pdf: { status: 'missing', item_count: 0 },
  };
  const catalogItems: CatalogItem[] = [];
  const embeddings: ParsedEmbedding[] = [];
  const importanceById = new Map<string, number>();

  const mergeImportance = (scores: Map<string, number>) => {
    for (const [evidenceId, score] of scores.entries()) importanceById.set(evidenceId, score);
  };

  const loadSurface = (surface: {
    kind: 'latex' | 'pdf';
    catalogArtifactName: string | null;
    embeddingsArtifactName: string | null;
    enrichmentArtifactName: string | null;
    defaultPaperId?: string;
  }) => {
    const status = surfaceStatuses[surface.kind];
    status.artifact = surface.catalogArtifactName ?? undefined;
    if (!surface.catalogArtifactName || !surface.embeddingsArtifactName) {
      status.reason = surface.kind === 'pdf' ? 'surface_not_configured' : 'surface_missing_artifact_names';
      return;
    }

    const catalogPath = getRunArtifactPath(params.run_id, surface.catalogArtifactName);
    const embeddingsPath = getRunArtifactPath(params.run_id, surface.embeddingsArtifactName);
    const enrichmentPath = surface.enrichmentArtifactName
      ? getRunArtifactPath(params.run_id, surface.enrichmentArtifactName)
      : null;
    const catalogText = safeReadText(catalogPath);
    const embeddingsText = safeReadText(embeddingsPath);
    if (!catalogText || !embeddingsText) {
      status.reason = !catalogText ? 'missing_catalog' : 'missing_embeddings';
      return;
    }

    try {
      const parsedItems = parseJsonl<CatalogItem>(catalogText).map(item => ({
        ...item,
        paper_id: item.paper_id ?? surface.defaultPaperId,
      }));
      const parsedEmbeddings = parseEmbeddingsJsonl({ content: embeddingsText });
      catalogItems.push(...parsedItems);
      embeddings.push(...parsedEmbeddings);
      if (enrichmentPath) {
        const enrichmentText = safeReadText(enrichmentPath);
        if (enrichmentText) mergeImportance(parseEnrichmentJsonl(enrichmentText));
      }
      status.status = 'loaded';
      status.item_count = parsedItems.length;
    } catch (err) {
      status.status = 'invalid';
      status.reason = err instanceof Error ? err.message : String(err);
    }
  };

  loadSurface({
    kind: 'latex',
    catalogArtifactName: typeof meta?.latex?.catalog_artifact_name === 'string' ? meta.latex.catalog_artifact_name : 'latex_evidence_catalog.jsonl',
    embeddingsArtifactName: typeof meta?.latex?.embeddings_artifact_name === 'string' ? meta.latex.embeddings_artifact_name : 'latex_evidence_embeddings.jsonl',
    enrichmentArtifactName: typeof meta?.latex?.enrichment_artifact_name === 'string' ? meta.latex.enrichment_artifact_name : 'latex_evidence_enrichment.jsonl',
  });

  const pdfOutputPrefix = typeof meta?.pdf?.output_prefix === 'string' && meta.pdf.output_prefix.trim().length > 0
    ? meta.pdf.output_prefix.trim()
    : 'pdf';
  loadSurface({
    kind: 'pdf',
    catalogArtifactName: artifactNameFromUri(meta?.pdf?.catalog_uri) ?? (meta?.pdf ? `${pdfOutputPrefix}_evidence_catalog.jsonl` : null),
    embeddingsArtifactName: typeof meta?.pdf?.embeddings_artifact_name === 'string' ? meta.pdf.embeddings_artifact_name : null,
    enrichmentArtifactName: typeof meta?.pdf?.enrichment_artifact_name === 'string' ? meta.pdf.enrichment_artifact_name : null,
    defaultPaperId: resolvedPdfPaperId,
  });

  const catalogById = new Map<string, CatalogItem>();
  for (const item of catalogItems) catalogById.set(item.evidence_id, item);

  const materializeLocalizationCandidates = (hits: QueryEvidenceHit[]): LocalizationCandidate[] => hits.map(hit => {
    const catalogItem = catalogById.get(hit.evidence_id);
    const item: CatalogItem = catalogItem ?? {
      evidence_id: hit.evidence_id,
      project_id: hit.project_id,
      paper_id: hit.paper_id,
      type: hit.type,
      text: hit.text_preview,
      locator: hit.locator,
    };
    return {
      item,
      score: hit.score,
      semantic_score: hit.semantic_score ?? hit.score,
      token_overlap_ratio: hit.token_overlap_ratio ?? 0,
      importance_score: hit.importance_score,
      matched_tokens: hit.matched_tokens,
    };
  });

  const runLexicalFallback = async (reason: string, data: Record<string, unknown>) => {
    const substrate = buildRetrievalSubstrateSnapshot({
      active_model: 'lexical_fallback',
      embedding_dim: 0,
      semantic_implemented: false,
    });
    const lexical = await queryProjectEvidence({
      project_id: params.project_id,
      paper_id: params.paper_id,
      query: params.query,
      types,
      limit,
    });
    const localization = buildEvidenceLocalization({
      query: params.query,
      types,
      candidates: materializeLocalizationCandidates(lexical.hits),
      allItems: catalogItems.length > 0 ? catalogItems : materializeLocalizationCandidates(lexical.hits).map(candidate => candidate.item),
      limit,
    });
    const localizationById = new Map(localization.selected.map(entry => [entry.candidate.item.evidence_id, entry.localization]));
    const hits: QueryEvidenceHit[] = lexical.hits.map((hit, index) => ({
      ...hit,
      rank: index + 1,
      retrieval_mode: 'lexical_fallback',
      localization: localizationById.get(hit.evidence_id),
    }));
    const result: QueryEvidenceResult = { ...lexical, hits };
    const artifactName = makeArtifactName({
      project_id: params.project_id,
      paper_id: params.paper_id,
      query: params.query,
      types,
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
        substrate,
        surfaces: surfaceStatuses,
      },
      localization: localization.artifact,
      fallback: { used: true, reason, data },
      query: {
        project_id: params.project_id,
        paper_id: params.paper_id ?? null,
        query: params.query,
        types: types ?? null,
        include_explanation: false,
        limit,
      },
      result,
      evidence_ids: result.hits.map(hit => hit.evidence_id),
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
        localization: {
          availability: localization.artifact.availability,
          requested_unit: localization.artifact.requested_unit,
          localized_hits: localization.artifact.telemetry.localized_hits,
          fallback_hits: localization.artifact.telemetry.fallback_hits,
          abstained_hits: localization.artifact.telemetry.abstained_hits,
        },
      },
    };
  };

  if (surfaceStatuses.latex.status !== 'loaded' && surfaceStatuses.pdf.status !== 'loaded') {
    return runLexicalFallback('missing_semantic_prerequisites', {
      surfaces: surfaceStatuses,
      next_actions: [
        {
          tool: HEP_RUN_BUILD_WRITING_EVIDENCE,
          args: { run_id: params.run_id, latex_sources: '<latex_sources[]> (see tool schema)', include_inline_math: true },
          reason: 'Build writing evidence artifacts for semantic retrieval surfaces.',
        },
        {
          tool: HEP_PROJECT_QUERY_EVIDENCE,
          args: { project_id: params.project_id, paper_id: params.paper_id, query: params.query, types, limit },
          reason: 'Use lexical evidence query when semantic surfaces are unavailable.',
        },
      ],
    });
  }

  const dim = embeddings[0]?.vector?.dim;
  if (!dim || typeof dim !== 'number') {
    return runLexicalFallback('invalid_semantic_embeddings_dim', {
      surfaces: surfaceStatuses,
    });
  }
  if (embeddings.some(entry => entry.vector.dim !== dim)) {
    return runLexicalFallback('mixed_semantic_embedding_dims', {
      observed_dims: Array.from(new Set(embeddings.map(entry => entry.vector.dim))),
      surfaces: surfaceStatuses,
    });
  }

  const model = embeddings[0]?.model ?? 'unknown';
  const candidateLimit = Math.max(limit, Math.min(200, Math.max(limit * 8, 50)));
  const scored = queryEvidenceByEmbeddings({
    query: params.query,
    dim,
    embeddings: embeddings.map(entry => ({
      evidence_id: entry.evidence_id,
      vector: entry.vector,
      type: entry.type,
      paper_id: entry.paper_id,
      run_id: entry.run_id,
    })),
    catalog: catalogItems.map(item => ({
      evidence_id: item.evidence_id,
      type: item.type,
      text: item.text,
      locator: item.locator,
      paper_id: item.paper_id,
      project_id: item.project_id,
      run_id: item.run_id,
    })),
    limit: candidateLimit,
    include_explanation: includeExplanation,
    filter: {
      types,
      paper_id: params.paper_id,
      project_id: params.project_id,
    },
  });

  if (scored.length === 0) {
    return runLexicalFallback('no_semantic_hits', {
      model,
      candidate_limit: candidateLimit,
      surfaces: surfaceStatuses,
    });
  }

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
      text: catalogById.get(entry.evidence_id)?.text ?? '',
      importance_score: importanceById.get(entry.evidence_id),
    })),
  });

  const localizationCandidates: LocalizationCandidate[] = reranked.flatMap(entry => {
    const item = catalogById.get(entry.evidence_id);
    if (!item) return [];
    const explanation = explanationById.get(entry.evidence_id);
    return [{
      item,
      score: entry.score,
      semantic_score: entry.semantic_score,
      token_overlap_ratio: entry.token_overlap_ratio,
      importance_score: entry.importance_score,
      matched_tokens: explanation?.matched_tokens,
    }];
  });

  const localization = buildEvidenceLocalization({
    query: params.query,
    types,
    candidates: localizationCandidates,
    allItems: catalogItems.filter(item => item.project_id === params.project_id),
    limit,
  });

  const top = localization.selected[0]?.candidate;
  if (top && top.semantic_score < 0.01 && top.token_overlap_ratio < 0.08 && surfaceStatuses.latex.status === 'loaded') {
    return runLexicalFallback('semantic_low_confidence', {
      model,
      top_semantic_score: top.semantic_score,
      top_token_overlap_ratio: top.token_overlap_ratio,
      surfaces: surfaceStatuses,
    });
  }

  const hits: QueryEvidenceHit[] = localization.selected.map((entry, index) => ({
    evidence_id: entry.candidate.item.evidence_id,
    project_id: entry.candidate.item.project_id,
    paper_id: entry.candidate.item.paper_id ?? params.paper_id ?? resolvedPdfPaperId ?? 'run_pdf',
    type: entry.candidate.item.type,
    score: entry.candidate.score,
    semantic_score: entry.candidate.semantic_score,
    token_overlap_ratio: entry.candidate.token_overlap_ratio,
    importance_score: entry.candidate.importance_score,
    retrieval_mode: 'semantic_reranked',
    rank: index + 1,
    matched_tokens: includeExplanation ? entry.candidate.matched_tokens ?? [] : undefined,
    text_preview: String(entry.candidate.item.text ?? '').slice(0, 400),
    locator: entry.candidate.item.locator,
    localization: entry.localization,
  }));

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
    notes: 'Semantic-first retrieval with deterministic rerank + structure-aware localization.',
    substrate: buildRetrievalSubstrateSnapshot({
      active_model: model,
      embedding_dim: dim,
      semantic_implemented: true,
    }),
    surfaces: surfaceStatuses,
  } as const;

  const artifactName = makeArtifactName({
    project_id: params.project_id,
    paper_id: params.paper_id,
    query: params.query,
    types,
    include_explanation: includeExplanation,
    limit,
  });
  const artifact = writeRunJsonArtifact(params.run_id, artifactName, {
    version: 1,
    generated_at: new Date().toISOString(),
    run_id: params.run_id,
    semantic,
    localization: localization.artifact,
    fallback: { used: false },
    query: {
      project_id: params.project_id,
      paper_id: params.paper_id ?? null,
      query: params.query,
      types: types ?? null,
      include_explanation: includeExplanation,
      limit,
    },
    result,
    evidence_ids: result.hits.map(hit => hit.evidence_id),
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
      localization: {
        availability: localization.artifact.availability,
        requested_unit: localization.artifact.requested_unit,
        localized_hits: localization.artifact.telemetry.localized_hits,
        fallback_hits: localization.artifact.telemetry.fallback_hits,
        abstained_hits: localization.artifact.telemetry.abstained_hits,
      },
    },
  };
}
