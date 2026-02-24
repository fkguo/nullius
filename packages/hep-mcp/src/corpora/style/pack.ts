import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { invalidParams, notFound } from '@autoresearch/shared';
import { Zip, ZipDeflate, Unzip, UnzipInflate, UnzipPassThrough, strToU8 } from 'fflate';

import { ensureDir, getDataDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';
import { stableJsonStringify } from './json.js';
import { assertSafeStyleId, getCorporaDir } from './paths.js';
import { StyleCorpusPackManifestV1Schema, type StyleCorpusPackManifestV1 } from './schemas.js';

export interface ExportStyleCorpusPackResult {
  style_id: string;
  zip_path: string;
  sha256: string;
  bytes: number;
  manifest: StyleCorpusPackManifestV1;
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function guessMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.jsonl') return 'application/x-ndjson';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  if (ext === '.tex') return 'text/x-tex';
  if (ext === '.bib') return 'text/x-bibtex';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.zip') return 'application/zip';
  return undefined;
}

function normalizeZipPath(p: string): string {
  const normalized = p.split(path.sep).join('/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function isSymlinkOrMissing(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink();
  } catch {
    return true;
  }
}

function listFilesRecursive(rootDir: string): string[] {
  const out: string[] = [];
  if (isSymlinkOrMissing(rootDir)) return out;
  if (!fs.existsSync(rootDir)) return out;
  const st = fs.statSync(rootDir);
  if (!st.isDirectory()) return out;

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (isSymlinkOrMissing(abs)) continue;
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (ent.isFile()) out.push(abs);
    }
  };

  walk(rootDir);
  return out;
}

function collectCorpusFiles(params: {
  style_id: string;
  include_sources: boolean;
  include_pdf: boolean;
  include_evidence: boolean;
  include_index: boolean;
  include_artifacts: boolean;
}): { files: Array<{ abs: string; rel: string }>; warnings: string[] } {
  const styleId = params.style_id;
  assertSafeStyleId(styleId);

  const dataDir = getDataDir();
  const corporaDir = getCorporaDir();
  const corpusDir = resolvePathWithinParent(corporaDir, path.join(corporaDir, styleId), 'corpus_dir');
  if (!fs.existsSync(corpusDir) || !fs.statSync(corpusDir).isDirectory()) {
    throw notFound('Style corpus not found', { style_id: styleId, path: corpusDir });
  }
  if (isSymlinkOrMissing(corpusDir)) {
    throw invalidParams('corpus_dir must not be a symlink', { style_id: styleId, path: corpusDir });
  }

  const warnings: string[] = [];

  const addFile = (abs: string, byRel: Map<string, string>) => {
    if (!fs.existsSync(abs)) return;
    if (isSymlinkOrMissing(abs)) return;
    const st = fs.statSync(abs);
    if (!st.isFile()) return;
    const rel = normalizeZipPath(path.relative(dataDir, abs));
    if (!rel || rel.startsWith('..')) return;
    byRel.set(rel, abs);
  };

  const byRel = new Map<string, string>();

  // Minimal required files
  const profilePath = path.join(corpusDir, 'profile.json');
  const manifestPath = path.join(corpusDir, 'manifest.jsonl');
  if (!fs.existsSync(profilePath)) throw notFound('profile.json not found for corpus', { style_id: styleId, path: profilePath });
  if (!fs.existsSync(manifestPath)) throw notFound('manifest.jsonl not found for corpus', { style_id: styleId, path: manifestPath });

  addFile(profilePath, byRel);
  addFile(manifestPath, byRel);

  const includeDirs: Array<{ key: string; enabled: boolean; dir: string }> = [
    { key: 'sources', enabled: params.include_sources, dir: path.join(corpusDir, 'sources') },
    { key: 'pdf', enabled: params.include_pdf, dir: path.join(corpusDir, 'pdf') },
    { key: 'evidence', enabled: params.include_evidence, dir: path.join(corpusDir, 'evidence') },
    { key: 'index', enabled: params.include_index, dir: path.join(corpusDir, 'index') },
    { key: 'artifacts', enabled: params.include_artifacts, dir: path.join(corpusDir, 'artifacts') },
  ];

  for (const group of includeDirs) {
    if (!group.enabled) continue;
    if (!fs.existsSync(group.dir)) {
      warnings.push(`missing_dir:${group.key}`);
      continue;
    }
    for (const fileAbs of listFilesRecursive(group.dir)) {
      addFile(fileAbs, byRel);
    }
  }

  const files = Array.from(byRel.entries())
    .map(([rel, abs]) => ({ rel, abs }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  return { files, warnings };
}

export async function exportStyleCorpusPackToZip(params: {
  style_id: string;
  zip_path: string;
  include_sources?: boolean;
  include_pdf?: boolean;
  include_evidence?: boolean;
  include_index?: boolean;
  include_artifacts?: boolean;
  compression_level?: number;
}): Promise<ExportStyleCorpusPackResult> {
  const styleId = params.style_id;
  assertSafeStyleId(styleId);

  const include_sources = params.include_sources ?? true;
  const include_pdf = params.include_pdf ?? true;
  const include_evidence = params.include_evidence ?? true;
  const include_index = params.include_index ?? true;
  const include_artifacts = params.include_artifacts ?? false;
  const compression_level = Math.min(9, Math.max(0, Math.trunc(params.compression_level ?? 6))) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

  const { files, warnings } = collectCorpusFiles({
    style_id: styleId,
    include_sources,
    include_pdf,
    include_evidence,
    include_index,
    include_artifacts,
  });

  if (files.length === 0) {
    throw invalidParams('No files selected for export');
  }

  ensureDir(path.dirname(params.zip_path));
  if (fs.existsSync(params.zip_path)) {
    fs.rmSync(params.zip_path, { force: true });
  }

  let bytesWritten = 0;
  const zipHash = crypto.createHash('sha256');
  let zipError: Error | null = null;

  const fd = fs.openSync(params.zip_path, 'w');
  let zipDoneResolve: (() => void) | null = null;
  let zipDoneReject: ((err: Error) => void) | null = null;
  const zipDone = new Promise<void>((resolve, reject) => {
    zipDoneResolve = resolve;
    zipDoneReject = reject;
  });

  const zip = new Zip((err, data, final) => {
    if (err) {
      zipError = err;
      zipDoneReject?.(err);
      return;
    }
    zipHash.update(data);
    bytesWritten += data.length;
    fs.writeSync(fd, data);
    if (final) {
      zipDoneResolve?.();
    }
  });

  const manifestFiles: StyleCorpusPackManifestV1['files'] = [];

  try {
    for (const f of files) {
      const zf = new ZipDeflate(f.rel, { level: compression_level });
      zip.add(zf);

      const fileHash = crypto.createHash('sha256');
      let sizeBytes = 0;

      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(f.abs, { highWaterMark: 1024 * 128 });
        rs.on('data', (chunk: Buffer) => {
          fileHash.update(chunk);
          sizeBytes += chunk.length;
          zf.push(chunk, false);
        });
        rs.on('end', () => {
          zf.push(new Uint8Array(0), true);
          resolve();
        });
        rs.on('error', reject);
      });

      manifestFiles.push({
        path: f.rel,
        sha256: fileHash.digest('hex'),
        size_bytes: sizeBytes,
        mimeType: guessMimeType(f.rel),
      });
    }

    const manifest: StyleCorpusPackManifestV1 = {
      version: 1,
      kind: 'style_corpus_pack',
      style_id: styleId,
      exported_at: new Date().toISOString(),
      includes: {
        sources: include_sources,
        pdf: include_pdf,
        evidence: include_evidence,
        index: include_index,
        artifacts: include_artifacts,
      },
      files: manifestFiles,
      warnings: warnings.length > 0 ? warnings.sort((a, b) => a.localeCompare(b)) : undefined,
    };

    // Validate manifest structure before writing into the pack.
    StyleCorpusPackManifestV1Schema.parse(manifest);

    const manifestBytes = strToU8(stableJsonStringify(manifest, 2) + '\n');
    const mf = new ZipDeflate('pack_manifest.json', { level: compression_level });
    zip.add(mf);
    mf.push(manifestBytes, true);

    zip.end();
    await zipDone;

    if (zipError) throw zipError;
    const sha256 = zipHash.digest('hex');
    return {
      style_id: styleId,
      zip_path: params.zip_path,
      sha256,
      bytes: bytesWritten,
      manifest,
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    if (fs.existsSync(params.zip_path)) {
      fs.rmSync(params.zip_path, { force: true });
    }
    throw err;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export interface ImportStyleCorpusPackResult {
  style_id: string;
  imported_files: number;
  manifest: StyleCorpusPackManifestV1;
}

export async function importStyleCorpusPackFromZip(params: {
  zip_path: string;
  overwrite?: boolean;
}): Promise<ImportStyleCorpusPackResult> {
  const zipPath = params.zip_path;
  if (!zipPath || !zipPath.trim()) throw invalidParams('zip_path cannot be empty');
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    throw notFound('Pack zip not found', { zip_path: zipPath });
  }

  const overwrite = params.overwrite ?? false;

  const dataDir = getDataDir();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-pack-import-'));

  const extracted: Array<{ name: string; sha256: string; size_bytes: number }> = [];
  const extractedByName = new Map<string, { sha256: string; size_bytes: number }>();
  const filePromises: Promise<void>[] = [];

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  unzip.onfile = (file) => {
    const nameRaw = String(file.name || '').trim();
    if (!nameRaw || nameRaw.includes('\\') || nameRaw.startsWith('/')) {
      throw invalidParams('Invalid zip entry name', { name: nameRaw });
    }

    const name = normalizeZipPath(nameRaw);
    const destPath = resolvePathWithinParent(stagingRoot, path.join(stagingRoot, name), 'zip_entry');
    ensureDir(path.dirname(destPath));

    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const ws = fs.createWriteStream(destPath);

    const p = new Promise<void>((resolve, reject) => {
      file.ondata = (err, data, final) => {
        if (err) {
          reject(err);
          return;
        }
        if (data && data.length > 0) {
          hash.update(data);
          bytes += data.length;
          ws.write(Buffer.from(data));
        }
        if (final) {
          ws.end(() => {
            const sha = hash.digest('hex');
            extracted.push({ name, sha256: sha, size_bytes: bytes });
            extractedByName.set(name, { sha256: sha, size_bytes: bytes });
            resolve();
          });
        }
      };
      ws.on('error', reject);
    });

    filePromises.push(p);
    file.start();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(zipPath, { highWaterMark: 1024 * 128 });
      rs.on('data', (chunk: Buffer) => {
        try {
          unzip.push(chunk, false);
        } catch (err) {
          reject(err);
        }
      });
      rs.on('end', () => {
        try {
          unzip.push(new Uint8Array(0), true);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      rs.on('error', reject);
    });

    await Promise.all(filePromises);

    const manifestPath = path.join(stagingRoot, 'pack_manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw invalidParams('pack_manifest.json not found in zip');
    }

    const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = StyleCorpusPackManifestV1Schema.parse(JSON.parse(manifestRaw) as unknown);
    assertSafeStyleId(manifest.style_id);

    // Verify every manifest file exists and matches sha256 + size.
    for (const f of manifest.files) {
      const info = extractedByName.get(f.path);
      if (!info) {
        throw invalidParams('Pack missing expected file', { expected_path: f.path });
      }
      if (info.sha256 !== f.sha256 || info.size_bytes !== f.size_bytes) {
        throw invalidParams('Pack file hash mismatch', {
          path: f.path,
          expected: { sha256: f.sha256, size_bytes: f.size_bytes },
          actual: info,
        });
      }
      if (!f.path.startsWith(`corpora/${manifest.style_id}/`)) {
        throw invalidParams('Unexpected file path outside corpus root', {
          path: f.path,
          expected_prefix: `corpora/${manifest.style_id}/`,
        });
      }
    }

    // Preflight overwrite checks for destination paths.
    const conflicts: string[] = [];
    for (const f of manifest.files) {
      const dest = resolvePathWithinParent(dataDir, path.join(dataDir, f.path), 'pack_dest');
      if (!overwrite && fs.existsSync(dest)) conflicts.push(f.path);
    }
    if (conflicts.length > 0) {
      throw invalidParams('Destination files already exist (set overwrite=true to replace)', {
        conflicts: conflicts.slice(0, 50),
        total_conflicts: conflicts.length,
      });
    }

    for (const f of manifest.files) {
      const src = resolvePathWithinParent(stagingRoot, path.join(stagingRoot, f.path), 'pack_src');
      const dest = resolvePathWithinParent(dataDir, path.join(dataDir, f.path), 'pack_dest');
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }

    return {
      style_id: manifest.style_id,
      imported_files: manifest.files.length,
      manifest,
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function buildPackManifestBytes(manifest: StyleCorpusPackManifestV1): Uint8Array {
  StyleCorpusPackManifestV1Schema.parse(manifest);
  return strToU8(stableJsonStringify(manifest, 2) + '\n');
}

export function sha256PackManifestBytes(manifest: StyleCorpusPackManifestV1): string {
  return sha256Hex(buildPackManifestBytes(manifest));
}
