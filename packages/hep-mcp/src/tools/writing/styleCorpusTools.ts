import * as fs from 'fs';
import * as path from 'path';
import { invalidParams } from '@autoresearch/shared';

import * as api from '../../api/client.js';

import { defaultRmpProfile } from '../../corpora/profiles/rmp.js';
import { defaultPrlProfile } from '../../corpora/profiles/prl.js';
import { defaultNatphysProfile } from '../../corpora/profiles/natphys.js';
import { defaultPhysrepProfile } from '../../corpora/profiles/physrep.js';
import {
  ensureCorpusLayout,
  readCorpusManifest,
  readStyleProfile,
  upsertCorpusManifestEntries,
  writeStyleProfile,
} from '../../corpora/style/storage.js';
import { stableJsonStringify } from '../../corpora/style/json.js';
import { getCorporaDir, getCorpusArtifactPath } from '../../corpora/style/paths.js';
import type { StyleCorpusManifestEntry, StyleProfile } from '../../corpora/style/schemas.js';
import { searchAllPapers, buildStratifiedSelection } from '../../corpora/style/selection.js';
import { downloadCorpusPapers } from '../../corpora/style/downloader.js';
import { buildCorpusEvidenceCatalog, type CorpusEvidenceType } from '../../corpora/style/evidence.js';
import { buildCorpusIndex, queryCorpusIndex } from '../../corpora/style/indexing.js';
import { exportStyleCorpusPackToZip, importStyleCorpusPackFromZip } from '../../corpora/style/pack.js';
import { getDataDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';

function isoStampForFileName(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function corpusUri(styleId: string): string {
  return `hep://corpora/${encodeURIComponent(styleId)}`;
}

function corpusProfileUri(styleId: string): string {
  return `${corpusUri(styleId)}/profile`;
}

function corpusManifestUri(styleId: string): string {
  return `${corpusUri(styleId)}/manifest`;
}

function corpusArtifactUri(styleId: string, artifactName: string): string {
  return `${corpusUri(styleId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function writeCorpusJsonArtifact(params: {
  style_id: string;
  artifact_name: string;
  payload: unknown;
}): { name: string; uri: string; file_path: string } {
  ensureCorpusLayout(params.style_id);
  const artifactPath = getCorpusArtifactPath(params.style_id, params.artifact_name);
  fs.writeFileSync(artifactPath, stableJsonStringify(params.payload, 2) + '\n', 'utf-8');
  return { name: params.artifact_name, uri: corpusArtifactUri(params.style_id, params.artifact_name), file_path: artifactPath };
}

function getBuiltInProfile(styleId: string): StyleProfile | null {
  if (styleId === 'rmp') return defaultRmpProfile();
  if (styleId === 'prl') return defaultPrlProfile();
  if (styleId === 'natphys') return defaultNatphysProfile();
  if (styleId === 'physrep') return defaultPhysrepProfile();
  return null;
}

function getOrInitProfile(styleId: string): { profile: StyleProfile; created: boolean } {
  try {
    const profile = readStyleProfile(styleId);
    return { profile, created: false };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as any).code === 'NOT_FOUND') {
      const profile = getBuiltInProfile(styleId);
      if (!profile) throw invalidParams(`Unknown style_id (no built-in profile): ${styleId}`);
      const now = new Date().toISOString();
      writeStyleProfile({
        ...profile,
        created_at: profile.created_at ?? now,
        updated_at: now,
      });
      return { profile: readStyleProfile(styleId), created: true };
    }
    throw err;
  }
}

export async function initStyleCorpusProfile(params: {
  style_id: string;
  overwrite: boolean;
}): Promise<{
  style_id: string;
  profile_uri: string;
  summary: { created: boolean; overwritten: boolean };
}> {
  const styleId = params.style_id;
  ensureCorpusLayout(styleId);

  const builtIn = getBuiltInProfile(styleId);
  if (!builtIn) throw invalidParams(`Unknown style_id (no built-in profile): ${styleId}`);

  const profilePath = path.join(getCorporaDir(), styleId, 'profile.json');
  const exists = fs.existsSync(profilePath);
  if (exists && !params.overwrite) {
    return {
      style_id: styleId,
      profile_uri: corpusProfileUri(styleId),
      summary: { created: false, overwritten: false },
    };
  }

  const now = new Date().toISOString();
  writeStyleProfile({
    ...builtIn,
    created_at: builtIn.created_at ?? now,
    updated_at: now,
  });

  return {
    style_id: styleId,
    profile_uri: corpusProfileUri(styleId),
    summary: { created: !exists, overwritten: exists && params.overwrite },
  };
}

export async function buildStyleCorpusManifest(params: {
  style_id: string;
  target_papers?: number;
  search_sort?: 'mostrecent' | 'mostcited';
  page_size?: number;
  max_results_per_category?: number;
}): Promise<{
  style_id: string;
  manifest_uri: string;
  artifact: { name: string; uri: string };
  summary: {
    target_papers: number;
    existing: number;
    added: number;
    total_after: number;
    candidates: { total_deduped: number; truncated: boolean; warnings: string[] };
    selection: { by_stratum: Record<string, number>; filled: number };
  };
}> {
  const styleId = params.style_id;

  const { profile, created: createdProfile } = getOrInitProfile(styleId);
  ensureCorpusLayout(styleId);

  const existingManifest = readCorpusManifest(styleId);
  const existingRecids = new Set(existingManifest.map(e => e.recid));

  const target = Math.max(1, Math.trunc(params.target_papers ?? profile.defaults.target_papers));
  if (existingManifest.length >= target) {
    const artifact = writeCorpusJsonArtifact({
      style_id: styleId,
      artifact_name: `manifest_build_${isoStampForFileName()}.json`,
      payload: {
        version: 1,
        style_id: styleId,
        generated_at: new Date().toISOString(),
        profile_created: createdProfile,
        target_papers: target,
        status: 'noop',
        notes: 'manifest already meets target_papers; no changes applied',
      },
    });
    return {
      style_id: styleId,
      manifest_uri: corpusManifestUri(styleId),
      artifact: { name: artifact.name, uri: artifact.uri },
      summary: {
        target_papers: target,
        existing: existingManifest.length,
        added: 0,
        total_after: existingManifest.length,
        candidates: { total_deduped: 0, truncated: false, warnings: [] },
        selection: { by_stratum: {}, filled: 0 },
      },
    };
  }

  const needed = target - existingManifest.length;

  const client = { search: api.search };
  const warnings: string[] = [];
  const candidatesByRecid = new Map<string, any>();
  let anyTruncated = false;

  const sort = params.search_sort ?? (profile.selection.sort_within_stratum === 'mostrecent' ? 'mostrecent' : 'mostcited');

  for (const cat of profile.selection.target_categories) {
    const res = await searchAllPapers(client, profile.inspire_query, {
      sort,
      page_size: params.page_size,
      max_results: params.max_results_per_category,
      arxiv_categories: cat,
    });

    if (res.warning) warnings.push(`[${cat}] ${res.warning}`);
    if (res.truncated) anyTruncated = true;

    for (const p of res.papers) {
      const recid = typeof p?.recid === 'string' ? p.recid : '';
      if (!recid) continue;
      if (!candidatesByRecid.has(recid)) {
        candidatesByRecid.set(recid, p);
      }
    }
  }

  const candidates = Array.from(candidatesByRecid.values());

  const { selected, stats } = buildStratifiedSelection({
    profile,
    candidates,
    target_papers: needed,
    existing_recids: existingRecids,
  });

  const newEntries: StyleCorpusManifestEntry[] = selected.map(sel => ({
    version: 1,
    style_id: styleId,
    recid: sel.paper.recid,
    title: sel.paper.title,
    year: sel.paper.year,
    arxiv_id: sel.paper.arxiv_id,
    doi: sel.paper.doi,
    texkey: sel.paper.texkey,
    arxiv_primary_category: sel.paper.arxiv_primary_category,
    arxiv_categories: sel.paper.arxiv_categories,
    citation_count: sel.paper.citation_count,
    selection: {
      strategy: 'stratified_v1',
      category: sel.selection.category ?? undefined,
      year_bin: sel.selection.year_bin ?? undefined,
      rank_in_stratum: sel.selection.rank_in_stratum,
      order_key: sel.selection.order_key,
    },
    status: 'planned',
  }));

  upsertCorpusManifestEntries(styleId, newEntries);

  const artifact = writeCorpusJsonArtifact({
    style_id: styleId,
    artifact_name: `manifest_build_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: styleId,
      generated_at: new Date().toISOString(),
      profile_created: createdProfile,
      target_papers: target,
      existing_entries: existingManifest.length,
      added_entries: newEntries.length,
      selection_stats: stats,
      candidate_stats: {
        total_deduped: candidates.length,
        truncated: anyTruncated,
        warnings,
      },
      added_recids: newEntries.map(e => e.recid),
    },
  });

  return {
    style_id: styleId,
    manifest_uri: corpusManifestUri(styleId),
    artifact: { name: artifact.name, uri: artifact.uri },
    summary: {
      target_papers: target,
      existing: existingManifest.length,
      added: newEntries.length,
      total_after: existingManifest.length + newEntries.length,
      candidates: { total_deduped: candidates.length, truncated: anyTruncated, warnings },
      selection: stats,
    },
  };
}

export async function downloadStyleCorpus(params: {
  style_id: string;
  concurrency?: number;
  force: boolean;
  limit?: number;
}): Promise<{
  style_id: string;
  manifest_uri: string;
  artifact: { name: string; uri: string };
  summary: { attempted: number; downloaded_latex: number; downloaded_pdf: number; skipped: number; errors: number };
}> {
  const styleId = params.style_id;
  ensureCorpusLayout(styleId);

  const manifest = readCorpusManifest(styleId);

  const candidates = params.force
    ? manifest
    : manifest.filter(e => e.status === 'planned' || (e.status === 'error' && (e.error || '').startsWith('download:')));

  const limit = params.limit && params.limit > 0 ? Math.trunc(params.limit) : undefined;

  const res = await downloadCorpusPapers({
    style_id: styleId,
    entries: candidates,
    concurrency: params.concurrency,
    force: params.force,
    limit,
  });

  upsertCorpusManifestEntries(styleId, res.updated);

  const artifact = writeCorpusJsonArtifact({
    style_id: styleId,
    artifact_name: `download_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: styleId,
      generated_at: new Date().toISOString(),
      request: {
        force: params.force,
        limit: limit ?? null,
        concurrency: params.concurrency ?? null,
      },
      selected_entries: candidates.length,
      download_summary: res.summary,
      updated_recids: res.updated.map(e => e.recid),
    },
  });

  return {
    style_id: styleId,
    manifest_uri: corpusManifestUri(styleId),
    artifact: { name: artifact.name, uri: artifact.uri },
    summary: res.summary,
  };
}

export async function buildStyleCorpusEvidence(params: {
  style_id: string;
  concurrency?: number;
  force: boolean;
  limit?: number;
  include_inline_math: boolean;
  max_paragraph_length?: number;
  map_citations_to_inspire: boolean;
}): Promise<{
  style_id: string;
  manifest_uri: string;
  artifact: { name: string; uri: string };
  summary: { attempted: number; built: number; skipped: number; errors: number; evidence_items: number };
}> {
  const styleId = params.style_id;
  ensureCorpusLayout(styleId);

  const manifest = readCorpusManifest(styleId);

  const candidates = params.force
    ? manifest.filter(e => e.status === 'downloaded' || e.status === 'evidence_built' || e.status === 'indexed')
    : manifest.filter(e => e.status === 'downloaded');

  const limit = params.limit && params.limit > 0 ? Math.trunc(params.limit) : null;
  const entries = limit ? candidates.slice(0, limit) : candidates;

  const concurrency = Math.max(1, Math.min(params.concurrency ?? 2, 8));
  const pLimit = (await import('p-limit')).default;
  const gate = pLimit(concurrency);

  let built = 0;
  let skipped = 0;
  let errors = 0;
  let evidenceItems = 0;

  const updated = await Promise.all(entries.map(e => gate(async () => {
    if (!params.force && (e.status === 'evidence_built' || e.status === 'indexed')) {
      skipped += 1;
      return e;
    }
    try {
      const res = await buildCorpusEvidenceCatalog({
        style_id: styleId,
        entry: e,
        include_inline_math: params.include_inline_math,
        max_paragraph_length: params.max_paragraph_length,
        map_citations_to_inspire: params.map_citations_to_inspire,
      });
      if (res.updated_entry.status === 'evidence_built') {
        built += 1;
        evidenceItems += res.summary.total;
      } else {
        errors += 1;
      }
      return res.updated_entry;
    } catch (err) {
      errors += 1;
      return {
        ...e,
        status: 'error',
        error: `evidence:exception:${err instanceof Error ? err.message : String(err)}`,
      } as StyleCorpusManifestEntry;
    }
  })));

  upsertCorpusManifestEntries(styleId, updated);

  const artifact = writeCorpusJsonArtifact({
    style_id: styleId,
    artifact_name: `evidence_build_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: styleId,
      generated_at: new Date().toISOString(),
      request: {
        force: params.force,
        limit: limit ?? null,
        concurrency,
        include_inline_math: params.include_inline_math,
        max_paragraph_length: params.max_paragraph_length ?? null,
        map_citations_to_inspire: params.map_citations_to_inspire,
      },
      summary: {
        attempted: entries.length,
        built,
        skipped,
        errors,
        evidence_items: evidenceItems,
      },
      updated_recids: updated.map(e => e.recid),
    },
  });

  return {
    style_id: styleId,
    manifest_uri: corpusManifestUri(styleId),
    artifact: { name: artifact.name, uri: artifact.uri },
    summary: {
      attempted: entries.length,
      built,
      skipped,
      errors,
      evidence_items: evidenceItems,
    },
  };
}

export async function buildStyleCorpusIndex(params: {
  style_id: string;
  embedding_dim?: number;
  embedding_model?: string;
}): Promise<{
  style_id: string;
  artifact: { name: string; uri: string };
  summary: { total_items: number; by_type: Record<string, number>; embedding_model: string; embedding_dim: number };
}> {
  const styleId = params.style_id;
  ensureCorpusLayout(styleId);

  const built = buildCorpusIndex({
    style_id: styleId,
    embedding_dim: params.embedding_dim,
    embedding_model: params.embedding_model,
  });

  // Optional bookkeeping: mark evidence_built entries as indexed.
  const manifest = readCorpusManifest(styleId);
  const updated = manifest.map(e => (e.status === 'evidence_built' ? { ...e, status: 'indexed' as const } : e));
  upsertCorpusManifestEntries(styleId, updated);

  const artifact = writeCorpusJsonArtifact({
    style_id: styleId,
    artifact_name: `index_build_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: styleId,
      generated_at: new Date().toISOString(),
      build_result: built,
    },
  });

  return {
    style_id: styleId,
    artifact: { name: artifact.name, uri: artifact.uri },
    summary: built.summary,
  };
}

function readCorpusManifestOrNull(styleId: string): StyleCorpusManifestEntry[] | null {
  try {
    return readCorpusManifest(styleId);
  } catch {
    return null;
  }
}

function isIndexPresent(styleId: string): boolean {
  const corporaDir = getCorporaDir();
  const corpusDir = path.join(corporaDir, styleId);
  const metaPath = path.join(corpusDir, 'index', 'style_index_meta.json');
  return fs.existsSync(metaPath);
}

export async function queryStyleCorpus(params: {
  style_id: string;
  query: string;
  top_k: number;
  mode: 'off' | 'lite' | 'full';
  retrieval: string;
  types?: Array<
    'title' | 'abstract' | 'section' | 'paragraph' | 'sentence' | 'equation' | 'figure' | 'table' | 'citation_context'
  >;
  filters?: { year_min?: number; year_max?: number; arxiv_category?: string; only_latex?: boolean };
}): Promise<{
  style_id: string;
  artifact: { name: string; uri: string };
  summary: {
    enabled: boolean;
    returned: number;
    note?: string;
    corpus?: { profile_uri: string; manifest_uri: string };
  };
}> {
  const styleId = params.style_id;
  const topK = Math.max(1, Math.min(params.top_k, 50));

  if (params.mode === 'off') {
    const artifact = writeCorpusJsonArtifact({
      style_id: styleId,
      artifact_name: `query_${isoStampForFileName()}.json`,
      payload: {
        version: 1,
        style_id: styleId,
        generated_at: new Date().toISOString(),
        enabled: false,
        query: params.query,
        note: 'style corpus retrieval disabled (mode=off)',
      },
    });
    return {
      style_id: styleId,
      artifact: { name: artifact.name, uri: artifact.uri },
      summary: { enabled: false, returned: 0, note: 'mode=off' },
    };
  }

  if (!isIndexPresent(styleId)) {
    const artifact = writeCorpusJsonArtifact({
      style_id: styleId,
      artifact_name: `query_${isoStampForFileName()}.json`,
      payload: {
        version: 1,
        style_id: styleId,
        generated_at: new Date().toISOString(),
        enabled: true,
        query: params.query,
        hits: [],
        note:
          'style corpus index not found. Build or import a corpus pack, then build evidence + index. ' +
          'In MCP full mode, run: inspire_style_corpus_init_profile → inspire_style_corpus_build_manifest → inspire_style_corpus_download → inspire_style_corpus_build_evidence → inspire_style_corpus_build_index (or import via inspire_style_corpus_import_pack).',
      },
    });
    return {
      style_id: styleId,
      artifact: { name: artifact.name, uri: artifact.uri },
      summary: {
        enabled: true,
        returned: 0,
        note: 'index missing',
        corpus: { profile_uri: corpusProfileUri(styleId), manifest_uri: corpusManifestUri(styleId) },
      },
    };
  }

  const types: CorpusEvidenceType[] | undefined = (() => {
    if (params.types && params.types.length > 0) return params.types;
    const r = params.retrieval;
    if (r === 'sentence') return ['sentence'];
    if (r === 'paragraph') return ['paragraph'];
    if (r === 'figure') return ['figure'];
    if (r === 'table') return ['table'];
    if (r === 'equation') return ['equation'];
    if (r === 'citation_context') return ['citation_context'];
    if (r === 'section') return ['section'];
    if (r === 'abstract') return ['abstract'];
    if (r === 'title') return ['title'];
    return undefined;
  })();

  const oversample = Math.min(50, Math.max(topK, topK * 5));
  const q = queryCorpusIndex({
    style_id: styleId,
    query: params.query,
    top_k: oversample,
    types,
    mode: params.mode === 'lite' ? 'lite' : 'full',
  });

  const manifest = readCorpusManifestOrNull(styleId);
  const byRecid = new Map<string, StyleCorpusManifestEntry>();
  for (const e of manifest ?? []) byRecid.set(e.recid, e);

  const filters = params.filters ?? {};
  const hits = q.hits
    .map(hit => {
      const entry = byRecid.get(hit.recid) ?? null;
      return {
        ...hit,
        title: entry?.title ?? null,
        year: entry?.year ?? null,
        arxiv_id: entry?.arxiv_id ?? null,
        texkey: entry?.texkey ?? null,
        arxiv_primary_category: entry?.arxiv_primary_category ?? null,
      };
    })
    .filter(hit => {
      const entry = byRecid.get(hit.recid);
      if (filters.year_min !== undefined) {
        if (!entry?.year) return false;
        if (entry.year < filters.year_min) return false;
      }
      if (filters.year_max !== undefined) {
        if (!entry?.year) return false;
        if (entry.year > filters.year_max) return false;
      }
      if (filters.arxiv_category) {
        const cat = filters.arxiv_category;
        const ok = entry?.arxiv_primary_category === cat || Boolean(entry?.arxiv_categories?.includes(cat));
        if (!ok) return false;
      }
      if (filters.only_latex) {
        if (entry?.source?.source_type !== 'latex') return false;
      }
      return true;
    })
    .slice(0, topK);

  const artifact = writeCorpusJsonArtifact({
    style_id: styleId,
    artifact_name: `query_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: styleId,
      generated_at: new Date().toISOString(),
      query: params.query,
      mode: params.mode,
      requested_top_k: topK,
      effective_types: types ?? null,
      filters: params.filters ?? null,
      index_summary: q.summary,
      hits,
    },
  });

  return {
    style_id: styleId,
    artifact: { name: artifact.name, uri: artifact.uri },
    summary: {
      enabled: true,
      returned: hits.length,
      corpus: { profile_uri: corpusProfileUri(styleId), manifest_uri: corpusManifestUri(styleId) },
    },
  };
}

export async function exportStyleCorpusPack(params: {
  style_id: string;
  include_sources: boolean;
  include_pdf: boolean;
  include_evidence: boolean;
  include_index: boolean;
  include_artifacts: boolean;
  compression_level: number;
}): Promise<{
  style_id: string;
  pack: { name: string; uri: string };
  artifact: { name: string; uri: string };
  summary: { sha256: string; bytes: number; files: number; includes: Record<string, boolean> };
}> {
  const styleId = params.style_id;

  const packName = `corpus_pack_${styleId}_${isoStampForFileName()}.zip`;
  const packPath = getCorpusArtifactPath(styleId, packName);

  const res = await exportStyleCorpusPackToZip({
    style_id: styleId,
    zip_path: packPath,
    include_sources: params.include_sources,
    include_pdf: params.include_pdf,
    include_evidence: params.include_evidence,
    include_index: params.include_index,
    include_artifacts: params.include_artifacts,
    compression_level: params.compression_level,
  });

  const report = writeCorpusJsonArtifact({
    style_id: styleId,
    artifact_name: `pack_export_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: styleId,
      generated_at: new Date().toISOString(),
      pack: {
        name: packName,
        uri: corpusArtifactUri(styleId, packName),
        file_path: res.zip_path,
        sha256: res.sha256,
        bytes: res.bytes,
      },
      manifest: res.manifest,
    },
  });

  return {
    style_id: styleId,
    pack: { name: packName, uri: corpusArtifactUri(styleId, packName) },
    artifact: { name: report.name, uri: report.uri },
    summary: {
      sha256: res.sha256,
      bytes: res.bytes,
      files: res.manifest.files.length,
      includes: res.manifest.includes as unknown as Record<string, boolean>,
    },
  };
}

export async function importStyleCorpusPack(params: {
  pack_path: string;
  overwrite: boolean;
}): Promise<{
  style_id: string;
  artifact: { name: string; uri: string };
  summary: { imported_files: number; overwrite: boolean };
}> {
  const dataDir = getDataDir();
  const packPath = resolvePathWithinParent(dataDir, params.pack_path, 'pack_path');

  const res = await importStyleCorpusPackFromZip({
    zip_path: packPath,
    overwrite: params.overwrite,
  });

  const report = writeCorpusJsonArtifact({
    style_id: res.style_id,
    artifact_name: `pack_import_${isoStampForFileName()}.json`,
    payload: {
      version: 1,
      style_id: res.style_id,
      generated_at: new Date().toISOString(),
      pack_path: packPath,
      overwrite: params.overwrite,
      imported_files: res.imported_files,
      manifest: res.manifest,
    },
  });

  return {
    style_id: res.style_id,
    artifact: { name: report.name, uri: report.uri },
    summary: { imported_files: res.imported_files, overwrite: params.overwrite },
  };
}
