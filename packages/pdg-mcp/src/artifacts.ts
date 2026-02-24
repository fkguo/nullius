import * as crypto from 'crypto';
import * as fs from 'fs';
import { getArtifactsDir, ensureDir } from './data/dataDir.js';
import { assertSafePathSegment, resolvePathWithinParent } from './data/pathGuard.js';
import { cleanupOldPdgArtifacts } from './artifactTtl.js';

let lastArtifactCleanupMs = 0;
const MIN_ARTIFACT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

function maybeCleanupPdgArtifacts(): void {
  const now = Date.now();
  if (now - lastArtifactCleanupMs < MIN_ARTIFACT_CLEANUP_INTERVAL_MS) return;
  lastArtifactCleanupMs = now;

  try {
    cleanupOldPdgArtifacts();
  } catch {
    // best-effort
  }
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function safeSlug(input: string, maxLen: number): string {
  const slug = input
    .normalize('NFKD')
    .replaceAll(/[^A-Za-z0-9_-]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return slug.length > 0 ? slug : 'item';
}

export function defaultArtifactName(prefix: string, key: string, ext: 'json' | 'jsonl' | 'md' = 'json'): string {
  const hash = crypto.createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 12);
  const slug = safeSlug(key, 60);
  const name = `${prefix}_${slug}_${hash}.${ext}`;
  assertSafePathSegment(name, 'artifact_name');
  return name;
}

export function writeJsonArtifact(artifactName: string, data: unknown): {
  name: string;
  uri: string;
  file_path: string;
  size_bytes: number;
  sha256: string;
  mimeType: string;
} {
  assertSafePathSegment(artifactName, 'artifact_name');

  maybeCleanupPdgArtifacts();

  const artifactsDir = getArtifactsDir();
  ensureDir(artifactsDir);

  const filePath = resolvePathWithinParent(artifactsDir, artifactName, 'artifact_name');
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, text, 'utf-8');

  return {
    name: artifactName,
    uri: `pdg://artifacts/${encodeURIComponent(artifactName)}`,
    file_path: filePath,
    size_bytes: Buffer.byteLength(text, 'utf-8'),
    sha256: sha256Text(text),
    mimeType: 'application/json',
  };
}

export function writeJsonlArtifact(artifactName: string, rows: unknown[]): {
  name: string;
  uri: string;
  file_path: string;
  size_bytes: number;
  sha256: string;
  mimeType: string;
  rows: number;
} {
  assertSafePathSegment(artifactName, 'artifact_name');

  maybeCleanupPdgArtifacts();

  const artifactsDir = getArtifactsDir();
  ensureDir(artifactsDir);

  const filePath = resolvePathWithinParent(artifactsDir, artifactName, 'artifact_name');
  const lines = rows.map(r => JSON.stringify(r));
  const text = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
  fs.writeFileSync(filePath, text, 'utf-8');

  return {
    name: artifactName,
    uri: `pdg://artifacts/${encodeURIComponent(artifactName)}`,
    file_path: filePath,
    size_bytes: Buffer.byteLength(text, 'utf-8'),
    sha256: sha256Text(text),
    mimeType: 'application/x-ndjson',
    rows: rows.length,
  };
}
