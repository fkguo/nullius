import * as path from 'path';
import { invalidParams } from '@autoresearch/shared';
import { ensureDir, getDataDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';

export function assertSafeStyleId(styleId: string): void {
  const trimmed = styleId.trim();
  if (!trimmed) throw invalidParams('style_id cannot be empty');
  if (trimmed.includes('/') || trimmed.includes('\\')) throw invalidParams('style_id cannot include path separators');
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) throw invalidParams('style_id contains unsafe segment');
}

export function assertSafeArtifactName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw invalidParams('artifact_name cannot be empty');
  if (trimmed.includes('/') || trimmed.includes('\\')) throw invalidParams('artifact_name cannot include path separators');
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) throw invalidParams('artifact_name contains unsafe segment');
}

export function getCorporaDir(): string {
  const dataDir = getDataDir();
  const corporaDir = resolvePathWithinParent(dataDir, path.join(dataDir, 'corpora'), 'corpora_dir');
  ensureDir(corporaDir);
  return corporaDir;
}

export function getCorpusDir(styleId: string): string {
  assertSafeStyleId(styleId);
  const corporaDir = getCorporaDir();
  const corpusDir = resolvePathWithinParent(corporaDir, path.join(corporaDir, styleId), 'corpus_dir');
  ensureDir(corpusDir);
  return corpusDir;
}

export function getCorpusProfilePath(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  return resolvePathWithinParent(corpusDir, path.join(corpusDir, 'profile.json'), 'corpus_profile.json');
}

export function getCorpusManifestPath(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  return resolvePathWithinParent(corpusDir, path.join(corpusDir, 'manifest.jsonl'), 'corpus_manifest.jsonl');
}

export function getCorpusSourcesDir(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  const p = resolvePathWithinParent(corpusDir, path.join(corpusDir, 'sources'), 'corpus_sources_dir');
  ensureDir(p);
  return p;
}

export function getCorpusPdfDir(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  const p = resolvePathWithinParent(corpusDir, path.join(corpusDir, 'pdf'), 'corpus_pdf_dir');
  ensureDir(p);
  return p;
}

export function getCorpusEvidenceDir(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  const p = resolvePathWithinParent(corpusDir, path.join(corpusDir, 'evidence'), 'corpus_evidence_dir');
  ensureDir(p);
  return p;
}

export function getCorpusIndexDir(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  const p = resolvePathWithinParent(corpusDir, path.join(corpusDir, 'index'), 'corpus_index_dir');
  ensureDir(p);
  return p;
}

export function getCorpusArtifactsDir(styleId: string): string {
  const corpusDir = getCorpusDir(styleId);
  const p = resolvePathWithinParent(corpusDir, path.join(corpusDir, 'artifacts'), 'corpus_artifacts_dir');
  ensureDir(p);
  return p;
}

export function getCorpusArtifactPath(styleId: string, artifactName: string): string {
  assertSafeArtifactName(artifactName);
  const artifactsDir = getCorpusArtifactsDir(styleId);
  return resolvePathWithinParent(artifactsDir, path.join(artifactsDir, artifactName), 'corpus_artifact_path');
}

