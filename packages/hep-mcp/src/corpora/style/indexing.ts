import * as fs from 'fs';
import * as path from 'path';

import { ensureDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';
import { tokenizeHEP } from '../../tools/writing/rag/hepTokenizer.js';

import type { CorpusEvidenceItemV1, CorpusEvidenceType } from './evidence.js';
import { stableJsonStringify } from './json.js';
import { getCorpusDir, getCorpusEvidenceDir, getCorpusIndexDir } from './paths.js';
import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';

type SparseVector = { dim: number; indices: number[]; values: number[] };

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

// BM25 constants (match tools/writing/rag/retriever.ts)
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function idf(term: string, df: Record<string, number>, N: number): number {
  const dfi = df[term] ?? 0;
  return Math.log((N - dfi + 0.5) / (dfi + 0.5) + 1);
}

function bm25Score(docText: string, queryTokens: string[], df: Record<string, number>, avgDocLen: number, N: number): number {
  const docTokens = tokenizeHEP(docText).index_tokens;
  const docLen = docTokens.length;

  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTokens) {
    const termFreq = tf.get(term) ?? 0;
    if (termFreq === 0) continue;
    const termIdf = idf(term, df, N);
    const numerator = termFreq * (BM25_K1 + 1);
    const denominator = termFreq + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / (avgDocLen || 1));
    score += termIdf * (numerator / denominator);
  }
  return score;
}

function listEvidenceCatalogFiles(evidenceDir: string): string[] {
  if (!fs.existsSync(evidenceDir)) return [];
  const dirs = fs.readdirSync(evidenceDir, { withFileTypes: true });
  const out: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(evidenceDir, d.name, 'catalog.jsonl');
    if (fs.existsSync(p)) out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function readJsonlFile<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const out: T[] = [];
  for (const line of lines) out.push(JSON.parse(line) as T);
  return out;
}

export interface BuildCorpusIndexResult {
  style_id: string;
  index_dir: string;
  artifacts: {
    catalog_relpath: string;
    embeddings_relpath: string;
    bm25_relpath: string;
    meta_relpath: string;
  };
  summary: {
    total_items: number;
    by_type: Record<string, number>;
    embedding_dim: number;
    embedding_model: string;
  };
}

export function buildCorpusIndex(params: {
  style_id: string;
  embedding_dim?: number;
  embedding_model?: string;
}): BuildCorpusIndexResult {
  const corpusDir = getCorpusDir(params.style_id);
  const evidenceDir = getCorpusEvidenceDir(params.style_id);
  const indexDir = getCorpusIndexDir(params.style_id);
  ensureDir(indexDir);

  const embeddingDim = Math.max(64, Math.min(params.embedding_dim ?? 512, 4096));
  const embeddingModel = params.embedding_model?.trim() || 'hash-embedding-v1';

  const catalogFiles = listEvidenceCatalogFiles(evidenceDir);
  const items: CorpusEvidenceItemV1[] = [];
  for (const p of catalogFiles) {
    for (const it of readJsonlFile<CorpusEvidenceItemV1>(p)) items.push(it);
  }

  items.sort((a, b) => {
    const recidCmp = a.recid.localeCompare(b.recid);
    if (recidCmp !== 0) return recidCmp;
    const fileCmp = a.locator.file.localeCompare(b.locator.file);
    if (fileCmp !== 0) return fileCmp;
    const offCmp = a.locator.offset - b.locator.offset;
    if (offCmp !== 0) return offCmp;
    return a.evidence_id.localeCompare(b.evidence_id);
  });

  const byType: Record<string, number> = {};
  for (const it of items) byType[it.type] = (byType[it.type] ?? 0) + 1;

  // Build BM25 document frequency
  const df: Record<string, number> = {};
  let totalLength = 0;
  for (const it of items) {
    const tokens = tokenizeHEP(it.text).index_tokens;
    totalLength += tokens.length;
    const unique = new Set(tokens);
    for (const t of unique) df[t] = (df[t] ?? 0) + 1;
  }
  const avgDocLen = items.length > 0 ? totalLength / items.length : 0;

  const bm25Index = {
    version: 1,
    style_id: params.style_id,
    created_at: new Date().toISOString(),
    total_documents: items.length,
    avg_doc_length: avgDocLen,
    df,
  };

  // Write combined catalog
  const catalogName = 'style_evidence_catalog.jsonl';
  const catalogPath = resolvePathWithinParent(indexDir, path.join(indexDir, catalogName), 'corpus_index_catalog');
  fs.writeFileSync(catalogPath, items.map(it => stableJsonStringify(it)).join('\n') + (items.length > 0 ? '\n' : ''), 'utf-8');

  // Write embeddings
  const embeddingsName = 'style_evidence_embeddings.jsonl';
  const embeddingsPath = resolvePathWithinParent(indexDir, path.join(indexDir, embeddingsName), 'corpus_index_embeddings');
  const embeddingsLines = items.map(it => stableJsonStringify({
    evidence_id: it.evidence_id,
    model: embeddingModel,
    vector: buildSparseVector(it.text, embeddingDim),
    type: it.type,
    recid: it.recid,
    paper_key: it.paper_key,
  }));
  fs.writeFileSync(embeddingsPath, embeddingsLines.join('\n') + (embeddingsLines.length > 0 ? '\n' : ''), 'utf-8');

  // Write BM25 JSON
  const bm25Name = 'style_bm25_index.json';
  const bm25Path = resolvePathWithinParent(indexDir, path.join(indexDir, bm25Name), 'corpus_index_bm25');
  fs.writeFileSync(bm25Path, stableJsonStringify(bm25Index, 2) + '\n', 'utf-8');

  // Write meta
  const metaName = 'style_index_meta.json';
  const metaPath = resolvePathWithinParent(indexDir, path.join(indexDir, metaName), 'corpus_index_meta');
  fs.writeFileSync(metaPath, stableJsonStringify({
    version: 1,
    style_id: params.style_id,
    generated_at: new Date().toISOString(),
    artifacts: {
      catalog: catalogName,
      embeddings: embeddingsName,
      bm25: bm25Name,
    },
    embedding: { model: embeddingModel, dim: embeddingDim },
    totals: { items: items.length, by_type: byType },
  }, 2) + '\n', 'utf-8');

  const rel = (p: string) => path.relative(corpusDir, p).split(path.sep).join('/');

  return {
    style_id: params.style_id,
    index_dir: indexDir,
    artifacts: {
      catalog_relpath: rel(catalogPath),
      embeddings_relpath: rel(embeddingsPath),
      bm25_relpath: rel(bm25Path),
      meta_relpath: rel(metaPath),
    },
    summary: {
      total_items: items.length,
      by_type: byType,
      embedding_dim: embeddingDim,
      embedding_model: embeddingModel,
    },
  };
}

type ParsedEmbedding = { evidence_id: string; vector: SparseVector; type?: string; recid?: string; paper_key?: string };

function parseEmbeddingsJsonl(content: string): ParsedEmbedding[] {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const out: ParsedEmbedding[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as any;
    if (!parsed || typeof parsed !== 'object') continue;
    if (typeof parsed.evidence_id !== 'string') continue;
    if (!parsed.vector || typeof parsed.vector !== 'object') continue;
    const v = parsed.vector as any;
    if (typeof v.dim !== 'number' || !Array.isArray(v.indices) || !Array.isArray(v.values)) continue;
    out.push({
      evidence_id: parsed.evidence_id,
      vector: { dim: v.dim, indices: v.indices.map((n: any) => Number(n)), values: v.values.map((n: any) => Number(n)) },
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      recid: typeof parsed.recid === 'string' ? parsed.recid : undefined,
      paper_key: typeof parsed.paper_key === 'string' ? parsed.paper_key : undefined,
    });
  }
  return out;
}

export interface CorpusQueryHit {
  evidence_id: string;
  recid: string;
  type: CorpusEvidenceType;
  score: number;
  text_preview: string;
  locator: any;
}

export interface QueryCorpusIndexResult {
  style_id: string;
  query: string;
  total_candidates: number;
  hits: CorpusQueryHit[];
  summary: {
    returned: number;
    lexical: { implemented: boolean; candidates: number };
    embedding: { implemented: boolean; model: string; dim: number };
    fusion: { method: 'rrf'; k: number };
  };
}

export function queryCorpusIndex(params: {
  style_id: string;
  query: string;
  top_k?: number;
  types?: CorpusEvidenceType[];
  mode?: 'lite' | 'full';
}): QueryCorpusIndexResult {
  const indexDir = getCorpusIndexDir(params.style_id);

  const metaPath = resolvePathWithinParent(indexDir, path.join(indexDir, 'style_index_meta.json'), 'corpus_index_meta');
  const meta = fs.existsSync(metaPath) ? (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as any) : null;
  const catalogName = typeof meta?.artifacts?.catalog === 'string' ? meta.artifacts.catalog : 'style_evidence_catalog.jsonl';
  const embeddingsName = typeof meta?.artifacts?.embeddings === 'string' ? meta.artifacts.embeddings : 'style_evidence_embeddings.jsonl';
  const bm25Name = typeof meta?.artifacts?.bm25 === 'string' ? meta.artifacts.bm25 : 'style_bm25_index.json';

  const catalogPath = resolvePathWithinParent(indexDir, path.join(indexDir, catalogName), 'corpus_index_catalog');
  const embeddingsPath = resolvePathWithinParent(indexDir, path.join(indexDir, embeddingsName), 'corpus_index_embeddings');
  const bm25Path = resolvePathWithinParent(indexDir, path.join(indexDir, bm25Name), 'corpus_index_bm25');

  if (!fs.existsSync(catalogPath) || !fs.existsSync(embeddingsPath) || !fs.existsSync(bm25Path)) {
    return {
      style_id: params.style_id,
      query: params.query,
      total_candidates: 0,
      hits: [],
      summary: {
        returned: 0,
        lexical: { implemented: false, candidates: 0 },
        embedding: { implemented: false, model: 'missing', dim: 0 },
        fusion: { method: 'rrf', k: 60 },
      },
    };
  }

  const topK = Math.max(1, Math.min(params.top_k ?? 10, 50));
  const typeSet = params.types && params.types.length > 0 ? new Set(params.types) : null;
  const mode = params.mode ?? 'full';

  const catalog = readJsonlFile<CorpusEvidenceItemV1>(catalogPath).filter(it => !typeSet || typeSet.has(it.type));
  const bm25 = JSON.parse(fs.readFileSync(bm25Path, 'utf-8')) as any as {
    df: Record<string, number>;
    avg_doc_length: number;
    total_documents: number;
  };

  const queryTokens = tokenizeHEP(params.query).index_tokens;
  const lexicalScores = new Map<string, number>();
  for (const it of catalog) {
    const score = bm25Score(it.text, queryTokens, bm25.df, bm25.avg_doc_length, bm25.total_documents);
    if (score > 0) lexicalScores.set(it.evidence_id, score);
  }
  const lexicalRanked = Array.from(lexicalScores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.min(200, lexicalScores.size));

  let embeddingRanked: Array<[string, number]> = [];
  let embeddingModel = typeof meta?.embedding?.model === 'string' ? meta.embedding.model : 'hash-embedding-v1';
  let embeddingDim = typeof meta?.embedding?.dim === 'number' ? meta.embedding.dim : 0;

  if (mode === 'full') {
    const embeddings = parseEmbeddingsJsonl(fs.readFileSync(embeddingsPath, 'utf-8'))
      .filter(e => !typeSet || (e.type && typeSet.has(e.type as CorpusEvidenceType)));
    embeddingDim = embeddings[0]?.vector?.dim ?? 0;
    embeddingModel = typeof meta?.embedding?.model === 'string' ? meta.embedding.model : embeddingModel;

    const qv = embeddingDim > 0 ? buildSparseVector(params.query, embeddingDim) : { dim: 0, indices: [], values: [] };
    const embeddingScores = new Map<string, number>();

    if (embeddingDim > 0) {
      const byId = new Map<string, SparseVector>();
      for (const e of embeddings) byId.set(e.evidence_id, e.vector);
      for (const it of catalog) {
        const v = byId.get(it.evidence_id);
        if (!v) continue;
        const score = dotSparse(qv, v);
        if (score > 0) embeddingScores.set(it.evidence_id, score);
      }
    }

    embeddingRanked = Array.from(embeddingScores.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.min(200, embeddingScores.size));
  }

  // RRF fusion
  const k = 60;
  const fused = new Map<string, number>();
  const addRanks = (ranked: Array<[string, number]>) => {
    for (let i = 0; i < ranked.length; i++) {
      const id = ranked[i]![0];
      const contrib = 1 / (k + (i + 1));
      fused.set(id, (fused.get(id) ?? 0) + contrib);
    }
  };
  addRanks(lexicalRanked);
  addRanks(embeddingRanked);

  const fusedRanked = Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const byId = new Map(catalog.map(it => [it.evidence_id, it] as const));
  const hits: CorpusQueryHit[] = [];
  for (const [id, score] of fusedRanked.slice(0, topK)) {
    const it = byId.get(id);
    if (!it) continue;
    hits.push({
      evidence_id: it.evidence_id,
      recid: it.recid,
      type: it.type,
      score,
      text_preview: it.text.slice(0, 240),
      locator: it.locator,
    });
  }

  return {
    style_id: params.style_id,
    query: params.query,
    total_candidates: catalog.length,
    hits,
    summary: {
      returned: hits.length,
      lexical: { implemented: true, candidates: lexicalRanked.length },
      embedding: { implemented: mode === 'full' && embeddingDim > 0, model: embeddingModel, dim: embeddingDim },
      fusion: { method: 'rrf', k },
    },
  };
}
