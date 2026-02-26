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
import { type EvidenceType, type QueryEvidenceResult } from './evidence.js';
import { parseEmbeddingsJsonl, queryEvidenceByEmbeddings } from './writing/evidence.js';

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
  const meta = safeReadJson<any>(metaPath);
  const latexCatalogName = typeof meta?.latex?.catalog_artifact_name === 'string'
    ? meta.latex.catalog_artifact_name
    : 'latex_evidence_catalog.jsonl';
  const latexEmbeddingsName = typeof meta?.latex?.embeddings_artifact_name === 'string'
    ? meta.latex.embeddings_artifact_name
    : 'latex_evidence_embeddings.jsonl';

  const catalogPath = getRunArtifactPath(params.run_id, latexCatalogName);
  const embeddingsPath = getRunArtifactPath(params.run_id, latexEmbeddingsName);
  const catalogText = safeReadText(catalogPath);
  const embeddingsText = safeReadText(embeddingsPath);

  if (!catalogText || !embeddingsText) {
    throw invalidParams('Semantic query requires embeddings. Run hep_run_build_writing_evidence first, or use hep_project_query_evidence (lexical).', {
      run_id: params.run_id,
      project_id: params.project_id,
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
    locator: any;
  };

  let catalogItems: CatalogItem[];
  try {
    catalogItems = parseJsonl<CatalogItem>(catalogText);
  } catch (err) {
    throw invalidParams('Malformed JSONL in semantic evidence catalog (fail-fast).', {
      run_id: params.run_id,
      artifact: latexCatalogName,
      path: catalogPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let embeddings: ReturnType<typeof parseEmbeddingsJsonl>;
  try {
    embeddings = parseEmbeddingsJsonl({ content: embeddingsText });
  } catch (err) {
    throw invalidParams('Malformed JSONL in semantic embeddings artifact (fail-fast).', {
      run_id: params.run_id,
      artifact: latexEmbeddingsName,
      path: embeddingsPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const dim = embeddings[0]?.vector?.dim;
  if (!dim || typeof dim !== 'number') {
    throw invalidParams('Invalid embeddings: missing vector.dim (fail-fast).', {
      run_id: params.run_id,
      artifact: latexEmbeddingsName,
      path: embeddingsPath,
    });
  }

  const model = embeddings[0]?.model ?? 'unknown';

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
    limit,
    include_explanation: includeExplanation,
    filter: {
      types: types as string[] | undefined,
      paper_id: params.paper_id,
      project_id: params.project_id,
    },
  });

  const byId = new Map<string, CatalogItem>();
  for (const it of catalogItems) byId.set(it.evidence_id, it);

  const hits = scored
    .map(s => {
      const it = byId.get(s.evidence_id);
      if (!it) return null;
      return {
        evidence_id: it.evidence_id,
        project_id: it.project_id,
        paper_id: it.paper_id,
        type: it.type,
        score: s.score,
        matched_tokens: includeExplanation ? s.matched_tokens ?? [] : undefined,
        token_overlap_ratio: includeExplanation ? s.token_overlap_ratio ?? 0 : undefined,
        text_preview: String(it.text ?? '').slice(0, 200),
        locator: it.locator,
      };
    })
    .filter(Boolean) as any[];

  const result: QueryEvidenceResult = {
    project_id: params.project_id,
    query: params.query,
    total_hits: hits.length,
    hits,
  };

  const semantic = {
    implemented: true,
    model,
    source: 'run_artifacts',
    notes: 'Semantic search via hashing embeddings (local-only).',
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
