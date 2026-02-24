import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { invalidParams, McpError } from '@autoresearch/shared';
import pLimit from 'p-limit';

import * as inspireApi from '../../api/client.js';
import { writeRunJsonArtifact } from '../citations.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { getRunArtifactPath } from '../paths.js';
import { getRun, type RunArtifactRef } from '../runs.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';

import {
  zoteroConnectorPostJson,
  zoteroGetBinary,
  zoteroGetJson,
  zoteroGetJsonAllow404,
  zoteroPostJson,
  zoteroPutJson,
} from '@autoresearch/zotero-mcp/shared/zotero';
import {
  extractZoteroItemIdentifiers,
  normalizeZoteroArxivId,
  normalizeZoteroDoi,
  parseZoteroExtraIdentifiers,
} from '@autoresearch/zotero-mcp/shared/zotero';
import { completeRunStep, startRunStep } from './runSteps.js';
import type { Paper } from '@autoresearch/shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeZoteroKey(token: string, fieldName: string): string {
  const v = token.trim();
  if (!v) throw invalidParams(`${fieldName} cannot be empty`);
  if (v.length > 200) throw invalidParams(`${fieldName} too long`, { length: v.length, max: 200 });
  if (v.includes('/') || v.includes('\\')) {
    throw invalidParams(`${fieldName} must not include path separators`);
  }
  if (v === '.' || v === '..' || v.includes('..')) {
    throw invalidParams(`${fieldName} contains unsafe segment`);
  }
  return v;
}

function resolveZoteroDataDir(): string {
  const raw = process.env.ZOTERO_DATA_DIR;
  if (!raw || !raw.trim()) {
    return path.join(os.homedir(), 'Zotero');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  return trimmed;
}

function readZoteroFulltextCacheFromDisk(attachmentKey: string): { content: string; file_path: string } | undefined {
  const dataDir = resolveZoteroDataDir();
  const cachePath = path.join(dataDir, 'storage', attachmentKey, '.zotero-ft-cache');
  if (!fs.existsSync(cachePath)) return undefined;

  const stat = fs.statSync(cachePath);
  if (!stat.isFile()) return undefined;

  try {
    const content = fs.readFileSync(cachePath, 'utf-8');
    if (!content) return undefined;
    return { content, file_path: cachePath };
  } catch {
    return undefined;
  }
}

function writeRunBinaryArtifact(params: {
  runId: string;
  artifactName: string;
  bytes: Uint8Array;
  mimeType?: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, Buffer.from(params.bytes));
  return {
    name: params.artifactName,
    uri: `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(params.artifactName)}`,
    mimeType: params.mimeType,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function copyFileToArtifactAndHash(params: {
  sourcePath: string;
  destPath: string;
}): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;

  const tmpPath = `${params.destPath}.tmp-${randomUUID()}`;
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      bytes += buf.length;
      cb(null, buf);
    },
  });

  try {
    await pipeline(fs.createReadStream(params.sourcePath), hasher, fs.createWriteStream(tmpPath));

    try {
      fs.renameSync(tmpPath, params.destPath);
    } catch (err) {
      if (fs.existsSync(params.destPath)) {
        fs.rmSync(params.destPath, { force: true });
        fs.renameSync(tmpPath, params.destPath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    throw err;
  }

  return { sha256: hash.digest('hex'), bytes };
}

function parseAttachmentSummaries(children: unknown[]): Array<{
  attachment_key: string;
  filename?: string;
  content_type?: string;
  link_mode?: string;
}> {
  const attachments: Array<{
    attachment_key: string;
    filename?: string;
    content_type?: string;
    link_mode?: string;
  }> = [];

  for (const child of children) {
    if (!isRecord(child)) continue;
    const key = child.key;
    if (typeof key !== 'string' || !key.trim()) continue;
    const data = isRecord(child.data) ? child.data : {};
    const itemType = data.itemType;
    if (itemType !== 'attachment') continue;

    const filename = typeof data.filename === 'string' ? data.filename : undefined;
    const contentType = typeof data.contentType === 'string' ? data.contentType : undefined;
    const linkMode = typeof data.linkMode === 'string' ? data.linkMode : undefined;

    attachments.push({
      attachment_key: key.trim(),
      filename,
      content_type: contentType,
      link_mode: linkMode,
    });
  }

  return attachments;
}

function isPdfAttachment(att: { filename?: string; content_type?: string }): boolean {
  const byType = (att.content_type || '').toLowerCase().includes('pdf');
  const byName = (att.filename || '').toLowerCase().endsWith('.pdf');
  return byType || byName;
}

export async function zoteroListCollections(params: {
  run_id: string;
  limit?: number;
  start?: number;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: { returned: number; total_results?: number };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'zotero_list_collections');
  const artifacts: RunArtifactRef[] = [];

  try {
    const limit = params.limit ?? 50;
    const start = params.start ?? 0;
    const res = await zoteroGetJson<unknown[]>('/users/0/collections', { limit, start });

    const artifact = writeRunJsonArtifact(runId, `zotero_collections_${start}_${limit}.json`, {
      version: 1,
      generated_at: new Date().toISOString(),
      request: { limit, start },
      meta: res.meta,
      collections: res.data,
    });
    artifacts.push(artifact);

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        returned: Array.isArray(res.data) ? res.data.length : 0,
        total_results: res.meta.total_results,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function zoteroListItems(params: {
  run_id: string;
  collection_key?: string;
  limit?: number;
  start?: number;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: { returned: number; total_results?: number };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'zotero_list_items');
  const artifacts: RunArtifactRef[] = [];

  try {
    const limit = params.limit ?? 50;
    const start = params.start ?? 0;
    const collectionKey = params.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;
    const path = collectionKey
      ? `/users/0/collections/${encodeURIComponent(collectionKey)}/items/top`
      : '/users/0/items/top';

    const res = await zoteroGetJson<unknown[]>(path, { limit, start });

    const scope = collectionKey ?? 'top';
    const artifact = writeRunJsonArtifact(runId, `zotero_items_${scope}_${start}_${limit}.json`, {
      version: 1,
      generated_at: new Date().toISOString(),
      request: { collection_key: collectionKey, limit, start },
      meta: res.meta,
      items: res.data,
    });
    artifacts.push(artifact);

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        returned: Array.isArray(res.data) ? res.data.length : 0,
        total_results: res.meta.total_results,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function zoteroGetItem(params: {
  run_id: string;
  item_key: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: ZoteroItemIdentifiersSummary;
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const itemKey = normalizeZoteroKey(params.item_key, 'item_key');
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'zotero_get_item');
  const artifacts: RunArtifactRef[] = [];

  try {
    const res = await zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(itemKey)}`);

    const artifact = writeRunJsonArtifact(runId, `zotero_item_${itemKey}.json`, {
      version: 1,
      generated_at: new Date().toISOString(),
      meta: res.meta,
      item: res.data,
    });
    artifacts.push(artifact);

    const ids = extractZoteroItemIdentifiers(res.data);

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        zotero_item_key: ids.zotero_item_key,
        title: ids.title,
        doi: ids.doi,
        arxiv_id: ids.arxiv_id,
        inspire_recid: ids.inspire_recid,
        warnings: ids.warnings,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}

export interface ZoteroItemIdentifiersSummary {
  zotero_item_key: string;
  title?: string;
  doi?: string;
  arxiv_id?: string;
  inspire_recid?: string;
  warnings: string[];
}

export async function zoteroGetItemAttachments(params: {
  run_id: string;
  item_key: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: { attachments_total: number; pdf_total: number };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const itemKey = normalizeZoteroKey(params.item_key, 'item_key');
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'zotero_get_item_attachments');
  const artifacts: RunArtifactRef[] = [];

  try {
    const res = await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/children`);
    const children = Array.isArray(res.data) ? res.data : [];
    const attachments = parseAttachmentSummaries(children);
    const pdfTotal = attachments.filter(isPdfAttachment).length;

    const artifact = writeRunJsonArtifact(runId, `zotero_item_${itemKey}_attachments.json`, {
      version: 1,
      generated_at: new Date().toISOString(),
      meta: res.meta,
      item_key: itemKey,
      attachments,
    });
    artifacts.push(artifact);

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        attachments_total: attachments.length,
        pdf_total: pdfTotal,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function zoteroDownloadAttachment(params: {
  run_id: string;
  attachment_key: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: { attachment_key: string; sha256: string; bytes: number; deduped: boolean };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const attachmentKey = normalizeZoteroKey(params.attachment_key, 'attachment_key');
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'zotero_download_attachment');
  const artifacts: RunArtifactRef[] = [];

  try {
    // Fetch attachment metadata (filename/contentType) for validation.
    const itemRes = await zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(attachmentKey)}`);
    const item = itemRes.data;
    const data = isRecord(item.data) ? item.data : {};
    const contentType = typeof data.contentType === 'string' ? data.contentType : undefined;
    const filename = typeof data.filename === 'string' ? data.filename : undefined;

    const isPdf = (contentType || '').toLowerCase().includes('pdf') || (filename || '').toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      throw invalidParams('Attachment is not a PDF (only PDF is supported in M8)', {
        attachment_key: attachmentKey,
        filename,
        content_type: contentType,
      });
    }

    const pdfArtifactName = `zotero_attachment_${attachmentKey}.pdf`;
    const metaArtifactName = `zotero_attachment_${attachmentKey}.json`;

    const existingMetaPath = getRunArtifactPath(runId, metaArtifactName);
    const existingPdfPath = getRunArtifactPath(runId, pdfArtifactName);
    const existingSha = (() => {
      if (!fs.existsSync(existingMetaPath)) return undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(existingMetaPath, 'utf-8')) as { sha256?: unknown };
        return typeof parsed.sha256 === 'string' ? parsed.sha256 : undefined;
      } catch {
        return undefined;
      }
    })();

    const bin = await zoteroGetBinary(`/users/0/items/${encodeURIComponent(attachmentKey)}/file`);

    let sha: string;
    let bytes: number;
    let source: Record<string, unknown>;
    let pdfRef: RunArtifactRef;
    let deduped: boolean;

    if (bin.kind === 'bytes') {
      sha = sha256Hex(bin.bytes);
      bytes = bin.bytes.length;
      source = {
        url: bin.url,
        content_type: bin.contentType,
        content_disposition: bin.contentDisposition,
        status: bin.status,
      };

      deduped = Boolean(existingSha && existingSha === sha && fs.existsSync(existingPdfPath));
      pdfRef = deduped
        ? {
            name: pdfArtifactName,
            uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(pdfArtifactName)}`,
            mimeType: bin.contentType ?? 'application/pdf',
          }
        : writeRunBinaryArtifact({
            runId,
            artifactName: pdfArtifactName,
            bytes: bin.bytes,
            mimeType: bin.contentType ?? 'application/pdf',
          });
    } else {
      source = {
        url: bin.url,
        status: bin.status,
        location: bin.location,
        file_path: bin.filePath,
      };

      const artifactPath = getRunArtifactPath(runId, pdfArtifactName);
      const copied = await copyFileToArtifactAndHash({ sourcePath: bin.filePath, destPath: artifactPath });
      sha = copied.sha256;
      bytes = copied.bytes;

      deduped = Boolean(existingSha && existingSha === sha && fs.existsSync(existingPdfPath));
      pdfRef = {
        name: pdfArtifactName,
        uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(pdfArtifactName)}`,
        mimeType: contentType ?? 'application/pdf',
      };
    }

    artifacts.push(pdfRef);

    const metaRef = writeRunJsonArtifact(runId, metaArtifactName, {
      version: 1,
      generated_at: new Date().toISOString(),
      attachment_key: attachmentKey,
      zotero_meta: {
        filename,
        content_type: contentType,
      },
      source,
      sha256: sha,
      bytes,
      deduped,
      file: pdfRef,
    });
    artifacts.push(metaRef);

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        attachment_key: attachmentKey,
        sha256: sha,
        bytes,
        deduped,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function zoteroGetAttachmentFulltext(params: {
  run_id: string;
  attachment_key: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: {
    attachment_key: string;
    status: 'ok' | 'not_indexed';
    source?: 'ft_cache_file';
    indexed_pages?: number;
    total_pages?: number;
  };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const attachmentKey = normalizeZoteroKey(params.attachment_key, 'attachment_key');
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'zotero_get_attachment_fulltext');
  const artifacts: RunArtifactRef[] = [];

  try {
    const artifactName = `zotero_fulltext_${attachmentKey}.json`;

    const diskCache = readZoteroFulltextCacheFromDisk(attachmentKey);
    const expectedCachePath = path.join(resolveZoteroDataDir(), 'storage', attachmentKey, '.zotero-ft-cache');
    if (diskCache) {
      const payload = {
        version: 1,
        generated_at: new Date().toISOString(),
        attachment_key: attachmentKey,
        status: 'ok' as const,
        source: {
          kind: 'zotero_ft_cache_file' as const,
          file_path: diskCache.file_path,
          zotero_data_dir: resolveZoteroDataDir(),
        },
        content: diskCache.content,
      };

      const artifact = writeRunJsonArtifact(runId, artifactName, payload);
      artifacts.push(artifact);

      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'done',
        artifacts,
      });

      return {
        run_id: runId,
        project_id: run.project_id,
        manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
        artifacts,
        summary: { attachment_key: attachmentKey, status: 'ok' as const, source: 'ft_cache_file' as const },
      };
    }

    const payload = {
      version: 1,
      generated_at: new Date().toISOString(),
      attachment_key: attachmentKey,
      status: 'not_indexed' as const,
      warning: {
        code: 'ZOTERO_FULLTEXT_NOT_INDEXED',
        message: 'Zotero fulltext cache file not found. The attachment may not be indexed yet.',
      },
      guidance: [
        'Ensure the attachment is a local PDF (not a broken link) and Zotero is running.',
        'Wait for Zotero to finish indexing; large PDFs may take time.',
        'Try restarting Zotero.',
        'If available, use “Reindex Item” for the attachment; otherwise try Preferences → Search → Rebuild Index.',
        'Ensure ZOTERO_DATA_DIR points to your Zotero data directory (contains zotero.sqlite and storage/).',
      ],
      zotero_data_dir: resolveZoteroDataDir(),
      expected_cache_path: expectedCachePath,
    };

    const artifact = writeRunJsonArtifact(runId, artifactName, payload);
    artifacts.push(artifact);

    const summary = { attachment_key: attachmentKey, status: 'not_indexed' as const, source: 'ft_cache_file' as const };

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
      notes: summary.status === 'not_indexed' ? 'fulltext not indexed' : undefined,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary,
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}

function buildZoteroSelectUri(itemKey: string): string {
  return `zotero://select/library/items/${encodeURIComponent(itemKey)}`;
}

function normalizePathPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function samePathParts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (normalizePathPart(a[i] ?? '') !== normalizePathPart(b[i] ?? '')) return false;
  }
  return true;
}

function readStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function readNumberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function isConnectorTargetNode(value: unknown): value is { id: string; name: string; level: number } {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.level === 'number';
}

function resolveConnectorSelectedTargetId(params: { selectedId: string; targetIds: string[] }): string | undefined {
  const { selectedId, targetIds } = params;
  if (targetIds.includes(selectedId)) return selectedId;
  const candidates = targetIds.filter(id => id.startsWith(`${selectedId}/`) || id.endsWith(`/${selectedId}`));
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

function selectedLooksLikeLibraryRoot(selectedTargetId: string): boolean {
  const token = selectedTargetId.split('/')[0] ?? selectedTargetId;
  return /^L\d+$/i.test(token);
}

async function listAllZoteroCollections(): Promise<unknown[]> {
  const out: unknown[] = [];
  const limit = 200;
  let start = 0;

  for (let page = 0; page < 100; page += 1) {
    const res = await zoteroGetJson<unknown[]>('/users/0/collections', { limit, start });
    const data = Array.isArray(res.data) ? res.data : [];
    out.push(...data);
    if (data.length < limit) break;
    start += limit;
    if (res.meta.total_results !== undefined && out.length >= res.meta.total_results) break;
  }

  return out;
}

function buildLocalCollectionPaths(collections: unknown[]): Array<{ key: string; pathParts: string[] }> {
  const nodes = new Map<string, { name: string; parent?: string }>();

  for (const c of collections) {
    if (!isRecord(c)) continue;
    const key = typeof c.key === 'string' ? c.key.trim() : '';
    if (!key) continue;
    const data = isRecord(c.data) ? c.data : {};
    const name = typeof data.name === 'string' ? normalizePathPart(data.name) : '';
    if (!name) continue;
    const parentCollection =
      typeof data.parentCollection === 'string' && data.parentCollection.trim() ? data.parentCollection.trim() : undefined;
    nodes.set(key, { name, parent: parentCollection });
  }

  const cache = new Map<string, string[]>();
  const resolving = new Set<string>();

  function resolvePath(key: string): string[] | undefined {
    const cached = cache.get(key);
    if (cached) return cached;
    const node = nodes.get(key);
    if (!node) return undefined;
    if (resolving.has(key)) return undefined;
    resolving.add(key);
    const parentPath = node.parent ? resolvePath(node.parent) : [];
    resolving.delete(key);
    const path = [...(parentPath ?? []), node.name];
    cache.set(key, path);
    return path;
  }

  const out: Array<{ key: string; pathParts: string[] }> = [];
  for (const key of nodes.keys()) {
    const pathParts = resolvePath(key);
    if (!pathParts || pathParts.length === 0) continue;
    out.push({ key, pathParts });
  }

  return out;
}

async function resolveSelectedCollectionKey(params: {
  allow_library_root: boolean;
}): Promise<{ kind: 'collection'; collection_key: string; path: string; library_id?: number; collection_name: string } | { kind: 'library_root'; path: string; library_id?: number }> {
  const connectorRes = await zoteroConnectorPostJson<unknown>('/connector/getSelectedCollection', {});
  const payload = connectorRes.data;
  if (!isRecord(payload)) {
    throw invalidParams('Invalid Zotero connector response (expected object)');
  }

  const selectedIdStr =
    readStringField(payload, ['id', 'selectedCollectionID', 'selectedCollectionId', 'collectionID', 'collectionId'])
    ?? readStringField(isRecord(payload.collection) ? payload.collection : {}, ['id'])
    ?? readStringField(isRecord(payload.selectedCollection) ? payload.selectedCollection : {}, ['id']);
  const selectedIdNum =
    readNumberField(payload, ['id', 'selectedCollectionID', 'selectedCollectionId', 'collectionID', 'collectionId'])
    ?? readNumberField(isRecord(payload.collection) ? payload.collection : {}, ['id', 'collectionID', 'collectionId'])
    ?? readNumberField(isRecord(payload.selectedCollection) ? payload.selectedCollection : {}, ['id', 'collectionID', 'collectionId']);
  const selectedId = selectedIdStr ?? (selectedIdNum !== undefined ? `C${selectedIdNum}` : undefined);
  if (!selectedId) throw invalidParams('Zotero connector did not return selected collection id');

  const libraryId =
    readNumberField(payload, ['libraryID', 'libraryId'])
    ?? readNumberField(isRecord(payload.collection) ? payload.collection : {}, ['libraryID', 'libraryId'])
    ?? readNumberField(isRecord(payload.selectedCollection) ? payload.selectedCollection : {}, ['libraryID', 'libraryId']);

  const targetsRaw = payload.targets;
  const targets = Array.isArray(targetsRaw) ? targetsRaw.filter(isConnectorTargetNode) : [];
  if (targets.length === 0) {
    throw invalidParams('Zotero connector did not return targets tree (is Zotero open?)');
  }

  const targetIds = targets.map(t => t.id);
  const selectedTargetId = resolveConnectorSelectedTargetId({ selectedId, targetIds }) ?? selectedId;

  const stack: Array<{ id: string; name: string }> = [];
  const pathById = new Map<string, string[]>();
  for (const t of targets) {
    const level = Math.max(0, Math.floor(t.level));
    while (stack.length > level) stack.pop();
    if (stack.length < level) {
      while (stack.length < level) stack.push({ id: '', name: '' });
    }
    stack[level] = { id: t.id, name: normalizePathPart(t.name) };
    stack.length = level + 1;
    pathById.set(t.id, stack.map(n => n.name).filter(Boolean));
  }

  const selectedPathParts = pathById.get(selectedTargetId) ?? pathById.get(selectedId);
  if (!selectedPathParts || selectedPathParts.length === 0) {
    throw invalidParams('Cannot resolve selected collection path from Zotero connector targets', { selected_id: selectedId });
  }

  const isRoot = selectedLooksLikeLibraryRoot(selectedTargetId) || selectedPathParts.length === 1;
  if (isRoot) {
    if (!params.allow_library_root) {
      throw invalidParams(
        'Zotero is currently selecting the library root. Please select a collection in Zotero (left sidebar), or pass allow_library_root=true to write to library root.',
        { selected_id: selectedId }
      );
    }
    return { kind: 'library_root', path: selectedPathParts.join(' / '), library_id: libraryId };
  }

  const collectionParts = selectedPathParts.slice(1);
  const allCollections = await listAllZoteroCollections();
  const localPaths = buildLocalCollectionPaths(allCollections);

  const matches = localPaths.filter(p => samePathParts(p.pathParts, collectionParts));
  if (matches.length !== 1) {
    throw invalidParams(
      matches.length === 0
        ? 'Cannot map selected Zotero collection to collection_key (path not found). Consider renaming to disambiguate or pass collection_keys explicitly.'
        : 'Cannot map selected Zotero collection to collection_key (ambiguous path). Consider renaming to disambiguate or pass collection_keys explicitly.',
      {
        selected_path: selectedPathParts.join(' / '),
        matched: matches.length,
      }
    );
  }

  const collection_name = collectionParts[collectionParts.length - 1] ?? '';
  return {
    kind: 'collection',
    collection_key: matches[0].key,
    path: selectedPathParts.join(' / '),
    library_id: libraryId,
    collection_name,
  };
}

function normalizeZoteroExactIdentifier(value: string, fieldName: string): string {
  const v = value.trim();
  if (!v) throw invalidParams(`${fieldName} cannot be empty`);
  return v;
}

function normalizeZoteroFindIdentifiers(
  identifiers: Record<string, unknown>,
  match: 'exact' | 'fuzzy'
): {
  doi?: string;
  arxiv_id?: string;
  inspire_recid?: string;
  title?: string;
  item_key?: string;
} {
  const doiRaw = typeof identifiers.doi === 'string' ? identifiers.doi : undefined;
  const arxivRaw = typeof identifiers.arxiv_id === 'string' ? identifiers.arxiv_id : undefined;
  const recidRaw = typeof identifiers.inspire_recid === 'string' ? identifiers.inspire_recid : undefined;
  const titleRaw = typeof identifiers.title === 'string' ? identifiers.title : undefined;
  const itemKeyRaw = typeof identifiers.item_key === 'string' ? identifiers.item_key : undefined;

  const title = titleRaw ? normalizeZoteroExactIdentifier(titleRaw, 'identifiers.title') : undefined;
  const item_key = itemKeyRaw ? normalizeZoteroKey(itemKeyRaw, 'identifiers.item_key') : undefined;
  const inspire_recid = recidRaw ? normalizeZoteroExactIdentifier(recidRaw, 'identifiers.inspire_recid') : undefined;

  if (match !== 'exact') {
    return {
      doi: doiRaw?.trim() || undefined,
      arxiv_id: arxivRaw?.trim() || undefined,
      inspire_recid: inspire_recid?.trim() || undefined,
      title,
      item_key,
    };
  }

  const doi = doiRaw ? normalizeZoteroDoi(normalizeZoteroExactIdentifier(doiRaw, 'identifiers.doi')) : undefined;
  if (doiRaw && !doi) throw invalidParams('Unrecognized DOI format', { doi: doiRaw });

  const arxiv_id = arxivRaw
    ? normalizeZoteroArxivId(normalizeZoteroExactIdentifier(arxivRaw, 'identifiers.arxiv_id'))
    : undefined;
  if (arxivRaw && !arxiv_id) throw invalidParams('Unrecognized arXiv ID format', { arxiv_id: arxivRaw });

  const recid = inspire_recid?.trim();
  if (recid && !/^\d+$/.test(recid)) throw invalidParams('inspire_recid must be numeric', { inspire_recid: recidRaw });

  return {
    doi,
    arxiv_id,
    inspire_recid: recid,
    title,
    item_key,
  };
}

function normalizeZoteroFindFilters(
  filters: Record<string, unknown>,
  match: 'exact' | 'fuzzy'
): {
  tags: string[];
  authors: string[];
  publication_title?: string;
  year?: number;
  volume?: string;
  issue?: string;
} {
  const tagsRaw: unknown[] = Array.isArray((filters as any).tags) ? (filters as any).tags : [];
  const tags = Array.from(
    new Set<string>(
      tagsRaw
        .filter((t: unknown): t is string => typeof t === 'string')
        .map(t => t.trim())
        .filter((t): t is string => Boolean(t))
    )
  );

  const authorsRaw: unknown[] = Array.isArray((filters as any).authors) ? (filters as any).authors : [];
  const authors = Array.from(
    new Set<string>(
      authorsRaw
        .filter((t: unknown): t is string => typeof t === 'string')
        .map(t => t.trim())
        .filter((t): t is string => Boolean(t))
    )
  );

  const publication_title =
    typeof (filters as any).publication_title === 'string' && (filters as any).publication_title.trim()
      ? (filters as any).publication_title.trim()
      : undefined;

  const yearRaw = (filters as any).year;
  const year = typeof yearRaw === 'number' && Number.isFinite(yearRaw) ? Math.trunc(yearRaw) : undefined;

  const volume =
    typeof (filters as any).volume === 'string' && (filters as any).volume.trim() ? (filters as any).volume.trim() : undefined;
  const issue =
    typeof (filters as any).issue === 'string' && (filters as any).issue.trim() ? (filters as any).issue.trim() : undefined;

  if (match === 'exact') {
    return {
      tags,
      authors,
      publication_title,
      year,
      volume,
      issue,
    };
  }

  return {
    tags,
    authors,
    publication_title,
    year,
    volume,
    issue,
  };
}

function pickZoteroSearchToken(params: {
  identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string; item_key?: string };
  filters: {
    tags: string[];
    authors: string[];
    publication_title?: string;
    year?: number;
    volume?: string;
    issue?: string;
  };
}): string {
  const { identifiers, filters } = params;
  return (
    identifiers.doi
    || identifiers.arxiv_id
    || identifiers.inspire_recid
    || identifiers.title
    || identifiers.item_key
    || filters.publication_title
    || filters.authors[0]
    || filters.tags[0]
    || (filters.year !== undefined ? String(filters.year) : '')
    || filters.volume
    || filters.issue
    || ''
  );
}

function normalizedTitle(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeLooseText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenizeLooseText(s: string): string[] {
  const normalized = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function extractItemTags(item: unknown): string[] {
  const data = isRecord(item) && isRecord(item.data) ? item.data : {};
  const tagsRaw = (data as any).tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((t: any) => (isRecord(t) && typeof t.tag === 'string' ? t.tag.trim() : ''))
        .filter(Boolean)
    : [];
  return tags;
}

function extractItemAuthors(item: unknown): string[] {
  const data = isRecord(item) && isRecord(item.data) ? item.data : {};
  const creatorsRaw = (data as any).creators;
  if (!Array.isArray(creatorsRaw)) return [];
  const authors: string[] = [];
  for (const c of creatorsRaw) {
    if (!isRecord(c)) continue;
    if (typeof (c as any).name === 'string' && (c as any).name.trim()) {
      authors.push(String((c as any).name).trim());
      continue;
    }
    const first = typeof (c as any).firstName === 'string' ? String((c as any).firstName).trim() : '';
    const last = typeof (c as any).lastName === 'string' ? String((c as any).lastName).trim() : '';
    const full = `${first} ${last}`.trim();
    if (full) authors.push(full);
  }
  return authors;
}

function extractItemYear(item: unknown): number | undefined {
  const data = isRecord(item) && isRecord(item.data) ? item.data : {};
  const date = typeof (data as any).date === 'string' ? String((data as any).date) : undefined;
  if (!date) return undefined;
  const m = date.match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
  if (!m) return undefined;
  const year = Number(m[1]);
  return Number.isFinite(year) && year >= 1500 && year <= 2100 ? year : undefined;
}

function matchAuthors(authorsQuery: string[], authorsItem: string[], match: 'exact' | 'fuzzy'): boolean {
  if (authorsQuery.length === 0) return true;
  const hay = authorsItem.map(a => normalizeLooseText(a));
  for (const q of authorsQuery) {
    const qNorm = normalizeLooseText(q);
    if (!qNorm) return false;
    if (match === 'fuzzy') {
      if (!hay.some(h => h.includes(qNorm))) return false;
      continue;
    }
    const qTokens = tokenizeLooseText(qNorm);
    if (qTokens.length === 0) return false;
    const ok = hay.some(h => {
      const hTokens = tokenizeLooseText(h);
      return qTokens.every(t => hTokens.includes(t));
    });
    if (!ok) return false;
  }
  return true;
}

function matchItemFilters(
  item: unknown,
  filters: { tags: string[]; authors: string[]; publication_title?: string; year?: number; volume?: string; issue?: string },
  match: 'exact' | 'fuzzy'
): boolean {
  const data = isRecord(item) && isRecord(item.data) ? item.data : {};

  if (filters.tags.length > 0) {
    const tagsItem = extractItemTags(item).map(t => t.toLowerCase());
    for (const tag of filters.tags) {
      const q = tag.trim().toLowerCase();
      if (!q) return false;
      if (match === 'fuzzy') {
        if (!tagsItem.some(t => t.includes(q))) return false;
      } else {
        if (!tagsItem.includes(q)) return false;
      }
    }
  }

  if (filters.publication_title) {
    const pub = typeof (data as any).publicationTitle === 'string' ? String((data as any).publicationTitle) : '';
    const q = normalizeLooseText(filters.publication_title);
    const h = normalizeLooseText(pub);
    if (match === 'fuzzy') {
      if (!h.includes(q)) return false;
    } else {
      if (h !== q) return false;
    }
  }

  if (filters.year !== undefined) {
    const year = extractItemYear(item);
    if (year !== filters.year) return false;
  }

  if (filters.volume) {
    const volRaw = (data as any).volume;
    const vol = typeof volRaw === 'string' || typeof volRaw === 'number' ? String(volRaw) : '';
    const q = normalizeLooseText(filters.volume);
    const h = normalizeLooseText(vol);
    if (match === 'fuzzy') {
      if (!h.includes(q)) return false;
    } else {
      if (h !== q) return false;
    }
  }

  if (filters.issue) {
    const issueRaw = (data as any).issue;
    const issue = typeof issueRaw === 'string' || typeof issueRaw === 'number' ? String(issueRaw) : '';
    const q = normalizeLooseText(filters.issue);
    const h = normalizeLooseText(issue);
    if (match === 'fuzzy') {
      if (!h.includes(q)) return false;
    } else {
      if (h !== q) return false;
    }
  }

  if (!matchAuthors(filters.authors, extractItemAuthors(item), match)) return false;

  return true;
}

function isRecordWithKey(item: unknown): item is { key: string; data?: unknown; version?: unknown } {
  return isRecord(item) && typeof item.key === 'string' && Boolean(item.key.trim());
}

function parseAttachmentKeys(children: unknown[]): string[] {
  return parseAttachmentSummaries(Array.isArray(children) ? children : []).map(a => a.attachment_key);
}

async function fetchZoteroItemCandidates(params: {
  token: string;
  limit: number;
}): Promise<{ items: unknown[]; total_results?: number }> {
  const res = await zoteroGetJson<unknown[]>('/users/0/items', {
    q: params.token,
    qmode: 'everything',
    itemType: '-attachment -note',
    limit: params.limit,
  });
  return { items: Array.isArray(res.data) ? res.data : [], total_results: res.meta.total_results };
}

function arxivHasVersion(id: string): boolean {
  return /v\d+$/i.test(id.trim());
}

function arxivBaseId(id: string): string {
  return id.trim().replace(/v\d+$/i, '');
}

function matchItemIdentifiers(
  extracted: { zotero_item_key: string; doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string },
  query: { doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string; item_key?: string },
  match: 'exact' | 'fuzzy'
): boolean {
  if (query.item_key && extracted.zotero_item_key !== query.item_key) return false;

  if (query.doi) {
    const q = normalizeZoteroDoi(query.doi) ?? query.doi.trim();
    if (!q) return false;
    const h = (extracted.doi ?? '').trim();
    if (!h) return false;
    if (match === 'fuzzy') {
      if (!h.toLowerCase().includes(q.toLowerCase())) return false;
    } else {
      if (h.toLowerCase() !== q.toLowerCase()) return false;
    }
  }

  if (query.arxiv_id) {
    const q = normalizeZoteroArxivId(query.arxiv_id) ?? query.arxiv_id.trim();
    if (!q) return false;
    const h = (extracted.arxiv_id ?? '').trim();
    if (!h) return false;

    const qNorm = q.toLowerCase();
    const hNorm = h.toLowerCase();
    const qBase = arxivBaseId(qNorm);
    const hBase = arxivBaseId(hNorm);

    if (match === 'fuzzy') {
      if (arxivHasVersion(qNorm)) {
        if (!hNorm.includes(qNorm)) return false;
      } else {
        if (!hBase.includes(qBase)) return false;
      }
    } else {
      if (arxivHasVersion(qNorm)) {
        if (hNorm !== qNorm) return false;
      } else {
        if (hBase !== qBase) return false;
      }
    }
  }

  if (query.inspire_recid) {
    const q = query.inspire_recid.trim();
    if (!q) return false;
    const h = (extracted.inspire_recid ?? '').trim();
    if (!h) return false;
    if (match === 'fuzzy') {
      if (!h.includes(q)) return false;
    } else {
      if (h !== q) return false;
    }
  }

  if (query.title) {
    const q = normalizedTitle(query.title);
    if (!q) return false;
    const h = normalizedTitle(extracted.title ?? '');
    if (!h) return false;
    if (match === 'fuzzy') {
      if (!h.includes(q)) return false;
    } else {
      if (h !== q) return false;
    }
  }

  return true;
}

export async function zoteroFindItems(params: {
  identifiers?: {
    doi?: string;
    arxiv_id?: string;
    inspire_recid?: string;
    title?: string;
    item_key?: string;
  };
  filters?: {
    tags?: string[];
    authors?: string[];
    publication_title?: string;
    year?: number;
    volume?: string;
    issue?: string;
  };
  limit?: number;
  include_attachments?: boolean;
  match?: 'exact' | 'fuzzy';
}): Promise<{
  query: {
    identifiers: {
      doi?: string;
      arxiv_id?: string;
      inspire_recid?: string;
      title?: string;
      item_key?: string;
    };
    filters: {
      tags: string[];
      authors: string[];
      publication_title?: string;
      year?: number;
      volume?: string;
      issue?: string;
    };
  };
  matches: Array<{
    item_key: string;
    title?: string;
    select_uri: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    attachment_keys?: string[];
  }>;
  summary: { matched: number; scanned?: number; total_results_header?: number };
}> {
  const match = params.match ?? 'exact';
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const includeAttachments = params.include_attachments ?? false;

  const identifiers = normalizeZoteroFindIdentifiers((params.identifiers ?? {}) as unknown as Record<string, unknown>, match);
  const filters = normalizeZoteroFindFilters((params.filters ?? {}) as unknown as Record<string, unknown>, match);

  if (identifiers.item_key) {
    const res = await zoteroGetJsonAllow404<unknown>(`/users/0/items/${encodeURIComponent(identifiers.item_key)}`);
    if ('status' in res) {
      return { query: { identifiers, filters }, matches: [], summary: { matched: 0, scanned: 0 } };
    }
    const item = res.data;
    if (!isRecordWithKey(item)) {
      return { query: { identifiers, filters }, matches: [], summary: { matched: 0, scanned: 0 } };
    }

    const itemData = isRecord(item.data) ? item.data : {};
    const itemType = typeof (itemData as any).itemType === 'string' ? String((itemData as any).itemType) : '';
    const itemTypeNorm = itemType.trim().toLowerCase();
    if (itemTypeNorm === 'attachment' || itemTypeNorm === 'note' || itemTypeNorm === 'annotation') {
      return { query: { identifiers, filters }, matches: [], summary: { matched: 0, scanned: 1 } };
    }

    const extracted = extractZoteroItemIdentifiers(item);
    if (!matchItemIdentifiers(extracted, identifiers, match)) {
      return { query: { identifiers, filters }, matches: [], summary: { matched: 0, scanned: 1 } };
    }
    if (!matchItemFilters(item, filters, match)) {
      return { query: { identifiers, filters }, matches: [], summary: { matched: 0, scanned: 1 } };
    }
    const attachment_keys = includeAttachments
      ? parseAttachmentKeys(
          (await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(extracted.zotero_item_key)}/children`)).data
        )
      : undefined;

    return {
      query: { identifiers, filters },
      matches: [{
        item_key: extracted.zotero_item_key,
        title: extracted.title,
        select_uri: buildZoteroSelectUri(extracted.zotero_item_key),
        identifiers: {
          doi: extracted.doi,
          arxiv_id: extracted.arxiv_id,
          inspire_recid: extracted.inspire_recid,
        },
        attachment_keys,
      }],
      summary: { matched: 1, scanned: 1 },
    };
  }

  const token = pickZoteroSearchToken({ identifiers, filters });
  if (!token) throw invalidParams('identifiers or filters must include at least one non-empty field');
  if (token.length > 512) throw invalidParams('Search token too long (max 512 chars)', { length: token.length });

  const candidates = await fetchZoteroItemCandidates({ token, limit });
  const matches: Array<{
    item_key: string;
    title?: string;
    select_uri: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    attachment_keys?: string[];
  }> = [];

  for (const item of candidates.items) {
    if (!isRecordWithKey(item)) continue;
    const itemData = isRecord(item.data) ? item.data : {};
    const itemType = typeof (itemData as any).itemType === 'string' ? String((itemData as any).itemType) : '';
    const itemTypeNorm = itemType.trim().toLowerCase();
    if (itemTypeNorm === 'attachment' || itemTypeNorm === 'note' || itemTypeNorm === 'annotation') continue;
    const extracted = extractZoteroItemIdentifiers(item);

    if (!matchItemIdentifiers(extracted, identifiers, match)) continue;
    if (!matchItemFilters(item, filters, match)) continue;

    const attachment_keys = includeAttachments
      ? parseAttachmentKeys((await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(extracted.zotero_item_key)}/children`)).data)
      : undefined;

    matches.push({
      item_key: extracted.zotero_item_key,
      title: extracted.title,
      select_uri: buildZoteroSelectUri(extracted.zotero_item_key),
      identifiers: {
        doi: extracted.doi,
        arxiv_id: extracted.arxiv_id,
        inspire_recid: extracted.inspire_recid,
      },
      attachment_keys,
    });
  }

  return {
    query: { identifiers, filters },
    matches,
    summary: {
      matched: matches.length,
      scanned: candidates.items.length,
      total_results_header: candidates.total_results,
    },
  };
}

export async function zoteroGetSelectedCollection(params?: {
  allow_library_root?: boolean;
}): Promise<{
  collection_key: string;
  path: string;
  library_id?: number;
  collection_name: string;
}> {
  const allowLibraryRoot = params?.allow_library_root ?? false;
  const resolved = await resolveSelectedCollectionKey({ allow_library_root: allowLibraryRoot });
  if (resolved.kind !== 'collection') {
    throw invalidParams(
      'Zotero is currently selecting the library root. Please select a collection in Zotero (left sidebar) to resolve a collection_key.',
      { path: resolved.path }
    );
  }

  return {
    collection_key: resolved.collection_key,
    path: resolved.path,
    library_id: resolved.library_id,
    collection_name: resolved.collection_name,
  };
}

function normalizeTagStrings(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const trimmed = tags
    .filter(t => typeof t === 'string')
    .map(t => t.trim());
  if (trimmed.some(t => !t)) {
    throw invalidParams('tags cannot include empty strings');
  }
  return Array.from(new Set(trimmed));
}

function normalizeCollectionKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return keys
    .filter(k => typeof k === 'string')
    .map(k => normalizeZoteroKey(k, 'collection_keys'));
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toZoteroNoteHtml(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return '';
  if (trimmed.length > 20_000) {
    throw invalidParams('note is too large (max 20000 chars)', { length: trimmed.length });
  }
  const escaped = escapeHtml(trimmed).replace(/\r?\n/g, '<br/>');
  return `<p>${escaped}</p>`;
}

function zoteroTagsPayload(tags: string[]): Array<{ tag: string }> {
  return tags.map(tag => ({ tag }));
}

function mergeCollections(existing: unknown, toAdd: string[]): { next: string[]; added: number } {
  const current = Array.isArray(existing) ? existing.filter(v => typeof v === 'string') : [];
  const set = new Set(current);
  let added = 0;
  for (const key of toAdd) {
    if (!set.has(key)) {
      set.add(key);
      added += 1;
    }
  }
  return { next: Array.from(set), added };
}

function mergeTags(existing: unknown, toAdd: string[]): { next: Array<{ tag: string }>; added: number } {
  const current = Array.isArray(existing) ? existing : [];
  const set = new Set<string>();
  for (const t of current) {
    if (!isRecord(t)) continue;
    const tag = t.tag;
    if (typeof tag === 'string' && tag.trim()) set.add(tag.trim());
  }
  let added = 0;
  for (const t of toAdd) {
    if (!set.has(t)) {
      set.add(t);
      added += 1;
    }
  }
  return { next: Array.from(set).map(tag => ({ tag })), added };
}

function extractCreatedItemKey(payload: unknown): string | undefined {
  if (Array.isArray(payload) && payload.length > 0 && isRecord(payload[0]) && typeof payload[0].key === 'string') {
    return String(payload[0].key).trim() || undefined;
  }
  if (isRecord(payload)) {
    const successful = payload.successful;
    if (isRecord(successful)) {
      const first = Object.values(successful)[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
      if (isRecord(first) && typeof first.key === 'string' && first.key.trim()) return first.key.trim();
    }
  }
  return undefined;
}

function extractItemDataForUpdate(item: unknown): { key: string; data: Record<string, unknown>; version?: number } {
  if (!isRecordWithKey(item)) throw invalidParams('Invalid Zotero item (expected object with key)');
  const data = isRecord(item.data) ? item.data : {};
  const versionTop = item.version;
  const versionData = (data as any).version;
  const version =
    typeof versionTop === 'number'
      ? versionTop
      : typeof versionData === 'number'
        ? versionData
        : undefined;
  return { key: item.key.trim(), data: data as Record<string, unknown>, version };
}

function buildExtraWithIdentifiers(paper: Paper): string {
  const lines: string[] = [];
  if (paper.arxiv_id) {
    const primary = paper.arxiv_categories?.[0];
    if (primary && /^\d/.test(paper.arxiv_id)) lines.push(`arXiv:${paper.arxiv_id} [${primary}]`);
    else lines.push(`arXiv:${paper.arxiv_id}`);
  }
  return lines.join('\n');
}

function toZoteroCreators(fullNames: string[]): Array<{ creatorType: string; firstName: string; lastName: string }> {
  const out: Array<{ creatorType: string; firstName: string; lastName: string }> = [];
  for (const name of fullNames) {
    const s = name.trim();
    if (!s) continue;
    if (s.includes(',')) {
      const [last, first] = s.split(',', 2).map(v => v.trim());
      out.push({ creatorType: 'author', firstName: first || '', lastName: last || s });
      continue;
    }
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      out.push({ creatorType: 'author', firstName: '', lastName: parts[0] });
      continue;
    }
    out.push({ creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] });
  }
  return out;
}

function buildZoteroItemFromPaper(paper: Paper): Record<string, unknown> {
  const journal = paper.publication?.journal;
  const itemType = journal ? 'journalArticle' : 'preprint';

  return {
    itemType,
    title: paper.title,
    creators: toZoteroCreators(paper.authors),
    date: paper.year ? String(paper.year) : undefined,
    DOI: paper.doi,
    url: paper.arxiv_url || paper.doi_url || paper.inspire_url,
    publicationTitle: journal,
    volume: paper.publication?.volume,
    pages: paper.publication?.pages,
    issue: paper.publication?.issue,
    archive: paper.recid ? 'INSPIRE' : undefined,
    archiveLocation: paper.recid ? String(paper.recid) : undefined,
    extra: buildExtraWithIdentifiers(paper),
  };
}

function extractIdentifiersFromItemData(data: Record<string, unknown>): {
  doi?: string;
  arxiv_id?: string;
  inspire_recid?: string;
} {
  const doiField = typeof data.DOI === 'string' ? data.DOI : typeof data.doi === 'string' ? data.doi : undefined;
  const doi = doiField ? normalizeZoteroDoi(doiField) : undefined;
  const urlField = typeof data.url === 'string' ? data.url : typeof (data as any).URL === 'string' ? String((data as any).URL) : undefined;
  const doiFromUrl = urlField ? normalizeZoteroDoi(urlField) : undefined;
  const arxivField =
    typeof data.arXiv === 'string'
      ? data.arXiv
      : typeof data.arxiv === 'string'
        ? data.arxiv
        : typeof data.arXivID === 'string'
          ? data.arXivID
          : typeof data.arxivId === 'string'
            ? data.arxivId
            : undefined;
  const arxivFromUrl = (() => {
    if (!urlField) return undefined;
    const m = urlField.match(/arxiv\.org\/abs\/([^\s?#]+)/i);
    return m ? normalizeZoteroArxivId(m[1]) : undefined;
  })();
  const journalAbbrev =
    typeof (data as any).journalAbbreviation === 'string'
      ? String((data as any).journalAbbreviation)
      : typeof (data as any).journalAbbrev === 'string'
        ? String((data as any).journalAbbrev)
        : undefined;
  const arxivFromJournal = journalAbbrev ? normalizeZoteroArxivId(journalAbbrev) : undefined;
  const arxiv_id = arxivField
    ? normalizeZoteroArxivId(arxivField)
    : arxivFromUrl ?? arxivFromJournal ?? undefined;
  const archive = typeof data.archive === 'string' ? data.archive.trim() : undefined;
  const archiveLocation =
    typeof data.archiveLocation === 'string'
      ? data.archiveLocation.trim()
      : typeof (data as any).archive_location === 'string'
        ? String((data as any).archive_location).trim()
        : undefined;
  const extra = typeof data.extra === 'string' ? data.extra : '';
  const parsed = extra ? parseZoteroExtraIdentifiers(extra) : {};
  return {
    doi: doi ?? doiFromUrl ?? parsed.doi,
    arxiv_id: arxiv_id ?? parsed.arxiv_id,
    inspire_recid:
      archive && archive.toLowerCase() === 'inspire' && archiveLocation && /^\d+$/.test(archiveLocation)
        ? archiveLocation
        : parsed.inspire_recid,
  };
}

async function updateExistingZoteroItem(params: {
  item_key: string;
  collection_keys: string[];
  tags: string[];
  note?: string;
  inspire_recid?: string;
}): Promise<{ collections_added: number; tags_added: number; note_added: boolean }> {
  const getRes = await zoteroGetJson<unknown>(`/users/0/items/${encodeURIComponent(params.item_key)}`);
  const { key, data, version } = extractItemDataForUpdate(getRes.data);

  const mergedCollections = mergeCollections(data.collections, params.collection_keys);
  const mergedTags = mergeTags(data.tags, params.tags);

  const archive = typeof data.archive === 'string' ? data.archive.trim() : '';
  const canSetArchive = archive.length === 0 || archive.toLowerCase() === 'inspire';
  const nextArchive = canSetArchive && params.inspire_recid ? 'INSPIRE' : data.archive;
  const nextArchiveLocation =
    canSetArchive && params.inspire_recid ? String(params.inspire_recid) : (data as any).archiveLocation;

  const nextData: Record<string, unknown> = {
    ...data,
    collections: mergedCollections.next,
    tags: mergedTags.next,
    archive: nextArchive,
    archiveLocation: nextArchiveLocation,
  };

  const needsWriteUpdate =
    mergedCollections.added > 0
    || mergedTags.added > 0
    || (nextArchive !== data.archive)
    || (nextArchiveLocation !== (data as any).archiveLocation);

  try {
    if (needsWriteUpdate) {
      await zoteroPutJson(`/users/0/items/${encodeURIComponent(key)}`, nextData, undefined, {
        'If-Unmodified-Since-Version': version !== undefined ? String(version) : undefined,
      });
    }
  } catch (err) {
    if (!isZoteroLocalApiWriteUnsupported(err)) throw err;
    if (needsWriteUpdate) {
      throw invalidParams(
        'Zotero Local API write access appears to be disabled (cannot update existing items). Enable Local API write access in Zotero settings, or use dedupe=return_existing.',
      );
    }
  }

  let noteAdded = false;
  const noteHtml = params.note ? toZoteroNoteHtml(params.note) : '';
  if (noteHtml) {
    await createZoteroNote({ parent_item_key: key, note_html: noteHtml });
    noteAdded = true;
  }

  return {
    collections_added: mergedCollections.added,
    tags_added: mergedTags.added,
    note_added: noteAdded,
  };
}

function isZoteroLocalApiWriteUnsupported(err: unknown): boolean {
  if (!(err instanceof McpError) || err.code !== 'UPSTREAM_ERROR') return false;
  if (!isRecord(err.data)) return false;
  const status = err.data.status;
  const body = err.data.body;
  if (typeof status !== 'number') return false;
  const msg = typeof body === 'string' ? body.toLowerCase() : '';
  return (
    status === 400
    || status === 501
    || msg.includes('method not implemented')
    || msg.includes('does not support method')
  );
}

async function zoteroConnectorSaveItems(params: {
  items: unknown[];
  uri: string;
}): Promise<void> {
  await zoteroConnectorPostJson('/connector/saveItems', {
    items: params.items,
    uri: params.uri,
  });
}

async function createZoteroNote(params: { parent_item_key: string; note_html: string }): Promise<void> {
  try {
    await zoteroPostJson('/users/0/items', [{
      itemType: 'note',
      parentItem: params.parent_item_key,
      note: params.note_html,
    }]);
    return;
  } catch (err) {
    if (!isZoteroLocalApiWriteUnsupported(err)) throw err;
  }

  await zoteroConnectorSaveItems({
    items: [{
      itemType: 'note',
      parentItem: params.parent_item_key,
      note: params.note_html,
    }],
    uri: 'https://local.zotero/connector/saveItems',
  });
}

async function findCreatedItemKey(params: {
  title?: string;
  identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
}): Promise<string> {
  const attempts = 10;
  for (let i = 0; i < attempts; i += 1) {
    const query = {
      doi: params.identifiers.doi,
      arxiv_id: params.identifiers.arxiv_id,
      inspire_recid: params.identifiers.inspire_recid,
      title: params.title,
    };

    const res = await zoteroFindItems({ identifiers: query, limit: 20, include_attachments: false, match: 'exact' });
    const first = res.matches[0];
    if (first?.item_key) return first.item_key;

    await new Promise(r => setTimeout(r, 150));
  }

  throw invalidParams('Created item was not found in Zotero after connector saveItems (try again)', {
    identifiers: params.identifiers,
    title: params.title,
  });
}

async function createZoteroItem(params: {
  data: Record<string, unknown>;
  collection_keys: string[];
  tags: string[];
  note?: string;
}): Promise<{ item_key: string; note_added: boolean }> {
  const payloadData: Record<string, unknown> = {
    ...params.data,
    collections: params.collection_keys,
    tags: zoteroTagsPayload(params.tags),
  };

  let itemKey: string | undefined;
  try {
    const created = await zoteroPostJson<unknown>('/users/0/items', [payloadData]);
    itemKey = extractCreatedItemKey(created.data);
    if (!itemKey) throw invalidParams('Zotero Local API did not return created item key');
  } catch (err) {
    if (!isZoteroLocalApiWriteUnsupported(err)) throw err;

    if (params.collection_keys.length > 0) {
      if (params.collection_keys.length !== 1) {
        throw invalidParams(
          'Zotero Local API write access appears to be disabled. Connector saveItems cannot reliably target multiple collections. Select a single collection in Zotero (left sidebar) or enable Local API write access.',
          { collection_keys: params.collection_keys }
        );
      }

      const selected = await resolveSelectedCollectionKey({ allow_library_root: false });
      if (selected.kind !== 'collection') {
        throw invalidParams(
          'Zotero Local API write access appears to be disabled and Zotero is currently selecting the library root. Select the desired collection in Zotero (left sidebar) or enable Local API write access.',
        );
      }
      if (selected.collection_key !== params.collection_keys[0]) {
        throw invalidParams(
          'Zotero Local API write access appears to be disabled. To use connector saveItems, Zotero must be currently selecting the target collection. Select the target collection in Zotero, or enable Local API write access.',
          { selected_collection_key: selected.collection_key, requested_collection_key: params.collection_keys[0] }
        );
      }
    }

    const uri = typeof payloadData.url === 'string' && payloadData.url.trim()
      ? payloadData.url.trim()
      : 'https://local.zotero/connector/saveItems';
    await zoteroConnectorSaveItems({ items: [payloadData], uri });

    const identifiers = extractIdentifiersFromItemData(payloadData);
    const title = typeof payloadData.title === 'string' ? payloadData.title : undefined;
    itemKey = await findCreatedItemKey({ title, identifiers });
  }

  let noteAdded = false;
  const noteHtml = params.note ? toZoteroNoteHtml(params.note) : '';
  if (noteHtml) {
    await createZoteroNote({ parent_item_key: itemKey, note_html: noteHtml });
    noteAdded = true;
  }

  return { item_key: itemKey, note_added: noteAdded };
}

async function dedupeFindFirst(params: {
  identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string; item_key?: string };
}): Promise<{ item_key: string; title?: string; identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string } } | undefined> {
  const res = await zoteroFindItems({
    identifiers: params.identifiers,
    limit: 20,
    include_attachments: false,
    match: 'exact',
  });
  const first = res.matches[0];
  if (!first) return undefined;
  return { item_key: first.item_key, title: first.title, identifiers: first.identifiers };
}

export async function zoteroAdd(params: {
  source:
    | { type: 'item'; item: Record<string, unknown> }
    | { type: 'inspire'; recid: string }
    | { type: 'doi'; doi: string }
    | { type: 'arxiv'; arxiv_id: string };
  collection_keys?: string[];
  allow_library_root?: boolean;
  tags?: string[];
  note?: string;
  dedupe?: 'return_existing' | 'update_existing' | 'error_on_existing';
  open_in_zotero?: boolean;
}): Promise<{
  status: 'created' | 'existing' | 'updated';
  item_key: string;
  select_uri?: string;
  summary: {
    title?: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    collections_added: number;
    tags_added: number;
    note_added: boolean;
  };
}> {
  const allowLibraryRoot = params.allow_library_root ?? false;
  const tags = normalizeTagStrings(params.tags);
  const dedupe = params.dedupe ?? 'return_existing';
  const open = params.open_in_zotero ?? true;
  const note = typeof params.note === 'string' ? params.note : undefined;
  const requestedCollectionKeys = normalizeCollectionKeys(params.collection_keys);
  const resolvedSelected =
    requestedCollectionKeys.length > 0
      ? undefined
      : await resolveSelectedCollectionKey({ allow_library_root: allowLibraryRoot });
  const effectiveCollectionKeys =
    requestedCollectionKeys.length > 0
      ? requestedCollectionKeys
      : resolvedSelected?.kind === 'collection'
        ? [resolvedSelected.collection_key]
        : [];

  let data: Record<string, unknown>;
  let title: string | undefined;
  let identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };

  if (params.source.type === 'item') {
    if (!isRecord(params.source.item)) throw invalidParams('item must be an object');
    data = params.source.item as Record<string, unknown>;
    let approxBytes = 0;
    try {
      approxBytes = JSON.stringify(data).length;
    } catch {
      throw invalidParams('item must be JSON-serializable');
    }
    if (approxBytes > 200_000) {
      throw invalidParams('item payload too large (max ~200KB JSON)', { approx_bytes: approxBytes });
    }

    identifiers = extractIdentifiersFromItemData(data);
    title = typeof data.title === 'string' ? data.title : undefined;
  } else if (params.source.type === 'doi') {
    const doi = normalizeZoteroDoi(normalizeZoteroExactIdentifier(params.source.doi, 'doi'));
    if (!doi) throw invalidParams('Unrecognized DOI format', { doi: params.source.doi });
    const paper = await inspireApi.getByDoi(doi);
    data = buildZoteroItemFromPaper(paper as unknown as Paper);
    title = paper.title;
    identifiers = { doi: paper.doi, arxiv_id: paper.arxiv_id, inspire_recid: paper.recid };
  } else if (params.source.type === 'arxiv') {
    const arxiv_id = normalizeZoteroArxivId(normalizeZoteroExactIdentifier(params.source.arxiv_id, 'arxiv_id'));
    if (!arxiv_id) throw invalidParams('Unrecognized arXiv ID format', { arxiv_id: params.source.arxiv_id });
    const paper = await inspireApi.getByArxiv(arxiv_id);
    data = buildZoteroItemFromPaper(paper as unknown as Paper);
    title = paper.title;
    identifiers = { doi: paper.doi, arxiv_id: paper.arxiv_id, inspire_recid: paper.recid };
  } else {
    const recid = normalizeZoteroExactIdentifier(params.source.recid, 'recid');
    if (!/^\d+$/.test(recid)) throw invalidParams('recid must be numeric', { recid: params.source.recid });
    const paper = await inspireApi.getPaper(recid);
    data = buildZoteroItemFromPaper(paper as unknown as Paper);
    title = paper.title;
    identifiers = { doi: paper.doi, arxiv_id: paper.arxiv_id, inspire_recid: paper.recid };
  }

  const dedupeCandidates: Array<{ doi?: string; arxiv_id?: string; inspire_recid?: string }> = [];
  // Prefer stable identifiers that don't require zotero-inspire to have written INSPIRE:<recid> anywhere.
  if (identifiers.doi) dedupeCandidates.push({ doi: identifiers.doi });
  if (identifiers.arxiv_id) dedupeCandidates.push({ arxiv_id: identifiers.arxiv_id });
  if (identifiers.inspire_recid) dedupeCandidates.push({ inspire_recid: identifiers.inspire_recid });

  for (const candidate of dedupeCandidates) {
    const existing = await dedupeFindFirst({ identifiers: candidate });
    if (!existing) continue;

    if (dedupe === 'return_existing') {
      return {
        status: 'existing',
        item_key: existing.item_key,
        select_uri: open ? buildZoteroSelectUri(existing.item_key) : undefined,
        summary: {
          title: existing.title,
          identifiers: existing.identifiers,
          collections_added: 0,
          tags_added: 0,
          note_added: false,
        },
      };
    }
    if (dedupe === 'error_on_existing') {
      throw invalidParams('Item already exists in Zotero', {
        item_key: existing.item_key,
        identifiers,
      });
    }

    const updated = await updateExistingZoteroItem({
      item_key: existing.item_key,
      collection_keys: effectiveCollectionKeys,
      tags,
      note,
      inspire_recid: identifiers.inspire_recid,
    });

    return {
      status: 'updated',
      item_key: existing.item_key,
      select_uri: open ? buildZoteroSelectUri(existing.item_key) : undefined,
      summary: {
        title: existing.title,
        identifiers: existing.identifiers,
        collections_added: updated.collections_added,
        tags_added: updated.tags_added,
        note_added: updated.note_added,
      },
    };
  }

  if (effectiveCollectionKeys.length === 0 && !allowLibraryRoot) {
    throw invalidParams(
      'No collection selected. Please select a collection in Zotero (left sidebar), provide collection_keys explicitly, or set allow_library_root=true to write to library root.'
    );
  }

  const created = await createZoteroItem({ data, collection_keys: effectiveCollectionKeys, tags, note });
  return {
    status: 'created',
    item_key: created.item_key,
    select_uri: open ? buildZoteroSelectUri(created.item_key) : undefined,
    summary: {
      title,
      identifiers,
      collections_added: effectiveCollectionKeys.length,
      tags_added: tags.length,
      note_added: created.note_added,
    },
  };
}

export async function hepImportFromZotero(params: {
  run_id: string;
  collection_key?: string;
  item_keys?: string[];
  limit?: number;
  start?: number;
  concurrency?: number;
  budget_hints?: {
    concurrency_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: { items_total: number; resolved_recids: number; attachments_total: number; pdf_attachments_total: number };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const run = getRun(runId);

  const limit = params.limit ?? 200;
  const start = params.start ?? 0;
  const collectionKey = params.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;

  const itemKeySet = new Set<string>();
  for (const k of (params.item_keys || [])) {
    itemKeySet.add(normalizeZoteroKey(k, 'item_keys'));
  }

  const { stepIndex, step } = await startRunStep(runId, 'hep_import_from_zotero');
  const artifacts: RunArtifactRef[] = [];
  const budget = new BudgetTrackerV1();
  const externalApiCalls: Array<{
    version: 1;
    namespace: string;
    operation: string;
    request_hash: string;
    cache_hit: boolean;
    cached_response_uri: string;
    request_uri: string;
    response_uri: string;
  }> = [];

  try {
    const concurrency = budget.resolveInt({
      key: 'budget.concurrency',
      dimension: 'budget',
      unit: 'requests',
      arg_path: 'concurrency',
      tool_value: params.concurrency,
      tool_value_present: params.budget_hints?.concurrency_provided ?? params.concurrency !== undefined,
      env_var: 'HEP_BUDGET_CONCURRENCY',
      default_value: 4,
      min: 1,
      max: 16,
    });
    budget.warn({
      severity: 'info',
      code: 'concurrency',
      message: `Zotero import parallelism: concurrency=${concurrency}.`,
      data: { concurrency },
    });

    if (collectionKey) {
      const listRes = await zoteroGetJson<unknown[]>(
        `/users/0/collections/${encodeURIComponent(collectionKey)}/items/top`,
        { limit, start }
      );
      for (const it of Array.isArray(listRes.data) ? listRes.data : []) {
        if (!isRecord(it)) continue;
        const k = it.key;
        if (typeof k !== 'string') continue;
        itemKeySet.add(normalizeZoteroKey(k, 'item_keys'));
      }
    }

    const itemKeys = Array.from(itemKeySet);
    if (itemKeys.length === 0) {
      throw invalidParams('Either collection_key or item_keys must be provided');
    }

    const limiter = pLimit(concurrency);
    const perItem = await Promise.all(
      itemKeys.map(itemKey =>
        limiter(async () => {
          const [itemRes, childRes] = await Promise.all([
            zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(itemKey)}`),
            zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/children`),
          ]);

          const children = Array.isArray(childRes.data) ? childRes.data : [];
          const attachments = parseAttachmentSummaries(children);

          const ids = extractZoteroItemIdentifiers(itemRes.data);
          const resolvedRecid = await (async () => {
            if (ids.inspire_recid) {
              return { recid: ids.inspire_recid, method: 'inspire_recid', confidence: 1 };
            }
            if (ids.doi) {
              const doi = ids.doi;
              const cached = await cachedExternalApiJsonCall({
                run_id: runId,
                namespace: 'inspire',
                operation: 'getByDoi',
                request: { doi },
                fetch: () => inspireApi.getByDoi(doi),
              });
              const [requestRef, responseRef] = cached.artifacts;
              externalApiCalls.push({
                version: 1,
                namespace: 'inspire',
                operation: 'getByDoi',
                request_hash: cached.request_hash,
                cache_hit: cached.cache_hit,
                cached_response_uri: cached.cached_response_uri,
                request_uri: requestRef.uri,
                response_uri: responseRef.uri,
              });
              const paper = cached.response as unknown as Paper;
              return { recid: paper.recid, method: 'doi', confidence: 1 };
            }
            if (ids.arxiv_id) {
              const arxivId = ids.arxiv_id;
              const cached = await cachedExternalApiJsonCall({
                run_id: runId,
                namespace: 'inspire',
                operation: 'getByArxiv',
                request: { arxiv_id: arxivId },
                fetch: () => inspireApi.getByArxiv(arxivId),
              });
              const [requestRef, responseRef] = cached.artifacts;
              externalApiCalls.push({
                version: 1,
                namespace: 'inspire',
                operation: 'getByArxiv',
                request_hash: cached.request_hash,
                cache_hit: cached.cache_hit,
                cached_response_uri: cached.cached_response_uri,
                request_uri: requestRef.uri,
                response_uri: responseRef.uri,
              });
              const paper = cached.response as unknown as Paper;
              return { recid: paper.recid, method: 'arxiv', confidence: 1 };
            }
            return null;
          })();

          return {
            attachments_total: attachments.length,
            pdf_attachments_total: attachments.filter(isPdfAttachment).length,
            resolved_recid: resolvedRecid,
            item: {
              zotero_item_key: ids.zotero_item_key,
              title: ids.title,
              identifiers: {
                doi: ids.doi,
                arxiv_id: ids.arxiv_id,
                inspire_recid: ids.inspire_recid,
              },
              resolve: resolvedRecid,
              attachments,
              warnings: ids.warnings,
              zotero_meta: {
                item_url: itemRes.meta.url,
                children_url: childRes.meta.url,
              },
            },
          };
        })
      )
    );

    const items = perItem.map(r => r.item);
    const resolved = perItem.filter(r => r.resolved_recid !== null).length;
    const attachmentsTotal = perItem.reduce((acc, r) => acc + r.attachments_total, 0);
    const pdfAttachmentsTotal = perItem.reduce((acc, r) => acc + r.pdf_attachments_total, 0);

    const mapRef = writeRunJsonArtifact(runId, 'zotero_map.json', {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      project_id: run.project_id,
      source: {
        collection_key: collectionKey,
        list_limit: collectionKey ? limit : undefined,
        list_start: collectionKey ? start : undefined,
        item_keys: itemKeys,
        concurrency,
      },
      items,
    });
    artifacts.push(mapRef);

    const externalCallsRef = writeRunJsonArtifact(runId, 'external_api_calls_inspire_zotero_import_v1.json', {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      project_id: run.project_id,
      calls: externalApiCalls,
      stats: {
        calls_total: externalApiCalls.length,
        cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
        cache_misses: externalApiCalls.filter(c => !c.cache_hit).length,
      },
    });
    artifacts.push(externalCallsRef);

    const diag = writeRunStepDiagnosticsArtifact({
      run_id: runId,
      project_id: run.project_id,
      step: step.step,
      step_index: stepIndex,
      ...budget.snapshot(),
    });
    artifacts.push(diag.run, diag.project);

    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        items_total: itemKeys.length,
        resolved_recids: resolved,
        attachments_total: attachmentsTotal,
        pdf_attachments_total: pdfAttachmentsTotal,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}
