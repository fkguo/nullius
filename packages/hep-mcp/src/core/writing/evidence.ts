import * as fs from 'fs';
import {
  invalidParams,
  parseScopedArtifactUri,
  type ArtifactRefV1,
  type EvidenceCatalogItemV1,
  type EvidenceType,
  type PdfLocatorV1,
  type VerificationCoverageV1,
  type VerificationSubjectVerdictV1,
  type WritingReviewBridgeV1,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getProjectPaperEvidenceCatalogPath, getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { HEP_RUN_BUILD_WRITING_EVIDENCE } from '../../tool-names.js';
import { buildProjectEvidenceCatalog } from '../evidence.js';
import { buildRunPdfEvidence, type PdfExtractMode } from '../pdf/evidence.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';
import { createHepRunArtifactRef, makeHepRunManifestUri } from '../runArtifactUri.js';
import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';

type WritingPdfEvidenceKind = 'pdf_page' | 'pdf_region';

function nowIso(): string {
  return new Date().toISOString();
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

async function startRunStep(runId: string, stepName: string): Promise<{ manifestStart: RunManifest; stepIndex: number; step: RunStep }> {
  const now = nowIso();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_BUILD_WRITING_EVIDENCE, args: { run_id: runId } },
    update: current => {
      const step: RunStep = { step: stepName, status: 'in_progress', started_at: now };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: [...current.steps, step],
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
  const stepIndex = manifestStart.steps.length - 1;
  const step = manifestStart.steps[stepIndex]!;
  return { manifestStart, stepIndex, step };
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function finishRunStep(params: {
  runId: string;
  stepIndex: number;
  stepStart: RunStep;
  status: 'done' | 'failed';
  artifacts: RunArtifactRef[];
  notes?: string;
}): Promise<void> {
  const now = nowIso();
  await updateRunManifestAtomic({
    run_id: params.runId,
    tool: { name: HEP_RUN_BUILD_WRITING_EVIDENCE, args: { run_id: params.runId } },
    update: current => {
      const idx = current.steps[params.stepIndex]?.step === params.stepStart.step
        ? params.stepIndex
        : current.steps.findIndex(s => s.step === params.stepStart.step && s.started_at === params.stepStart.started_at);
      if (idx < 0) {
        throw invalidParams('Internal: unable to locate run step for completion (fail-fast)', {
          run_id: params.runId,
          step: params.stepStart.step,
          started_at: params.stepStart.started_at ?? null,
        });
      }
      const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, params.artifacts);
      const step: RunStep = {
        ...current.steps[idx]!,
        status: params.status,
        started_at: current.steps[idx]!.started_at ?? params.stepStart.started_at,
        completed_at: now,
        artifacts: merged,
        notes: params.notes,
      };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: current.steps.map((s, i) => (i === idx ? step : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
}

function writeRunTextArtifact(params: {
  runId: string;
  artifactName: string;
  content: string;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, params.content, 'utf-8');
  return createHepRunArtifactRef(params.runId, params.artifactName, params.mimeType);
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

type SparseVector = { dim: number; indices: number[]; values: number[] };

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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function importanceScoreForLatex(item: EvidenceCatalogItemV1): number {
  const baseByType: Record<EvidenceType, number> = {
    title: 0.35,
    abstract: 0.55,
    section: 0.4,
    paragraph: 0.5,
    equation: 0.9,
    figure: 0.8,
    table: 0.8,
    theorem: 0.8,
    citation_context: 0.6,
    pdf_page: 0.5,
    pdf_region: 0.6,
  };

  const text = item.text ?? '';
  const lenBoost = Math.min(text.length / 800, 1) * 0.1;
  const citeBoost = Array.isArray(item.citations) && item.citations.length > 0 ? 0.05 : 0;
  return clamp01((baseByType[item.type] ?? 0.4) + lenBoost + citeBoost);
}

function importanceScoreForPdf(item: EvidenceCatalogItemV1 & { type: WritingPdfEvidenceKind }): number {
  const baseByType: Record<WritingPdfEvidenceKind, number> = {
    pdf_page: 0.45,
    pdf_region: 0.8,
  };
  const text = item.text ?? '';
  const lenBoost = Math.min(text.length / 1200, 1) * 0.1;
  return clamp01((baseByType[item.type] ?? 0.4) + lenBoost);
}

function readJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const out: T[] = [];
  for (const line of lines) {
    out.push(JSON.parse(line) as T);
  }
  return out;
}

function readBridgeArtifact(runId: string, artifactName: string): WritingReviewBridgeV1 {
  const artifactPath = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Bridge artifact not found', { run_id: runId, artifact_name: artifactName });
  }
  const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw invalidParams('Bridge artifact must be a JSON object', { run_id: runId, artifact_name: artifactName });
  }
  const bridge = parsed as Partial<WritingReviewBridgeV1>;
  if (bridge.schema_version !== 1 || typeof bridge.bridge_kind !== 'string') {
    throw invalidParams('Unsupported bridge artifact shape', { run_id: runId, artifact_name: artifactName });
  }
  return bridge as WritingReviewBridgeV1;
}

type VerificationSubjectVerdictMetaV1 = {
  uri: string;
  subject_id: string;
  status: VerificationSubjectVerdictV1['status'];
  missing_decisive_checks: Array<{
    check_kind: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }>;
};

type VerificationCoverageMetaV1 = {
  uri: string;
  summary: VerificationCoverageV1['summary'];
  missing_decisive_checks: Array<{
    subject_id: string;
    check_kind: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }>;
};

type CollectedVerificationRefs = {
  subjectRefs: Map<string, ArtifactRefV1>;
  checkRunRefs: Map<string, ArtifactRefV1>;
  subjectVerdicts: Map<string, { ref: ArtifactRefV1; meta: VerificationSubjectVerdictMetaV1 }>;
  coverage: Map<string, { ref: ArtifactRefV1; meta: VerificationCoverageMetaV1 }>;
};

function createCollectedVerificationRefs(): CollectedVerificationRefs {
  return {
    subjectRefs: new Map<string, ArtifactRefV1>(),
    checkRunRefs: new Map<string, ArtifactRefV1>(),
    subjectVerdicts: new Map<string, { ref: ArtifactRefV1; meta: VerificationSubjectVerdictMetaV1 }>(),
    coverage: new Map<string, { ref: ArtifactRefV1; meta: VerificationCoverageMetaV1 }>(),
  };
}

function resolveBridgeVerificationArtifactPath(params: {
  runId: string;
  bridgeArtifactName: string;
  ref: ArtifactRefV1;
  refBucket: 'subject_refs' | 'check_run_refs' | 'subject_verdict_refs' | 'coverage_refs';
}): string {
  const parsed = parseScopedArtifactUri(params.ref.uri, { scheme: 'rep', scope: 'runs' });
  if (!parsed) {
    throw invalidParams('Verification artifact ref must use rep://runs/<run_id>/artifact/... URI', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      ref_bucket: params.refBucket,
      uri: params.ref.uri,
    });
  }
  if (parsed.scopeId !== params.runId) {
    throw invalidParams('Verification artifact ref must belong to the current run', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      ref_bucket: params.refBucket,
      uri: params.ref.uri,
      ref_run_id: parsed.scopeId,
    });
  }
  if (!parsed.artifactName.startsWith('artifacts/')) {
    throw invalidParams('Verification artifact ref must resolve under artifacts/', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      ref_bucket: params.refBucket,
      uri: params.ref.uri,
      artifact_name: parsed.artifactName,
    });
  }
  const artifactName = parsed.artifactName.slice('artifacts/'.length);
  if (!artifactName || artifactName.includes('/')) {
    throw invalidParams('Verification artifact ref must resolve to a direct artifacts/<name> file', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      ref_bucket: params.refBucket,
      uri: params.ref.uri,
      artifact_name: parsed.artifactName,
    });
  }
  const artifactPath = getRunArtifactPath(params.runId, artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Verification artifact not found', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      ref_bucket: params.refBucket,
      uri: params.ref.uri,
      artifact_name: artifactName,
    });
  }
  return artifactPath;
}

function recordVerificationRef(map: Map<string, ArtifactRefV1>, ref: ArtifactRefV1): void {
  const existing = map.get(ref.uri);
  if (existing && existing.sha256 !== ref.sha256) {
    throw invalidParams('Duplicate verification artifact URI carried conflicting sha256 digests', {
      uri: ref.uri,
      existing_sha256: existing.sha256,
      incoming_sha256: ref.sha256,
    });
  }
  if (!existing) map.set(ref.uri, ref);
}

function readVerificationArtifactJson(params: {
  runId: string;
  bridgeArtifactName: string;
  ref: ArtifactRefV1;
  refBucket: 'subject_refs' | 'check_run_refs' | 'subject_verdict_refs' | 'coverage_refs';
}): unknown {
  const artifactPath = resolveBridgeVerificationArtifactPath(params);
  const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw invalidParams('Verification artifact must be a JSON object', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      ref_bucket: params.refBucket,
      uri: params.ref.uri,
    });
  }
  return parsed;
}

function readVerificationSubjectVerdictMeta(params: {
  runId: string;
  bridgeArtifactName: string;
  ref: ArtifactRefV1;
}): VerificationSubjectVerdictMetaV1 {
  const parsed = readVerificationArtifactJson({
    runId: params.runId,
    bridgeArtifactName: params.bridgeArtifactName,
    ref: params.ref,
    refBucket: 'subject_verdict_refs',
  }) as Partial<VerificationSubjectVerdictV1>;
  if (
    parsed.schema_version !== 1
    || typeof parsed.subject_id !== 'string'
    || typeof parsed.status !== 'string'
    || !Array.isArray(parsed.missing_decisive_checks)
  ) {
    throw invalidParams('Unsupported verification subject verdict artifact shape', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      uri: params.ref.uri,
    });
  }
  return {
    uri: params.ref.uri,
    subject_id: parsed.subject_id,
    status: parsed.status as VerificationSubjectVerdictV1['status'],
    missing_decisive_checks: parsed.missing_decisive_checks.map(check => {
      if (
        !check
        || typeof check !== 'object'
        || typeof check.check_kind !== 'string'
        || typeof check.reason !== 'string'
        || !['low', 'medium', 'high'].includes(String(check.priority))
      ) {
        throw invalidParams('Unsupported verification subject verdict missing-check shape', {
          run_id: params.runId,
          bridge_artifact_name: params.bridgeArtifactName,
          uri: params.ref.uri,
        });
      }
      return {
        check_kind: check.check_kind,
        reason: check.reason,
        priority: check.priority as 'low' | 'medium' | 'high',
      };
    }),
  };
}

function readVerificationCoverageMeta(params: {
  runId: string;
  bridgeArtifactName: string;
  ref: ArtifactRefV1;
}): VerificationCoverageMetaV1 {
  const parsed = readVerificationArtifactJson({
    runId: params.runId,
    bridgeArtifactName: params.bridgeArtifactName,
    ref: params.ref,
    refBucket: 'coverage_refs',
  }) as Partial<VerificationCoverageV1>;
  const summary = parsed.summary;
  if (
    parsed.schema_version !== 1
    || !summary
    || typeof summary !== 'object'
    || !Array.isArray(parsed.missing_decisive_checks)
  ) {
    throw invalidParams('Unsupported verification coverage artifact shape', {
      run_id: params.runId,
      bridge_artifact_name: params.bridgeArtifactName,
      uri: params.ref.uri,
    });
  }
  return {
    uri: params.ref.uri,
    summary: {
      subjects_total: Number(summary.subjects_total ?? 0),
      subjects_verified: Number(summary.subjects_verified ?? 0),
      subjects_partial: Number(summary.subjects_partial ?? 0),
      subjects_failed: Number(summary.subjects_failed ?? 0),
      subjects_blocked: Number(summary.subjects_blocked ?? 0),
      subjects_not_attempted: Number(summary.subjects_not_attempted ?? 0),
    },
    missing_decisive_checks: parsed.missing_decisive_checks.map(gap => {
      if (
        !gap
        || typeof gap !== 'object'
        || typeof gap.subject_id !== 'string'
        || typeof gap.check_kind !== 'string'
        || typeof gap.reason !== 'string'
        || !['low', 'medium', 'high'].includes(String(gap.priority))
      ) {
        throw invalidParams('Unsupported verification coverage gap shape', {
          run_id: params.runId,
          bridge_artifact_name: params.bridgeArtifactName,
          uri: params.ref.uri,
        });
      }
      return {
        subject_id: gap.subject_id,
        check_kind: gap.check_kind,
        reason: gap.reason,
        priority: gap.priority as 'low' | 'medium' | 'high',
      };
    }),
  };
}

function collectBridgeVerificationRefs(params: {
  runId: string;
  bridgeArtifactName: string;
  verificationRefs: WritingReviewBridgeV1['verification_refs'];
  collected: CollectedVerificationRefs;
}): void {
  for (const ref of params.verificationRefs?.subject_refs ?? []) {
    resolveBridgeVerificationArtifactPath({
      runId: params.runId,
      bridgeArtifactName: params.bridgeArtifactName,
      ref,
      refBucket: 'subject_refs',
    });
    recordVerificationRef(params.collected.subjectRefs, ref);
  }
  for (const ref of params.verificationRefs?.check_run_refs ?? []) {
    resolveBridgeVerificationArtifactPath({
      runId: params.runId,
      bridgeArtifactName: params.bridgeArtifactName,
      ref,
      refBucket: 'check_run_refs',
    });
    recordVerificationRef(params.collected.checkRunRefs, ref);
  }
  for (const ref of params.verificationRefs?.subject_verdict_refs ?? []) {
    const meta = readVerificationSubjectVerdictMeta({
      runId: params.runId,
      bridgeArtifactName: params.bridgeArtifactName,
      ref,
    });
    const existing = params.collected.subjectVerdicts.get(ref.uri);
    if (existing && existing.ref.sha256 !== ref.sha256) {
      throw invalidParams('Duplicate verification subject verdict URI carried conflicting sha256 digests', {
        uri: ref.uri,
        existing_sha256: existing.ref.sha256,
        incoming_sha256: ref.sha256,
      });
    }
    if (!existing) params.collected.subjectVerdicts.set(ref.uri, { ref, meta });
  }
  for (const ref of params.verificationRefs?.coverage_refs ?? []) {
    const meta = readVerificationCoverageMeta({
      runId: params.runId,
      bridgeArtifactName: params.bridgeArtifactName,
      ref,
    });
    const existing = params.collected.coverage.get(ref.uri);
    if (existing && existing.ref.sha256 !== ref.sha256) {
      throw invalidParams('Duplicate verification coverage URI carried conflicting sha256 digests', {
        uri: ref.uri,
        existing_sha256: existing.ref.sha256,
        incoming_sha256: ref.sha256,
      });
    }
    if (!existing) params.collected.coverage.set(ref.uri, { ref, meta });
  }
}

function ensureUniqueByEvidenceId<T extends { evidence_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (!it?.evidence_id) continue;
    if (seen.has(it.evidence_id)) continue;
    seen.add(it.evidence_id);
    out.push(it);
  }
  return out;
}

function sortByEvidenceId<T extends { evidence_id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
}

function buildEmbeddingsJsonl(params: {
  model: string;
  dim: number;
  items: Array<{ evidence_id: string; text: string; type?: string; paper_id?: string; run_id?: string }>;
}): string {
  return params.items
    .map(it => {
      const vector = buildSparseVector(it.text, params.dim);
      return JSON.stringify({
        evidence_id: it.evidence_id,
        model: params.model,
        vector,
        type: it.type,
        paper_id: it.paper_id,
        run_id: it.run_id,
      });
    })
    .join('\n') + '\n';
}

function buildEnrichmentJsonl(params: {
  items: Array<{ evidence_id: string; importance_score: number; type?: string; paper_id?: string; run_id?: string }>;
  labelsFor?: (it: { evidence_id: string; type?: string }) => string[];
}): string {
  return params.items
    .map(it =>
      JSON.stringify({
        evidence_id: it.evidence_id,
        importance_score: it.importance_score,
        labels: params.labelsFor ? params.labelsFor(it) : undefined,
        type: it.type,
        paper_id: it.paper_id,
        run_id: it.run_id,
      })
    )
    .join('\n') + '\n';
}

export type WritingLatexSourceInput = {
  identifier?: string;
  main_tex_path?: string;
  paper_id?: string;
  include_inline_math?: boolean;
  include_cross_refs?: boolean;
  max_paragraph_length?: number;
};

export type WritingPdfSourceInput = {
  paper_id?: string;
  pdf_path?: string;
  pdf_artifact_name?: string;
  zotero_attachment_key?: string;
  fulltext_artifact_name?: string;
  docling_json_path?: string;
  docling_json_artifact_name?: string;
  mode?: PdfExtractMode;
  max_pages?: number;
  render_dpi?: number;
  output_prefix?: string;
  max_regions_total?: number;
};

export type WritingBridgeSourceInput = {
  artifact_name: string;
};

type WritingEvidenceSourceStatusEntryV1 = {
  source_kind: 'latex' | 'pdf' | 'bridge';
  identifier: string;
  paper_id?: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  error_code?: string;
  fallback_used?: string;
  items_extracted?: number;
  duration_ms?: number;
};

type WritingEvidenceSourceStatusV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  sources: WritingEvidenceSourceStatusEntryV1[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    fallback_count: number;
  };
};

function isMcpError(err: unknown): err is { name: 'McpError'; code: string; message: string } {
  return Boolean(err)
    && typeof err === 'object'
    && (err as any).name === 'McpError'
    && typeof (err as any).code === 'string'
    && typeof (err as any).message === 'string';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inferEvidenceErrorCode(kind: 'latex' | 'pdf', err: unknown): string {
  if (isMcpError(err)) {
    if (err.code === 'INVALID_PARAMS') return 'INVALID_PARAMS';
    if (err.code === 'RATE_LIMIT') return kind === 'latex' ? 'ARXIV_RATE_LIMITED' : 'RATE_LIMIT';
    if (err.code === 'NOT_FOUND') return kind === 'latex' ? 'ARXIV_NOT_FOUND' : 'NOT_FOUND';
    if (err.code === 'UNSAFE_FS') return 'UNSAFE_FS';
    if (err.code === 'UPSTREAM_ERROR') return 'UPSTREAM_ERROR';
    if (err.code === 'INTERNAL_ERROR') return 'INTERNAL_ERROR';
  }

  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'TIMEOUT';

  if (kind === 'latex') {
    if (msg.includes('could not resolve arxiv id')) return 'INSPIRE_RESOLVE_ERROR';
    const http429 =
      /\b429\b/.test(msg)
      && (msg.includes('status') || msg.includes('http') || msg.includes('api') || msg.includes('upstream') || msg.includes('request'));
    if (msg.includes('too many requests') || (msg.includes('rate') && msg.includes('limit')) || http429) return 'ARXIV_RATE_LIMITED';
    if (msg.includes('no latex source')) return 'ARXIV_NOT_FOUND';
    if (msg.includes('download failed')) return 'ARXIV_NOT_FOUND';
    if (msg.includes('extraction failed')) return 'LATEX_PARSE_ERROR';
    if (msg.includes('latex') && msg.includes('parse')) return 'LATEX_PARSE_ERROR';
    return 'UNKNOWN';
  }

  if (msg.includes('pdf download failed')) return 'PDF_DOWNLOAD_ERROR';
  if (msg.includes('enoent') || msg.includes('no such file') || msg.includes('not found')) return 'PDF_DOWNLOAD_ERROR';
  if (msg.includes('invalid pdf') || (msg.includes('pdf') && msg.includes('parse'))) return 'PDF_PARSE_ERROR';
  return 'UNKNOWN';
}

function summarizeSourceStatuses(sources: WritingEvidenceSourceStatusEntryV1[]): WritingEvidenceSourceStatusV1['summary'] {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let fallback = 0;
  for (const s of sources) {
    if (s.status === 'success') succeeded += 1;
    else if (s.status === 'failed') failed += 1;
    else skipped += 1;
    if (s.fallback_used) fallback += 1;
  }
  return {
    total: sources.length,
    succeeded,
    failed,
    skipped,
    fallback_count: fallback,
  };
}

function identifierForLatexSource(src: WritingLatexSourceInput, index: number): string {
  const raw = (src.identifier ?? src.main_tex_path ?? '').trim();
  return raw || src.paper_id || `latex_source_${index + 1}`;
}

function identifierForPdfSource(src: WritingPdfSourceInput): string {
  const raw = (
    src.paper_id
    || src.zotero_attachment_key
    || src.pdf_artifact_name
    || src.pdf_path
    || src.fulltext_artifact_name
    || src.docling_json_artifact_name
    || src.docling_json_path
    || 'pdf'
  );
  return String(raw).trim() || 'pdf';
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type ResolvedPdfIdentity =
  | {
      ok: true;
      paper_id: string;
      source: 'explicit_pdf_source' | 'unique_successful_latex';
      same_paper_as_successful_latex: boolean;
    }
  | {
      ok: false;
      error_code: 'PDF_PAPER_ID_REQUIRED' | 'PDF_PAPER_ID_AMBIGUOUS';
      message: string;
    };

function resolvePdfPaperIdentity(params: {
  pdfSource: WritingPdfSourceInput;
  successfulLatexPaperIds: string[];
}): ResolvedPdfIdentity {
  const explicitPaperId = normalizeOptionalString(params.pdfSource.paper_id);
  if (explicitPaperId) {
    return {
      ok: true,
      paper_id: explicitPaperId,
      source: 'explicit_pdf_source',
      same_paper_as_successful_latex: params.successfulLatexPaperIds.includes(explicitPaperId),
    };
  }

  if (params.successfulLatexPaperIds.length === 1) {
    return {
      ok: true,
      paper_id: params.successfulLatexPaperIds[0]!,
      source: 'unique_successful_latex',
      same_paper_as_successful_latex: true,
    };
  }

  if (params.successfulLatexPaperIds.length === 0) {
    return {
      ok: false,
      error_code: 'PDF_PAPER_ID_REQUIRED',
      message: 'pdf_source.paper_id is required when no successful LaTeX paper exists in the same run.',
    };
  }

  return {
    ok: false,
    error_code: 'PDF_PAPER_ID_AMBIGUOUS',
    message: 'pdf_source.paper_id is required when multiple successful LaTeX papers exist in the same run.',
  };
}

type RawPdfCatalogItemV1 = {
  evidence_id?: unknown;
  project_id?: unknown;
  type?: unknown;
  locator?: unknown;
  text?: unknown;
  normalized_text?: unknown;
  meta?: unknown;
};

function normalizePdfPage(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const page = Math.trunc(n);
  if (page < 1) return null;
  return page;
}

function materializePdfWritingCatalogItems(params: {
  rawItems: RawPdfCatalogItemV1[];
  paperId: string;
  defaultProjectId: string;
}): Array<EvidenceCatalogItemV1 & { type: WritingPdfEvidenceKind }> {
  const out: Array<EvidenceCatalogItemV1 & { type: WritingPdfEvidenceKind }> = [];
  for (const raw of params.rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const evidence_id = typeof raw.evidence_id === 'string' ? raw.evidence_id : null;
    if (!evidence_id) continue;

    const project_id = typeof raw.project_id === 'string' ? raw.project_id : params.defaultProjectId;
    const type = raw.type === 'pdf_page' || raw.type === 'pdf_region' ? raw.type : null;
    if (!type) continue;

    const locatorRaw = raw.locator;
    const locatorObj = locatorRaw && typeof locatorRaw === 'object' ? (locatorRaw as Record<string, unknown>) : null;
    const page = normalizePdfPage(locatorObj?.page);
    if (!page) continue;

    const locator: PdfLocatorV1 = { kind: 'pdf', page };
    const text = typeof raw.text === 'string' ? raw.text : '';
    const normalized_text = typeof raw.normalized_text === 'string' ? raw.normalized_text : undefined;
    const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? (raw.meta as Record<string, unknown>) : undefined;

    out.push({
      version: 1,
      evidence_id,
      project_id,
      paper_id: params.paperId,
      type,
      locator,
      text,
      normalized_text,
      meta,
    });
  }
  return out;
}

function buildPdfIdentityErrorData(params: {
  pdfSource: WritingPdfSourceInput;
  successfulLatexPaperIds: string[];
  identifier: string;
}) {
  return {
    pdf_source: {
      identifier: params.identifier,
      paper_id: normalizeOptionalString(params.pdfSource.paper_id) ?? null,
      pdf_path: params.pdfSource.pdf_path ?? null,
      pdf_artifact_name: params.pdfSource.pdf_artifact_name ?? null,
      zotero_attachment_key: params.pdfSource.zotero_attachment_key ?? null,
      fulltext_artifact_name: params.pdfSource.fulltext_artifact_name ?? null,
      docling_json_path: params.pdfSource.docling_json_path ?? null,
      docling_json_artifact_name: params.pdfSource.docling_json_artifact_name ?? null,
    },
    successful_latex_paper_ids: params.successfulLatexPaperIds,
  };
}

export async function buildRunWritingEvidence(params: {
  run_id: string;
  latex_sources: WritingLatexSourceInput[];
  pdf_source?: WritingPdfSourceInput;
  bridge_artifact_names?: string[];
  continue_on_error?: boolean;
  latex_types: EvidenceType[];
  pdf_types: WritingPdfEvidenceKind[];
  max_evidence_items: number;
  embedding_dim: number;
  latex_catalog_artifact_name: string;
  latex_embeddings_artifact_name: string;
  latex_enrichment_artifact_name: string;
  pdf_embeddings_artifact_name: string;
  pdf_enrichment_artifact_name: string;
  budget_hints?: {
    max_evidence_items_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}> {
  if (params.latex_sources.length === 0 && !params.pdf_source && (params.bridge_artifact_names?.length ?? 0) === 0) {
    throw invalidParams('At least one latex_sources entry, pdf_source, or bridge_artifact_names entry is required');
  }

  const runId = params.run_id;
  const run = getRun(runId);
  const stepName = 'writing_evidence_enrichment';
  const { stepIndex, step } = await startRunStep(runId, stepName);

  const continueOnError = params.continue_on_error ?? false;
  const sourceStatusName = 'writing_evidence_source_status.json';
  const sourceStatuses: WritingEvidenceSourceStatusEntryV1[] = [];
  const bridgeSummaries: Array<{ artifact_name: string; bridge_kind: string; task_kind: string; target_node_id: string; produced_artifact_count: number }> = [];
  const collectedVerification = createCollectedVerificationRefs();
  let sourceStatusRef: RunArtifactRef | null = null;

  const artifacts: RunArtifactRef[] = [];
  const warnings: string[] = [];
  const budget = new BudgetTrackerV1();

  const maxEvidenceItems = budget.resolveInt({
    key: 'writing.max_evidence_items',
    dimension: 'breadth',
    unit: 'items',
    arg_path: 'max_evidence_items',
    tool_value: params.max_evidence_items,
    tool_value_present: params.budget_hints?.max_evidence_items_provided ?? true,
    env_var: 'HEP_BUDGET_WRITING_MAX_EVIDENCE_ITEMS',
    default_value: params.max_evidence_items,
    min: 1,
  });

  const writeSourceStatusArtifact = (): RunArtifactRef => {
    if (sourceStatusRef) return sourceStatusRef;
    const payload: WritingEvidenceSourceStatusV1 = {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      sources: sourceStatuses,
      summary: summarizeSourceStatuses(sourceStatuses),
    };
    sourceStatusRef = writeRunJsonArtifact(runId, sourceStatusName, payload);
    artifacts.push(sourceStatusRef);
    return sourceStatusRef;
  };

  try {
    for (const artifactName of params.bridge_artifact_names ?? []) {
      const t0 = Date.now();
      try {
        const bridge = readBridgeArtifact(runId, artifactName);
        collectBridgeVerificationRefs({
          runId,
          bridgeArtifactName: artifactName,
          verificationRefs: bridge.verification_refs,
          collected: collectedVerification,
        });
        bridgeSummaries.push({
          artifact_name: artifactName,
          bridge_kind: bridge.bridge_kind,
          task_kind: bridge.target.task_kind,
          target_node_id: bridge.target.target_node_id,
          produced_artifact_count: bridge.produced_artifact_refs.length,
        });
        sourceStatuses.push({
          source_kind: 'bridge',
          identifier: artifactName,
          status: 'success',
          items_extracted: bridge.produced_artifact_refs.length,
          duration_ms: Date.now() - t0,
        });
      } catch (err) {
        sourceStatuses.push({
          source_kind: 'bridge',
          identifier: artifactName,
          status: 'failed',
          error: errorMessage(err),
          error_code: 'BRIDGE_PARSE_ERROR',
          duration_ms: Date.now() - t0,
        });
        if (!continueOnError) {
          writeSourceStatusArtifact();
          throw err;
        }
      }
    }

    // ── LaTeX sources → project evidence catalogs
    const builtPapers: Array<{ paper_id: string; catalog_path: string }> = [];
    for (let i = 0; i < params.latex_sources.length; i++) {
      const src = params.latex_sources[i]!;
      const identifier = identifierForLatexSource(src, i);
      const t0 = Date.now();
      try {
        if (!src.identifier && !src.main_tex_path) {
          throw invalidParams('latex_sources entry requires identifier or main_tex_path', { latex_source: src });
        }

        const res = await buildProjectEvidenceCatalog({
          project_id: run.project_id,
          identifier: src.identifier,
          main_tex_path: src.main_tex_path,
          paper_id: src.paper_id,
          include_inline_math: src.include_inline_math ?? false,
          include_cross_refs: src.include_cross_refs ?? false,
          max_paragraph_length: src.max_paragraph_length ?? 0,
          budget_hints: {
            max_paragraph_length_provided: src.max_paragraph_length !== undefined,
          },
        });

        builtPapers.push({
          paper_id: res.paper_id,
          // Use project catalog path directly (avoid reading via resources).
          catalog_path: getProjectPaperEvidenceCatalogPath(run.project_id, res.paper_id),
        });

        sourceStatuses.push({
          source_kind: 'latex',
          identifier,
          paper_id: res.paper_id,
          status: 'success',
          items_extracted: res.summary.total,
          duration_ms: Date.now() - t0,
        });
      } catch (err) {
        sourceStatuses.push({
          source_kind: 'latex',
          identifier,
          paper_id: src.paper_id,
          status: 'failed',
          error: errorMessage(err),
          error_code: inferEvidenceErrorCode('latex', err),
          duration_ms: Date.now() - t0,
        });

        if (!continueOnError) {
          for (let j = i + 1; j < params.latex_sources.length; j++) {
            const remaining = params.latex_sources[j]!;
            sourceStatuses.push({
              source_kind: 'latex',
              identifier: identifierForLatexSource(remaining, j),
              paper_id: remaining.paper_id,
              status: 'skipped',
            });
          }
          if (params.pdf_source) {
            sourceStatuses.push({
              source_kind: 'pdf',
              identifier: identifierForPdfSource(params.pdf_source),
              status: 'skipped',
            });
          }
          writeSourceStatusArtifact();
          throw err;
        }
      }
    }

    let pdfBuildResult: Awaited<ReturnType<typeof buildRunPdfEvidence>> | null = null;
    let pdfStatus: WritingEvidenceSourceStatusEntryV1 | null = null;

    const latexItemsRaw = builtPapers.flatMap(p => readJsonlFile<EvidenceCatalogItemV1>(p.catalog_path));
    const latexItemsFiltered = ensureUniqueByEvidenceId(
      latexItemsRaw.filter(it => params.latex_types.includes(it.type))
    );
    const latexItems = sortByEvidenceId(latexItemsFiltered).slice(0, maxEvidenceItems);
    if (latexItemsFiltered.length > latexItems.length) {
      const msg =
        `LaTeX writing evidence truncated at max_evidence_items=${maxEvidenceItems} (available=${latexItemsFiltered.length}, returned=${latexItems.length}).`;
      warnings.push(msg);
      budget.recordHit({
        key: 'writing.max_evidence_items',
        dimension: 'breadth',
        unit: 'items',
        limit: maxEvidenceItems,
        observed: latexItemsFiltered.length,
        action: 'truncate',
        message: msg,
        data: { kind: 'latex', available: latexItemsFiltered.length, returned: latexItems.length },
      });
    }

    const latexCatalogContent = latexItems.map(it => JSON.stringify(it)).join('\n') + '\n';
    const latexCatalogRef = writeRunTextArtifact({
      runId,
      artifactName: params.latex_catalog_artifact_name,
      content: latexCatalogContent,
      mimeType: 'application/x-ndjson',
    });
    artifacts.push(latexCatalogRef);

    const embeddingModel = `hashing_fnv1a32_dim${params.embedding_dim}_v1`;

    const latexEmbeddingsContent = buildEmbeddingsJsonl({
      model: embeddingModel,
      dim: params.embedding_dim,
      items: latexItems.map(it => ({
        evidence_id: it.evidence_id,
        text: it.normalized_text ?? it.text ?? '',
        type: it.type,
        paper_id: it.paper_id,
      })),
    });
    const latexEmbeddingsRef = writeRunTextArtifact({
      runId,
      artifactName: params.latex_embeddings_artifact_name,
      content: latexEmbeddingsContent,
      mimeType: 'application/x-ndjson',
    });
    artifacts.push(latexEmbeddingsRef);

    const latexEnrichmentContent = buildEnrichmentJsonl({
      items: latexItems.map(it => ({
        evidence_id: it.evidence_id,
        importance_score: importanceScoreForLatex(it),
        type: it.type,
        paper_id: it.paper_id,
      })),
      labelsFor: it => (it.type ? [String(it.type)] : []),
    });
    const latexEnrichmentRef = writeRunTextArtifact({
      runId,
      artifactName: params.latex_enrichment_artifact_name,
      content: latexEnrichmentContent,
      mimeType: 'application/x-ndjson',
    });
    artifacts.push(latexEnrichmentRef);

    // ── Optional PDF source → run pdf evidence + embeddings/enrichment
    let pdfCatalogUri: string | undefined;
    if (params.pdf_source) {
      const pdf = params.pdf_source;
      const output_prefix = pdf.output_prefix?.trim() || 'pdf';
      const mode = pdf.mode ?? 'text';

      const pdfIdentifier = identifierForPdfSource(pdf);
      const successfulLatexPaperIds = Array.from(new Set(builtPapers.map(p => p.paper_id)));
      const pdfIdentity = resolvePdfPaperIdentity({
        pdfSource: pdf,
        successfulLatexPaperIds,
      });

      if (!pdfIdentity.ok) {
        sourceStatuses.push({
          source_kind: 'pdf',
          identifier: pdfIdentifier,
          status: 'failed',
          error: pdfIdentity.message,
          error_code: pdfIdentity.error_code,
        });
        if (!continueOnError) {
          writeSourceStatusArtifact();
          throw invalidParams(pdfIdentity.message, buildPdfIdentityErrorData({
            pdfSource: pdf,
            successfulLatexPaperIds,
            identifier: pdfIdentifier,
          }));
        }
      } else if (pdfIdentity.same_paper_as_successful_latex) {
        sourceStatuses.push({
          source_kind: 'pdf',
          identifier: pdfIdentifier,
          paper_id: pdfIdentity.paper_id,
          status: 'skipped',
          error_code: 'PDF_SKIPPED_LATEX_AUTHORITY',
        });
      } else {
        const t0 = Date.now();
        try {
          pdfBuildResult = await buildRunPdfEvidence({
            run_id: runId,
            pdf_path: pdf.pdf_path,
            pdf_artifact_name: pdf.pdf_artifact_name,
            zotero_attachment_key: pdf.zotero_attachment_key,
            fulltext_artifact_name: pdf.fulltext_artifact_name,
            docling_json_path: pdf.docling_json_path,
            docling_json_artifact_name: pdf.docling_json_artifact_name,
            mode,
            max_pages: pdf.max_pages ?? 50,
            render_dpi: pdf.render_dpi ?? 144,
            output_prefix,
            max_regions_total: pdf.max_regions_total,
            budget_hints: {
              max_pages_provided: pdf.max_pages !== undefined,
              max_regions_total_provided: pdf.max_regions_total !== undefined,
            },
          });
          artifacts.push(...pdfBuildResult.artifacts);

          pdfStatus = {
            source_kind: 'pdf',
            identifier: pdfIdentifier,
            paper_id: pdfIdentity.paper_id,
            status: 'success',
            duration_ms: Date.now() - t0,
            fallback_used: pdfBuildResult.summary.used_zotero_fulltext
              ? 'zotero_fulltext'
              : pdfBuildResult.summary.used_docling_json
                ? 'docling_json'
                : undefined,
          };
          sourceStatuses.push(pdfStatus);
        } catch (err) {
          sourceStatuses.push({
            source_kind: 'pdf',
            identifier: pdfIdentifier,
            status: 'failed',
            error: errorMessage(err),
            error_code: inferEvidenceErrorCode('pdf', err),
            duration_ms: Date.now() - t0,
          });
          if (!continueOnError) {
            writeSourceStatusArtifact();
            throw err;
          }
        }

        if (pdfBuildResult) {
          const rawCatalogName = `${output_prefix}_evidence_catalog.jsonl`;
          const rawCatalogPath = getRunArtifactPath(runId, rawCatalogName);
          const rawItems = readJsonlFile<RawPdfCatalogItemV1>(rawCatalogPath);
          const pdfItemsAll = materializePdfWritingCatalogItems({
            rawItems,
            paperId: pdfIdentity.paper_id,
            defaultProjectId: run.project_id,
          });
          const pdfItemsFiltered = ensureUniqueByEvidenceId(pdfItemsAll.filter(it => params.pdf_types.includes(it.type)));
          const pdfItems = sortByEvidenceId(pdfItemsFiltered).slice(0, maxEvidenceItems);
          if (pdfItemsFiltered.length > pdfItems.length) {
            const msg =
              `PDF writing evidence truncated at max_evidence_items=${maxEvidenceItems} (available=${pdfItemsFiltered.length}, returned=${pdfItems.length}).`;
            warnings.push(msg);
            budget.recordHit({
              key: 'writing.max_evidence_items',
              dimension: 'breadth',
              unit: 'items',
              limit: maxEvidenceItems,
              observed: pdfItemsFiltered.length,
              action: 'truncate',
              message: msg,
              data: { kind: 'pdf', available: pdfItemsFiltered.length, returned: pdfItems.length },
            });
          }

          if (pdfStatus) pdfStatus.items_extracted = pdfItemsFiltered.length;

          const sharedCatalogName = `${output_prefix}_writing_evidence_catalog.jsonl`;
          const sharedCatalogContent = pdfItems.map(it => JSON.stringify(it)).join('\n') + '\n';
          const sharedCatalogRef = writeRunTextArtifact({
            runId,
            artifactName: sharedCatalogName,
            content: sharedCatalogContent,
            mimeType: 'application/x-ndjson',
          });
          artifacts.push(sharedCatalogRef);
          pdfCatalogUri = sharedCatalogRef.uri;

          const pdfEmbeddingsContent = buildEmbeddingsJsonl({
            model: embeddingModel,
            dim: params.embedding_dim,
            items: pdfItems.map(it => ({
              evidence_id: it.evidence_id,
              text: it.normalized_text ?? it.text ?? '',
              type: it.type,
              paper_id: it.paper_id,
              run_id: runId,
            })),
          });
          const pdfEmbeddingsRef = writeRunTextArtifact({
            runId,
            artifactName: params.pdf_embeddings_artifact_name,
            content: pdfEmbeddingsContent,
            mimeType: 'application/x-ndjson',
          });
          artifacts.push(pdfEmbeddingsRef);

          const pdfEnrichmentContent = buildEnrichmentJsonl({
            items: pdfItems.map(it => ({
              evidence_id: it.evidence_id,
              importance_score: importanceScoreForPdf(it),
              type: it.type,
              paper_id: it.paper_id,
              run_id: runId,
            })),
            labelsFor: it => (it.type ? [String(it.type)] : []),
          });
          const pdfEnrichmentRef = writeRunTextArtifact({
            runId,
            artifactName: params.pdf_enrichment_artifact_name,
            content: pdfEnrichmentContent,
            mimeType: 'application/x-ndjson',
          });
          artifacts.push(pdfEnrichmentRef);
        }
      }
    }

    const statusSummary = summarizeSourceStatuses(sourceStatuses);
    writeSourceStatusArtifact();
    if (statusSummary.succeeded === 0) {
      throw new Error('No writing evidence sources succeeded');
    }

    const attempted = statusSummary.succeeded + statusSummary.failed;
    const verificationSubjectRefs = Array.from(collectedVerification.subjectRefs.values())
      .sort((a, b) => a.uri.localeCompare(b.uri));
    const verificationCheckRunRefs = Array.from(collectedVerification.checkRunRefs.values())
      .sort((a, b) => a.uri.localeCompare(b.uri));
    const verificationSubjectVerdictEntries = Array.from(collectedVerification.subjectVerdicts.values())
      .sort((a, b) => a.ref.uri.localeCompare(b.ref.uri));
    const verificationCoverageEntries = Array.from(collectedVerification.coverage.values())
      .sort((a, b) => a.ref.uri.localeCompare(b.ref.uri));
    const metaRef = writeRunJsonArtifact(runId, 'writing_evidence_meta_v1.json', {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      project_id: run.project_id,
      source_status_artifact: sourceStatusName,
      sources_summary: {
        attempted,
        succeeded: statusSummary.succeeded,
        failed: statusSummary.failed,
        fallback_count: statusSummary.fallback_count,
      },
      latex: {
        sources: params.latex_sources.map(s => ({
          identifier: s.identifier ?? null,
          main_tex_path: s.main_tex_path ?? null,
          paper_id: s.paper_id ?? null,
        })),
        types: params.latex_types,
        catalog_artifact_name: params.latex_catalog_artifact_name,
        embeddings_artifact_name: params.latex_embeddings_artifact_name,
        enrichment_artifact_name: params.latex_enrichment_artifact_name,
        total_items: latexItems.length,
      },
      bridges: bridgeSummaries,
      verification: {
        subject_refs: verificationSubjectRefs,
        check_run_refs: verificationCheckRunRefs,
        subject_verdict_refs: verificationSubjectVerdictEntries.map(entry => entry.ref),
        coverage_refs: verificationCoverageEntries.map(entry => entry.ref),
        subject_verdicts: verificationSubjectVerdictEntries.map(entry => entry.meta),
        coverage: verificationCoverageEntries.map(entry => entry.meta),
      },
      pdf: pdfBuildResult
        ? {
            ...params.pdf_source!,
            paper_id: pdfStatus?.paper_id ?? null,
            catalog_uri: pdfCatalogUri ?? null,
            embeddings_artifact_name: params.pdf_embeddings_artifact_name,
            enrichment_artifact_name: params.pdf_enrichment_artifact_name,
          }
        : null,
      embedding: {
        model: embeddingModel,
        dim: params.embedding_dim,
      },
      warnings,
    });
    artifacts.push(metaRef);

    const diag = writeRunStepDiagnosticsArtifact({
      run_id: runId,
      project_id: run.project_id,
      step: step.step,
      step_index: stepIndex,
      ...budget.snapshot(),
    });
    artifacts.push(diag.run, diag.project);

    // Attach artifacts to the run step (keep discoverable).
    await finishRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: makeHepRunManifestUri(runId),
      artifacts,
      summary: {
        bridge_sources: bridgeSummaries.length,
        latex_items: latexItems.length,
        latex_types: Array.from(new Set(latexItems.map(it => it.type))).sort(),
        pdf_included: Boolean(pdfBuildResult),
        embedding_model: embeddingModel,
        embedding_dim: params.embedding_dim,
        warnings_total: warnings.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (!sourceStatusRef) {
        try {
          writeSourceStatusArtifact();
        } catch {
          // ignore
        }
      }
      await finishRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: message,
      });
    } catch {
      // ignore secondary failures
    }
    throw err;
  }
}

export function queryEvidenceByEmbeddings(params: {
  query: string;
  dim: number;
  embeddings: Array<{ evidence_id: string; vector: SparseVector; type?: string; paper_id?: string; run_id?: string }>;
  catalog: Array<{ evidence_id: string; type: string; text: string; locator?: unknown; paper_id?: string; run_id?: string; project_id?: string }>;
  limit: number;
  include_explanation?: boolean;
  filter?: {
    types?: string[];
    paper_id?: string;
    project_id?: string;
  };
}): Array<{ evidence_id: string; score: number; matched_tokens?: string[]; token_overlap_ratio?: number }> {
  const q = buildSparseVector(params.query, params.dim);
  const includeExplanation = params.include_explanation ?? false;
  const queryTokensRaw = includeExplanation ? tokenizeForEmbedding(params.query) : [];
  const queryTokens: string[] = [];
  if (includeExplanation) {
    const seen = new Set<string>();
    for (const t of queryTokensRaw) {
      if (seen.has(t)) continue;
      seen.add(t);
      queryTokens.push(t);
    }
  }
  const byId = new Map<string, SparseVector>();
  for (const e of params.embeddings) byId.set(e.evidence_id, e.vector);

  const candidates = params.catalog.filter(it => {
    if (params.filter?.types && params.filter.types.length > 0 && !params.filter.types.includes(it.type)) return false;
    if (params.filter?.paper_id && it.paper_id !== params.filter.paper_id) return false;
    if (params.filter?.project_id && it.project_id !== params.filter.project_id) return false;
    return true;
  });

  const scored: Array<{ evidence_id: string; score: number; matched_tokens?: string[]; token_overlap_ratio?: number }> = [];
  for (const item of candidates) {
    const v = byId.get(item.evidence_id);
    if (!v) continue;
    const score = dotSparse(q, v);
    if (score <= 0) continue;
    if (!includeExplanation) {
      scored.push({ evidence_id: item.evidence_id, score });
      continue;
    }

    const evidenceTokens = new Set<string>(tokenizeForEmbedding(item.text ?? ''));
    let overlap = 0;
    const matched: string[] = [];
    for (const t of queryTokens) {
      if (!evidenceTokens.has(t)) continue;
      overlap += 1;
      if (matched.length < 20) matched.push(t);
    }

    scored.push({
      evidence_id: item.evidence_id,
      score,
      matched_tokens: matched,
      token_overlap_ratio: clamp01(queryTokens.length > 0 ? overlap / queryTokens.length : 0),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, params.limit);
}

export function parseEmbeddingsJsonl(params: {
  content: string;
}): Array<{ evidence_id: string; model?: string; vector: SparseVector; type?: string; paper_id?: string; run_id?: string }> {
  const lines = params.content.split('\n').map(l => l.trim()).filter(Boolean);
  const out: Array<{ evidence_id: string; model?: string; vector: SparseVector; type?: string; paper_id?: string; run_id?: string }> = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as any;
    if (!parsed || typeof parsed !== 'object') continue;
    if (typeof parsed.evidence_id !== 'string') continue;
    if (!parsed.vector || typeof parsed.vector !== 'object') continue;
    const v = parsed.vector as any;
    if (typeof v.dim !== 'number' || !Array.isArray(v.indices) || !Array.isArray(v.values)) continue;
    out.push({
      evidence_id: parsed.evidence_id,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      vector: { dim: v.dim, indices: v.indices.map((n: any) => Number(n)), values: v.values.map((n: any) => Number(n)) },
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      paper_id: typeof parsed.paper_id === 'string' ? parsed.paper_id : undefined,
      run_id: typeof parsed.run_id === 'string' ? parsed.run_id : undefined,
    });
  }
  return out;
}
