import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import { invalidParams, McpError, notFound } from '@autoresearch/shared';

import type { Paper } from '@autoresearch/shared';
import * as inspireApi from './inspireClient.js';
import * as crossrefApi from './crossrefClient.js';
import {
  zoteroConnectorPostJson,
  zoteroConnectorPostVoid,
  zoteroGetBinary,
  zoteroGetJson,
  zoteroGetJsonAllow404,
  zoteroGetText,
  zoteroPostJson,
  zoteroPutJson,
} from './client.js';
import { createConfirmAction, type ZoteroAddConfirmPayloadV1 } from './confirm.js';
import {
  extractZoteroItemIdentifiers,
  type ZoteroItemIdentifiers,
  normalizeZoteroArxivId,
  normalizeZoteroDoi,
  parseZoteroExtraIdentifiers,
} from './identifiers.js';
import {
  isRecord,
  normalizeZoteroKey,
  parseAttachmentSummaries,
  isPdfAttachment,
} from '../shared/zotero/helpers.js';

function isRecordWithKey(value: unknown): value is { key: string; data?: unknown } {
  return isRecord(value) && typeof value.key === 'string' && Boolean(value.key.trim());
}

function readStringField(obj: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function readNumberField(obj: Record<string, unknown>, candidates: string[]): number | undefined {
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function normalizeZoteroExactIdentifier(value: string, fieldName: string): string {
  const v = value.trim();
  if (!v) throw invalidParams(`${fieldName} cannot be empty`);
  return v;
}

function buildZoteroSelectUri(itemKey: string): string {
  return `zotero://select/library/items/${encodeURIComponent(itemKey)}`;
}

function sha256FileHex(filePath: string): { sha256: string; bytes: number } {
  const h = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  let bytes = 0;
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      offset += n;
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest('hex'), bytes };
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

function resolveZoteroFulltextCachePath(attachmentKey: string): string {
  const dataDir = resolveZoteroDataDir();
  return path.join(dataDir, 'storage', attachmentKey, '.zotero-ft-cache');
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

function buildExtraWithIdentifiers(paper: Paper): string {
  const lines: string[] = [];
  if (paper.arxiv_id) {
    const primary = paper.arxiv_categories?.[0];
    if (primary && /^\d/.test(paper.arxiv_id)) lines.push(`arXiv:${paper.arxiv_id} [${primary}]`);
    else lines.push(`arXiv:${paper.arxiv_id}`);
  }
  return lines.join('\n');
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

type ZoteroCreatorSummary = { creatorType?: string; name?: string; firstName?: string; lastName?: string };

type ZoteroItemDataSummary = {
  itemType?: string;
  title?: string;
  creators?: ZoteroCreatorSummary[];
  date?: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  archive?: string;
  archiveLocation?: string;
};

function summarizeZoteroItemData(data: Record<string, unknown>): ZoteroItemDataSummary {
  const pick = (k: string) => (Object.prototype.hasOwnProperty.call(data, k) ? (data as any)[k] : undefined);
  const safeString = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined);

  const title = safeString(pick('title')) ?? safeString(pick('Title'));
  const itemType = safeString(pick('itemType')) ?? safeString(pick('item_type'));
  const doi = safeString(pick('DOI')) ?? safeString(pick('doi'));
  const url = safeString(pick('url')) ?? safeString(pick('URL'));
  const date = safeString(pick('date'));
  const publicationTitle = safeString(pick('publicationTitle'));
  const archive = safeString(pick('archive'));
  const archiveLocation = safeString(pick('archiveLocation')) ?? safeString(pick('archive_location'));

  const creatorsRaw = pick('creators');
  const creators = Array.isArray(creatorsRaw)
    ? creatorsRaw
        .slice(0, 10)
        .map(c => {
          if (!isRecord(c)) return null;
          const creatorType = typeof c.creatorType === 'string' ? c.creatorType : undefined;
          const name = typeof c.name === 'string' ? c.name : undefined;
          const firstName = typeof c.firstName === 'string' ? c.firstName : undefined;
          const lastName = typeof c.lastName === 'string' ? c.lastName : undefined;
          return { creatorType, name, firstName, lastName };
        })
        .filter(Boolean) as ZoteroCreatorSummary[]
    : undefined;

  return {
    itemType,
    title,
    creators,
    date,
    DOI: doi,
    url,
    publicationTitle,
    archive,
    archiveLocation,
  };
}

type ZoteroItemSummary = {
  item_key: string;
  item_type?: string;
  title?: string;
  select_uri: string;
  identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
  creators?: ZoteroCreatorSummary[];
  date?: string;
  publication_title?: string;
};

type ZoteroItemSummaryWithAttachments = ZoteroItemSummary & { attachment_keys?: string[] };

function buildZoteroItemSummary(item: unknown, extracted?: ZoteroItemIdentifiers): ZoteroItemSummary | null {
  if (!isRecordWithKey(item)) return null;
  const data = isRecord((item as any).data) ? ((item as any).data as Record<string, unknown>) : {};
  const summary = summarizeZoteroItemData(data);
  const parsed = extracted ?? extractZoteroItemIdentifiers(item);
  const title = summary.title ?? parsed.title;

  return {
    item_key: parsed.zotero_item_key,
    item_type: summary.itemType,
    title,
    select_uri: buildZoteroSelectUri(parsed.zotero_item_key),
    identifiers: {
      doi: parsed.doi,
      arxiv_id: parsed.arxiv_id,
      inspire_recid: parsed.inspire_recid,
    },
    creators: summary.creators,
    date: summary.date,
    publication_title: summary.publicationTitle,
  };
}

export async function zoteroListCollections(params?: {
  limit?: number;
  start?: number;
}): Promise<{
  meta: { url: string; status: number; total_results?: number };
  collections: unknown[];
}> {
  const limit = params?.limit ?? 50;
  const start = params?.start ?? 0;
  const res = await zoteroGetJson<unknown[]>('/users/0/collections', { limit, start });
  return { meta: res.meta, collections: res.data };
}

export async function zoteroListItems(params?: {
  collection_key?: string;
  limit?: number;
  start?: number;
}): Promise<{
  meta: { url: string; status: number; total_results?: number };
  scope: { kind: 'collection'; collection_key: string } | { kind: 'library_top' };
  items: unknown[];
}> {
  const limit = params?.limit ?? 20;
  const start = params?.start ?? 0;
  const collectionKey = params?.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;

  if (collectionKey) {
    const res = await zoteroGetJson<unknown[]>(`/users/0/collections/${encodeURIComponent(collectionKey)}/items/top`, { limit, start });
    return { meta: res.meta, scope: { kind: 'collection', collection_key: collectionKey }, items: res.data };
  }

  const res = await zoteroGetJson<unknown[]>('/users/0/items/top', { limit, start });
  return { meta: res.meta, scope: { kind: 'library_top' }, items: res.data };
}

type ZoteroItemsScope = { kind: 'collection'; collection_key: string } | { kind: 'library' };

async function queryZoteroItems(params: {
  scope: ZoteroItemsScope;
  top_level_only: boolean;
  q?: string;
  qmode?: 'titleCreatorYear' | 'everything';
  tag?: string;
  itemType?: string;
  includeTrashed?: boolean;
  sort?: 'dateAdded' | 'dateModified' | 'title' | 'creator' | 'itemType' | 'date';
  direction?: 'asc' | 'desc';
  limit: number;
  start: number;
}): Promise<{ meta: { url: string; status: number; total_results?: number }; items: unknown[] }> {
  const pathname = (() => {
    if (params.scope.kind === 'collection') {
      const base = `/users/0/collections/${encodeURIComponent(params.scope.collection_key)}/items`;
      return params.top_level_only ? `${base}/top` : base;
    }
    return params.top_level_only ? '/users/0/items/top' : '/users/0/items';
  })();

  const res = await zoteroGetJson<unknown[]>(pathname, {
    q: params.q,
    qmode: params.q ? params.qmode : undefined,
    tag: params.tag,
    itemType: params.itemType,
    includeTrashed: params.includeTrashed ? 1 : undefined,
    sort: params.sort,
    direction: params.direction,
    limit: params.limit,
    start: params.start,
  });

  return {
    meta: res.meta,
    items: Array.isArray(res.data) ? res.data : [],
  };
}

export async function zoteroSearchItems(params: {
  q?: string;
  qmode?: 'titleCreatorYear' | 'everything';
  tag?: string;
  item_type?: string;
  collection_key?: string;
  top_level_only?: boolean;
  include_trashed?: boolean;
  sort?: 'dateAdded' | 'dateModified' | 'title' | 'creator' | 'itemType' | 'date';
  direction?: 'asc' | 'desc';
  limit?: number;
  start?: number;
}): Promise<{
  meta: { url: string; status: number; total_results?: number };
  scope: { kind: 'collection'; collection_key: string } | { kind: 'library' };
  query: {
    q?: string;
    qmode?: 'titleCreatorYear' | 'everything';
    tag?: string;
    item_type?: string;
    collection_key?: string;
    top_level_only: boolean;
    include_trashed: boolean;
    sort?: 'dateAdded' | 'dateModified' | 'title' | 'creator' | 'itemType' | 'date';
    direction?: 'asc' | 'desc';
    limit: number;
    start: number;
  };
  items: Array<{
    item_key: string;
    item_type?: string;
    title?: string;
    select_uri: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    creators?: ZoteroCreatorSummary[];
    date?: string;
    publication_title?: string;
  }>;
  summary: { returned: number; total_results_header?: number };
}> {
  const q = params.q?.trim() || undefined;
  const tag = params.tag?.trim() || undefined;
  const itemType = params.item_type?.trim() || undefined;
  const collectionKey = params.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;
  const topLevelOnly = params.top_level_only ?? true;
  const includeTrashed = params.include_trashed ?? false;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const start = Math.max(params.start ?? 0, 0);

  const scope = collectionKey ? { kind: 'collection' as const, collection_key: collectionKey } : { kind: 'library' as const };
  const res = await queryZoteroItems({
    scope,
    top_level_only: topLevelOnly,
    q,
    qmode: q ? params.qmode ?? 'titleCreatorYear' : undefined,
    tag,
    itemType,
    includeTrashed,
    sort: params.sort,
    direction: params.direction,
    limit,
    start,
  });

  const items: ZoteroItemSummary[] = [];

  for (const item of res.items) {
    const summary = buildZoteroItemSummary(item);
    if (!summary) continue;
    items.push(summary);
  }

  return {
    meta: res.meta,
    scope,
    query: {
      q,
      qmode: q ? (params.qmode ?? 'titleCreatorYear') : undefined,
      tag,
      item_type: itemType,
      collection_key: collectionKey,
      top_level_only: topLevelOnly,
      include_trashed: includeTrashed,
      sort: params.sort,
      direction: params.direction,
      limit,
      start,
    },
    items,
    summary: {
      returned: items.length,
      total_results_header: res.meta.total_results,
    },
  };
}

function sha256HexString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function zoteroGetItem(params: { item_key: string }): Promise<{
  item_key: string;
  select_uri: string;
  identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string };
  item: unknown;
  warnings: string[];
}> {
  const itemKey = normalizeZoteroKey(params.item_key, 'item_key');
  const res = await zoteroGetJson<unknown>(`/users/0/items/${encodeURIComponent(itemKey)}`);
  const extracted = extractZoteroItemIdentifiers(res.data);
  return {
    item_key: itemKey,
    select_uri: buildZoteroSelectUri(itemKey),
    identifiers: {
      doi: extracted.doi,
      arxiv_id: extracted.arxiv_id,
      inspire_recid: extracted.inspire_recid,
      title: extracted.title,
    },
    item: res.data,
    warnings: extracted.warnings,
  };
}

export async function zoteroGetItemAttachments(params: { item_key: string }): Promise<{
  item_key: string;
  select_uri: string;
  attachments: Array<{
    attachment_key: string;
    select_uri: string;
    filename?: string;
    content_type?: string;
    link_mode?: string;
    is_pdf: boolean;
  }>;
  summary: { attachments_total: number; pdf_attachments_total: number };
}> {
  const itemKey = normalizeZoteroKey(params.item_key, 'item_key');
  const res = await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/children`);
  const children = Array.isArray(res.data) ? res.data : [];
  const attachments = parseAttachmentSummaries(children).map(att => ({
    ...att,
    select_uri: buildZoteroSelectUri(att.attachment_key),
    is_pdf: isPdfAttachment(att),
  }));
  const pdf = attachments.filter(a => a.is_pdf).length;
  return {
    item_key: itemKey,
    select_uri: buildZoteroSelectUri(itemKey),
    attachments,
    summary: { attachments_total: attachments.length, pdf_attachments_total: pdf },
  };
}

export async function zoteroDownloadAttachment(params: { attachment_key: string }): Promise<{
  attachment_key: string;
  select_uri: string;
  filename?: string;
  content_type?: string;
  link_mode?: string;
  file_path: string;
  sha256: string;
  size: number;
  source: 'file_redirect' | 'inline_bytes';
  meta: { item_url: string; file_url: string; redirected_location?: string };
}> {
  const attachmentKey = normalizeZoteroKey(params.attachment_key, 'attachment_key');

  const itemRes = await zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(attachmentKey)}`);
  const item = itemRes.data;
  if (!isRecordWithKey(item)) {
    throw invalidParams('Invalid Zotero attachment item (missing key)');
  }

  const data = isRecord(item.data) ? item.data : {};
  const filename = typeof (data as any).filename === 'string' ? String((data as any).filename) : undefined;
  const contentType = typeof (data as any).contentType === 'string' ? String((data as any).contentType) : undefined;
  const linkMode = typeof (data as any).linkMode === 'string' ? String((data as any).linkMode) : undefined;

  const fileRes = await zoteroGetBinary(`/users/0/items/${encodeURIComponent(attachmentKey)}/file`);

  if (fileRes.kind === 'file') {
    if (!fs.existsSync(fileRes.filePath)) {
      throw notFound('Zotero attachment file not found on disk', {
        attachment_key: attachmentKey,
        file_path: fileRes.filePath,
      });
    }
    const stat = fs.statSync(fileRes.filePath);
    if (!stat.isFile()) {
      throw invalidParams('Zotero attachment file path is not a file', { file_path: fileRes.filePath });
    }

    const { sha256, bytes } = sha256FileHex(fileRes.filePath);
    return {
      attachment_key: attachmentKey,
      select_uri: buildZoteroSelectUri(attachmentKey),
      filename,
      content_type: contentType,
      link_mode: linkMode,
      file_path: fileRes.filePath,
      sha256,
      size: bytes,
      source: 'file_redirect',
      meta: {
        item_url: itemRes.meta.url,
        file_url: fileRes.url,
        redirected_location: fileRes.location,
      },
    };
  }

  const tmpName = `zotero-mcp-${attachmentKey}-${randomUUID()}`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  fs.writeFileSync(tmpPath, Buffer.from(fileRes.bytes));
  const sha256 = inspireApi.sha256Hex(fileRes.bytes);

  return {
    attachment_key: attachmentKey,
    select_uri: buildZoteroSelectUri(attachmentKey),
    filename,
    content_type: contentType,
    link_mode: linkMode,
    file_path: tmpPath,
    sha256,
    size: fileRes.bytes.length,
    source: 'inline_bytes',
    meta: {
      item_url: itemRes.meta.url,
      file_url: fileRes.url,
    },
  };
}

export async function zoteroGetAttachmentFulltext(params: { attachment_key: string }): Promise<{
  attachment_key: string;
  status: 'ok' | 'not_indexed';
  source: 'ft_cache_file';
  zotero_data_dir: string;
  file_path?: string;
  expected_cache_path: string;
  size?: number;
  guidance?: string[];
}> {
  const attachmentKey = normalizeZoteroKey(params.attachment_key, 'attachment_key');
  const zoteroDataDir = resolveZoteroDataDir();
  const cachePath = resolveZoteroFulltextCachePath(attachmentKey);

  if (!fs.existsSync(cachePath)) {
    return {
      attachment_key: attachmentKey,
      status: 'not_indexed',
      source: 'ft_cache_file',
      zotero_data_dir: zoteroDataDir,
      expected_cache_path: cachePath,
      guidance: [
        'Ensure Zotero has indexed the attachment (Full Text Indexing).',
        'Verify ZOTERO_DATA_DIR points to the Zotero data directory containing storage/<attachmentKey>/.zotero-ft-cache.',
      ],
    };
  }

  const stat = fs.statSync(cachePath);
  if (!stat.isFile() || stat.size <= 0) {
    return {
      attachment_key: attachmentKey,
      status: 'not_indexed',
      source: 'ft_cache_file',
      zotero_data_dir: zoteroDataDir,
      expected_cache_path: cachePath,
      guidance: ['Zotero fulltext cache exists but is empty; re-index the attachment in Zotero.'],
    };
  }

  return {
    attachment_key: attachmentKey,
    status: 'ok',
    source: 'ft_cache_file',
    zotero_data_dir: zoteroDataDir,
    expected_cache_path: cachePath,
    file_path: cachePath,
    size: stat.size,
  };
}

function normalizePathPart(part: string): string {
  return part.replace(/\s+/g, ' ').trim();
}

function samePathParts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
    const p = [...(parentPath ?? []), node.name];
    cache.set(key, p);
    return p;
  }

  const out: Array<{ key: string; pathParts: string[] }> = [];
  for (const key of nodes.keys()) {
    const pathParts = resolvePath(key);
    if (!pathParts || pathParts.length === 0) continue;
    out.push({ key, pathParts });
  }

  return out;
}

async function listAllZoteroCollectionsWithMeta(): Promise<{
  meta: { url: string; status: number; total_results?: number };
  collections: unknown[];
}> {
  const out: unknown[] = [];
  const limit = 200;
  let start = 0;
  let meta: { url: string; status: number; total_results?: number } | undefined;

  for (let page = 0; page < 100; page += 1) {
    const res = await zoteroGetJson<unknown[]>('/users/0/collections', { limit, start });
    if (!meta) meta = res.meta;
    const data = Array.isArray(res.data) ? res.data : [];
    out.push(...data);
    if (data.length < limit) break;
    start += limit;
    if (res.meta.total_results !== undefined && out.length >= res.meta.total_results) break;
  }

  return { meta: meta ?? { url: '/users/0/collections', status: 200 }, collections: out };
}

export async function zoteroListCollectionPaths(params?: {
  query?: string;
  match?: 'contains' | 'starts_with';
  case_sensitive?: boolean;
  limit?: number;
  start?: number;
}): Promise<{
  meta: { url: string; status: number; total_results?: number };
  query: { query?: string; match: 'contains' | 'starts_with'; case_sensitive: boolean; limit: number; start: number };
  collection_paths: Array<{ collection_key: string; path_parts: string[]; path: string }>;
  summary: { returned: number; total: number; filtered: number };
}> {
  const qRaw = typeof params?.query === 'string' ? params.query.trim() : '';
  const query = qRaw ? qRaw : undefined;
  const match = params?.match ?? 'contains';
  const caseSensitive = params?.case_sensitive ?? false;
  const limit = Math.min(Math.max(Math.trunc(params?.limit ?? 200), 1), 500);
  const start = Math.max(Math.trunc(params?.start ?? 0), 0);

  const res = await listAllZoteroCollectionsWithMeta();
  const paths = buildLocalCollectionPaths(res.collections)
    .map(p => ({ collection_key: p.key, path_parts: p.pathParts, path: p.pathParts.join(' / ') }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const normalizedQuery = query && !caseSensitive ? query.toLowerCase() : query;
  const filtered = normalizedQuery
    ? paths.filter(p => {
        const hay = caseSensitive ? p.path : p.path.toLowerCase();
        if (match === 'starts_with') return hay.startsWith(normalizedQuery);
        return hay.includes(normalizedQuery);
      })
    : paths;

  const slice = filtered.slice(start, start + limit);
  return {
    meta: res.meta,
    query: {
      query,
      match,
      case_sensitive: caseSensitive,
      limit,
      start,
    },
    collection_paths: slice,
    summary: {
      returned: slice.length,
      total: paths.length,
      filtered: filtered.length,
    },
  };
}

async function resolveSelectedCollectionKey(params: {
  allow_library_root: boolean;
}): Promise<
  | { kind: 'collection'; collection_key: string; path: string; library_id?: number; collection_name: string }
  | { kind: 'library_root'; path: string; library_id?: number }
> {
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

  const targetsRaw = (payload as any).targets;
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
  const trimmed = keys
    .filter(k => typeof k === 'string')
    .map(k => normalizeZoteroKey(k, 'collection_keys'));
  return Array.from(new Set(trimmed));
}

function zoteroTagsPayload(tags: string[]): Array<{ tag: string }> {
  return tags.map(tag => ({ tag }));
}

function toZoteroNoteHtml(markdown: string): string {
  const t = markdown.trim();
  if (!t) return '';
  // Minimal plaintext → HTML wrapper; Zotero expects HTML.
  const escaped = t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div>${escaped.replace(/\n/g, '<br/>')}</div>`;
}

function extractCreatedItemKey(payload: unknown): string | undefined {
  // Zotero returns { successful: { "0": { key: "...", version: ... } } }
  if (!isRecord(payload)) return undefined;
  const successful = payload.successful;
  if (!isRecord(successful)) return undefined;
  for (const v of Object.values(successful)) {
    if (!isRecord(v)) continue;
    const key = v.key;
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  return undefined;
}

function mergeCollections(existing: unknown, toAdd: string[]): { merged: string[]; added: number } {
  const out = new Set<string>();
  if (Array.isArray(existing)) {
    for (const c of existing) {
      if (typeof c === 'string' && c.trim()) out.add(c.trim());
    }
  }
  const before = out.size;
  for (const c of toAdd) out.add(c);
  return { merged: Array.from(out), added: out.size - before };
}

function mergeTags(existing: unknown, toAdd: string[]): { merged: Array<{ tag: string }>; added: number } {
  const out = new Map<string, { tag: string }>();
  if (Array.isArray(existing)) {
    for (const t of existing) {
      if (isRecord(t) && typeof t.tag === 'string' && t.tag.trim()) out.set(t.tag.trim().toLowerCase(), { tag: t.tag.trim() });
      if (typeof t === 'string' && t.trim()) out.set(t.trim().toLowerCase(), { tag: t.trim() });
    }
  }
  const before = out.size;
  for (const t of toAdd) out.set(t.toLowerCase(), { tag: t });
  return { merged: Array.from(out.values()), added: out.size - before };
}

function extractItemDataForUpdate(item: unknown): { key: string; version: number; data: Record<string, any> } {
  if (!isRecord(item)) throw invalidParams('Invalid Zotero item (expected object)');
  const key = typeof item.key === 'string' ? item.key.trim() : '';
  if (!key) throw invalidParams('Invalid Zotero item: missing key');
  const version = typeof item.version === 'number' && Number.isFinite(item.version) ? item.version : 0;
  const data = isRecord(item.data) ? (item.data as Record<string, any>) : {};
  return { key, version, data };
}

function isZoteroLocalApiWriteUnsupported(err: unknown): boolean {
  if (!(err instanceof McpError) || err.code !== 'UPSTREAM_ERROR') return false;
  if (!isRecord(err.data)) return false;
  const status = (err.data as any).status;
  const body = (err.data as any).body;
  if (typeof status !== 'number') return false;
  const msg = typeof body === 'string' ? body.toLowerCase() : '';
  return status === 400 || status === 501 || msg.includes('method not implemented') || msg.includes('does not support method');
}

async function zoteroConnectorSaveItems(params: { items: unknown[]; uri: string }): Promise<void> {
  await zoteroConnectorPostVoid('/connector/saveItems', {
    items: params.items,
    uri: params.uri,
  });
}

async function createZoteroNote(params: { parent_item_key: string; note_html: string }): Promise<void> {
  try {
    await zoteroPostJson('/users/0/items', [
      {
        itemType: 'note',
        parentItem: params.parent_item_key,
        note: params.note_html,
      },
    ]);
    return;
  } catch (err) {
    if (!isZoteroLocalApiWriteUnsupported(err)) throw err;
  }

  await zoteroConnectorSaveItems({
    items: [
      {
        itemType: 'note',
        parentItem: params.parent_item_key,
        note: params.note_html,
      },
    ],
    uri: 'https://local.zotero/connector/saveItems',
  });
}

function extractIdentifiersFromItemData(data: Record<string, unknown>): {
  doi?: string;
  arxiv_id?: string;
  inspire_recid?: string;
} {
  const doiField = typeof (data as any).DOI === 'string' ? (data as any).DOI : typeof (data as any).doi === 'string' ? (data as any).doi : undefined;
  const doi = doiField ? normalizeZoteroDoi(doiField) : undefined;
  const urlField = typeof (data as any).url === 'string' ? (data as any).url : typeof (data as any).URL === 'string' ? String((data as any).URL) : undefined;
  const doiFromUrl = urlField ? normalizeZoteroDoi(urlField) : undefined;
  const arxivField =
    typeof (data as any).arXiv === 'string'
      ? (data as any).arXiv
      : typeof (data as any).arxiv === 'string'
        ? (data as any).arxiv
        : typeof (data as any).arXivID === 'string'
          ? (data as any).arXivID
          : typeof (data as any).arxivId === 'string'
            ? (data as any).arxivId
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
  const arxiv_id = arxivField ? normalizeZoteroArxivId(arxivField) : arxivFromUrl ?? arxivFromJournal ?? undefined;
  const archive = typeof (data as any).archive === 'string' ? String((data as any).archive).trim() : undefined;
  const archiveLocation =
    typeof (data as any).archiveLocation === 'string'
      ? String((data as any).archiveLocation).trim()
      : typeof (data as any).archive_location === 'string'
        ? String((data as any).archive_location).trim()
        : undefined;
  const extra = typeof (data as any).extra === 'string' ? String((data as any).extra) : '';
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

function parseAttachmentKeys(children: unknown[]): string[] {
  return parseAttachmentSummaries(children).map(a => a.attachment_key);
}

function normalizedTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchItemIdentifiers(
  extracted: { doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string; zotero_item_key: string },
  query: { doi?: string; arxiv_id?: string; inspire_recid?: string; title?: string; item_key?: string },
  match: 'exact' | 'fuzzy'
): boolean {
  if (query.item_key && extracted.zotero_item_key !== query.item_key) return false;

  if (query.doi) {
    const q = query.doi.trim();
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
    const q = query.arxiv_id.trim();
    if (!q) return false;
    const h = (extracted.arxiv_id ?? '').trim();
    if (!h) return false;
    if (match === 'fuzzy') {
      if (!h.toLowerCase().includes(q.toLowerCase())) return false;
    } else {
      const qBase = q.replace(/v\d+$/i, '');
      const hBase = h.replace(/v\d+$/i, '');
      if (hBase !== qBase) return false;
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

function matchItemFilters(
  item: unknown,
  query: {
    tags: string[];
    authors: string[];
    publication_title?: string;
    year?: number;
    volume?: string;
    issue?: string;
  },
  match: 'exact' | 'fuzzy'
): boolean {
  if (!isRecord(item)) return false;
  const data = isRecord(item.data) ? item.data : {};

  if (query.tags.length > 0) {
    const tagsRaw = (data as any).tags;
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw
        .map((t: any) => (typeof t?.tag === 'string' ? String(t.tag).trim().toLowerCase() : undefined))
        .filter(Boolean)
      : [];
    for (const q of query.tags) {
      if (!tags.includes(q.toLowerCase())) return false;
    }
  }

  if (query.authors.length > 0) {
    const creatorsRaw = (data as any).creators;
    const creators = Array.isArray(creatorsRaw)
      ? creatorsRaw
        .map((c: any) => {
          const full =
            typeof c?.name === 'string'
              ? String(c.name)
              : `${typeof c?.firstName === 'string' ? c.firstName : ''} ${typeof c?.lastName === 'string' ? c.lastName : ''}`.trim();
          return full.trim().toLowerCase();
        })
        .filter((v: string) => v.length > 0)
      : [];

    for (const q of query.authors) {
      const qn = q.toLowerCase();
      const ok = match === 'fuzzy'
        ? creators.some(c => c.includes(qn))
        : creators.some(c => c === qn);
      if (!ok) return false;
    }
  }

  if (query.publication_title) {
    const pub = typeof (data as any).publicationTitle === 'string' ? String((data as any).publicationTitle).trim() : '';
    if (!pub) return false;
    if (match === 'fuzzy') {
      if (!pub.toLowerCase().includes(query.publication_title.toLowerCase())) return false;
    } else {
      if (pub.toLowerCase() !== query.publication_title.toLowerCase()) return false;
    }
  }

  if (query.year !== undefined) {
    const date = typeof (data as any).date === 'string' ? String((data as any).date) : '';
    const m = date.match(/\b(\d{4})\b/);
    const y = m ? Number(m[1]) : undefined;
    if (y !== query.year) return false;
  }

  if (query.volume) {
    const v = typeof (data as any).volume === 'string' ? String((data as any).volume).trim() : '';
    if (!v) return false;
    if (match === 'fuzzy') {
      if (!v.toLowerCase().includes(query.volume.toLowerCase())) return false;
    } else {
      if (v !== query.volume) return false;
    }
  }

  if (query.issue) {
    const v = typeof (data as any).issue === 'string' ? String((data as any).issue).trim() : '';
    if (!v) return false;
    if (match === 'fuzzy') {
      if (!v.toLowerCase().includes(query.issue.toLowerCase())) return false;
    } else {
      if (v !== query.issue) return false;
    }
  }

  return true;
}

function isItemInAnyCollection(item: unknown, collectionKeys: Set<string>): boolean {
  if (!isRecord(item)) return false;
  const data = isRecord(item.data) ? item.data : {};
  const raw = (data as any).collections;
  if (!Array.isArray(raw)) return false;
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    const trimmed = k.trim();
    if (trimmed && collectionKeys.has(trimmed)) return true;
  }
  return false;
}

async function resolveDescendantCollectionKeys(collectionKey: string): Promise<string[]> {
  const res = await listAllZoteroCollectionsWithMeta();

  const childrenByParent = new Map<string, string[]>();
  for (const coll of res.collections) {
    if (!isRecord(coll)) continue;
    const key = typeof coll.key === 'string' ? coll.key.trim() : '';
    if (!key) continue;
    const data = isRecord((coll as any).data) ? ((coll as any).data as Record<string, unknown>) : {};
    const parent = typeof (data as any).parentCollection === 'string' ? String((data as any).parentCollection).trim() : '';
    if (!parent) continue;
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(key);
    childrenByParent.set(parent, arr);
  }

  for (const arr of childrenByParent.values()) {
    arr.sort();
  }

  const out: string[] = [];
  const visited = new Set<string>([collectionKey]);
  const queue = [...(childrenByParent.get(collectionKey) ?? [])];

  const maxDescendants = 2000;
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (visited.has(key)) continue;
    visited.add(key);
    out.push(key);
    if (out.length >= maxDescendants) {
      throw invalidParams('Too many descendant collections (max 2000)', { collection_key: collectionKey });
    }
    const children = childrenByParent.get(key);
    if (children && children.length > 0) queue.push(...children);
  }

  return out;
}

function pickZoteroSearchToken(params: {
  identifiers: {
    doi?: string;
    arxiv_id?: string;
    inspire_recid?: string;
    title?: string;
  };
  filters: {
    tags: string[];
    authors: string[];
    publication_title?: string;
    year?: number;
    volume?: string;
    issue?: string;
  };
}): string | undefined {
  if (params.identifiers.doi) return params.identifiers.doi;
  if (params.identifiers.arxiv_id) return params.identifiers.arxiv_id;
  if (params.identifiers.inspire_recid) return params.identifiers.inspire_recid;
  if (params.identifiers.title) return params.identifiers.title;
  if (params.filters.publication_title) return params.filters.publication_title;
  if (params.filters.authors[0]) return params.filters.authors[0];
  if (params.filters.tags[0]) return params.filters.tags[0];
  return undefined;
}

async function fetchZoteroItemCandidates(params: {
  token: string;
  limit: number;
  collection_keys?: string[];
}): Promise<{ items: unknown[]; total_results?: number; collections_scanned?: number }> {
  const keys = (params.collection_keys ?? []).map(k => k.trim()).filter(Boolean);

  if (keys.length <= 0) {
    const res = await queryZoteroItems({
      scope: { kind: 'library' },
      top_level_only: false,
      q: params.token,
      itemType: '-attachment',
      limit: params.limit,
      start: 0,
    });
    return { items: res.items, total_results: res.meta.total_results };
  }

  if (keys.length === 1) {
    const res = await queryZoteroItems({
      scope: { kind: 'collection', collection_key: keys[0] },
      top_level_only: false,
      q: params.token,
      itemType: '-attachment',
      limit: params.limit,
      start: 0,
    });
    return { items: res.items, total_results: res.meta.total_results, collections_scanned: 1 };
  }

  const seen = new Set<string>();
  const items: unknown[] = [];
  let scanned = 0;

  for (const key of keys) {
    if (items.length >= params.limit) break;
    const remaining = Math.max(params.limit - items.length, 1);
    const res = await queryZoteroItems({
      scope: { kind: 'collection', collection_key: key },
      top_level_only: false,
      q: params.token,
      itemType: '-attachment',
      limit: remaining,
      start: 0,
    });
    scanned += 1;

    for (const item of res.items) {
      if (items.length >= params.limit) break;
      if (!isRecordWithKey(item)) continue;
      const k = typeof (item as any).key === 'string' ? String((item as any).key).trim() : '';
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(item);
    }
  }

  return { items, collections_scanned: scanned };
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
  const doiRaw = typeof (identifiers as any).doi === 'string' ? (identifiers as any).doi : undefined;
  const arxivRaw = typeof (identifiers as any).arxiv_id === 'string' ? (identifiers as any).arxiv_id : undefined;
  const recidRaw = typeof (identifiers as any).inspire_recid === 'string' ? (identifiers as any).inspire_recid : undefined;
  const titleRaw = typeof (identifiers as any).title === 'string' ? (identifiers as any).title : undefined;
  const itemKeyRaw = typeof (identifiers as any).item_key === 'string' ? (identifiers as any).item_key : undefined;

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
  const tags = Array.isArray((filters as any).tags)
    ? (filters as any).tags.filter((t: any) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean)
    : [];
  const authors = Array.isArray((filters as any).authors)
    ? (filters as any).authors.filter((t: any) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean)
    : [];
  const publication_title = typeof (filters as any).publication_title === 'string' ? String((filters as any).publication_title).trim() : undefined;
  const volume = typeof (filters as any).volume === 'string' ? String((filters as any).volume).trim() : undefined;
  const issue = typeof (filters as any).issue === 'string' ? String((filters as any).issue).trim() : undefined;
  const year = typeof (filters as any).year === 'number' && Number.isFinite((filters as any).year) ? Math.trunc((filters as any).year) : undefined;

  const norm = (s: string) => (match === 'exact' ? s.trim() : s.trim());
  return {
    tags: Array.from(new Set(tags.map(norm))),
    authors: Array.from(new Set(authors.map(norm))),
    publication_title: publication_title ? norm(publication_title) : undefined,
    year,
    volume: volume ? norm(volume) : undefined,
    issue: issue ? norm(issue) : undefined,
  };
}

export async function zoteroFindItems(params: {
  collection_key?: string;
  include_children?: boolean;
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
    collection_key?: string;
    include_children: boolean;
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
    item_type?: string;
    title?: string;
    select_uri: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    creators?: ZoteroCreatorSummary[];
    date?: string;
    publication_title?: string;
    attachment_keys?: string[];
  }>;
  items: Array<{
    item_key: string;
    item_type?: string;
    title?: string;
    select_uri: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    creators?: ZoteroCreatorSummary[];
    date?: string;
    publication_title?: string;
    attachment_keys?: string[];
  }>;
  summary: { matched: number; returned: number; scanned?: number; total_results_header?: number; collections_scanned?: number };
}> {
  const match = params.match ?? 'exact';
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const includeAttachments = params.include_attachments ?? false;

  const identifiers = normalizeZoteroFindIdentifiers((params.identifiers ?? {}) as unknown as Record<string, unknown>, match);
  const filters = normalizeZoteroFindFilters((params.filters ?? {}) as unknown as Record<string, unknown>, match);
  const collectionKey = params.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;
  const includeChildren = params.include_children ?? false;

  const scopedCollectionKeys = collectionKey
    ? includeChildren
      ? [collectionKey, ...(await resolveDescendantCollectionKeys(collectionKey))]
      : [collectionKey]
    : undefined;
  const scopedCollectionKeySet = scopedCollectionKeys ? new Set(scopedCollectionKeys) : undefined;

  if (identifiers.item_key) {
    const res = await zoteroGetJsonAllow404<unknown>(`/users/0/items/${encodeURIComponent(identifiers.item_key)}`);
    if ('status' in res) {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 0 },
      };
    }
    const item = res.data;
    if (!isRecordWithKey(item)) {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 0 },
      };
    }

    const itemData = isRecord(item.data) ? item.data : {};
    const itemType = typeof (itemData as any).itemType === 'string' ? String((itemData as any).itemType) : '';
    const itemTypeNorm = itemType.trim().toLowerCase();
    if (itemTypeNorm === 'attachment' || itemTypeNorm === 'note' || itemTypeNorm === 'annotation') {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 1 },
      };
    }
    if (scopedCollectionKeySet && !isItemInAnyCollection(item, scopedCollectionKeySet)) {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 1 },
      };
    }

    const extracted = extractZoteroItemIdentifiers(item);
    if (!matchItemIdentifiers(extracted, identifiers, match)) {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 1 },
      };
    }
    if (!matchItemFilters(item, filters, match)) {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 1 },
      };
    }
    const attachment_keys = includeAttachments
      ? parseAttachmentKeys((await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(extracted.zotero_item_key)}/children`)).data)
      : undefined;

    const summary = buildZoteroItemSummary(item, extracted);
    if (!summary) {
      return {
        query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
        matches: [],
        items: [],
        summary: { matched: 0, returned: 0, scanned: 1 },
      };
    }

    const matchItem: ZoteroItemSummaryWithAttachments = { ...summary, attachment_keys };
    const matches = [matchItem];

    return {
      query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
      matches,
      items: matches,
      summary: { matched: 1, returned: 1, scanned: 1 },
    };
  }

  const token = pickZoteroSearchToken({ identifiers, filters });
  if (!token) throw invalidParams('identifiers or filters must include at least one non-empty field');
  if (token.length > 512) throw invalidParams('Search token too long (max 512 chars)', { length: token.length });

  const candidates = await fetchZoteroItemCandidates({ token, limit, collection_keys: scopedCollectionKeys });
  const matches: ZoteroItemSummaryWithAttachments[] = [];

  for (const item of candidates.items) {
    if (!isRecordWithKey(item)) continue;
    const itemData = isRecord((item as any).data) ? (item as any).data : {};
    const itemType = typeof (itemData as any).itemType === 'string' ? String((itemData as any).itemType) : '';
    const itemTypeNorm = itemType.trim().toLowerCase();
    if (itemTypeNorm === 'attachment' || itemTypeNorm === 'note' || itemTypeNorm === 'annotation') continue;
    const extracted = extractZoteroItemIdentifiers(item);

    if (!matchItemIdentifiers(extracted, identifiers, match)) continue;
    if (!matchItemFilters(item, filters, match)) continue;

    const attachment_keys = includeAttachments
      ? parseAttachmentKeys((await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(extracted.zotero_item_key)}/children`)).data)
      : undefined;

    const summary = buildZoteroItemSummary(item, extracted);
    if (!summary) continue;
    matches.push({ ...summary, attachment_keys });
  }

  return {
    query: { collection_key: collectionKey, include_children: includeChildren, identifiers, filters },
    matches,
    items: matches,
    summary: {
      matched: matches.length,
      returned: matches.length,
      scanned: candidates.items.length,
      total_results_header: candidates.total_results,
      collections_scanned: candidates.collections_scanned,
    },
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

  const mergedCollections = mergeCollections((data as any).collections, params.collection_keys);
  const mergedTags = mergeTags((data as any).tags, params.tags);

  const archive = typeof (data as any).archive === 'string' ? String((data as any).archive).trim() : '';
  const canSetArchive = archive.length === 0 || archive.toLowerCase() === 'inspire';
  const nextArchive = canSetArchive && params.inspire_recid ? 'INSPIRE' : (data as any).archive;
  const nextArchiveLocation =
    canSetArchive && params.inspire_recid ? String(params.inspire_recid) : (data as any).archiveLocation;

  const next = {
    ...data,
    collections: mergedCollections.merged,
    tags: mergedTags.merged,
    archive: nextArchive,
    archiveLocation: nextArchiveLocation,
  } as Record<string, unknown>;

  let needsWriteUpdate = mergedCollections.added > 0 || mergedTags.added > 0 || Boolean(params.inspire_recid);
  try {
    if (needsWriteUpdate) {
      await zoteroPutJson(`/users/0/items/${encodeURIComponent(key)}`, { key, version, data: next });
    }
  } catch (err) {
    if (!isZoteroLocalApiWriteUnsupported(err)) throw err;
    if (needsWriteUpdate) {
      throw invalidParams(
        'Zotero Local API write access appears to be disabled (cannot update existing items). Enable Local API write access in Zotero settings, or use dedupe=return_existing.'
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

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.epub': return 'application/epub+zip';
    case '.html': case '.htm': return 'text/html';
    case '.txt': return 'text/plain';
    case '.djvu': return 'image/vnd.djvu';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default: return 'application/octet-stream';
  }
}

async function createZoteroLinkedFileAttachment(params: {
  parent_item_key: string;
  file_path: string;
}): Promise<{ attachment_key: string }> {
  if (!path.isAbsolute(params.file_path)) {
    throw invalidParams('file_path must be an absolute path', { file_path: params.file_path });
  }
  const absPath = path.resolve(params.file_path);
  if (!fs.existsSync(absPath)) {
    throw invalidParams('file_path does not exist', { file_path: absPath });
  }

  const title = path.basename(absPath);
  const contentType = inferContentType(absPath);

  const payload = [{
    itemType: 'attachment',
    parentItem: params.parent_item_key,
    linkMode: 'linked_file',
    title,
    path: absPath,
    contentType,
    tags: [],
    relations: {},
  }];

  const res = await zoteroPostJson<unknown>('/users/0/items', payload);
  const key = extractCreatedItemKey(res.data);
  if (!key) {
    throw invalidParams(
      'Zotero Local API did not return attachment key. Linked-file attachments require Zotero Local API write access to be enabled.',
      { parent_item_key: params.parent_item_key, file_path: absPath }
    );
  }
  return { attachment_key: key };
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
          'Zotero Local API write access appears to be disabled and Zotero is currently selecting the library root. Select the desired collection in Zotero (left sidebar) or enable Local API write access.'
        );
      }
      if (selected.collection_key !== params.collection_keys[0]) {
        throw invalidParams(
          'Zotero Local API write access appears to be disabled. To use connector saveItems, Zotero must be currently selecting the target collection. Select the target collection in Zotero, or enable Local API write access.',
          { selected_collection_key: selected.collection_key, requested_collection_key: params.collection_keys[0] }
        );
      }
    }

    const uri = typeof payloadData.url === 'string' && payloadData.url.trim() ? payloadData.url.trim() : 'https://local.zotero/connector/saveItems';
    await zoteroConnectorSaveItems({ items: [payloadData], uri });

    const identifiers = extractIdentifiersFromItemData(payloadData);
    const title = typeof (payloadData as any).title === 'string' ? String((payloadData as any).title) : undefined;
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

async function resolveZoteroAddSource(params: {
  source:
    | { type: 'item'; item: Record<string, unknown> }
    | { type: 'inspire'; recid: string }
    | { type: 'doi'; doi: string }
    | { type: 'arxiv'; arxiv_id: string };
}): Promise<{ data: Record<string, unknown>; title?: string; identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string } }> {
  if (params.source.type === 'item') {
    if (!isRecord(params.source.item)) throw invalidParams('item must be an object');
    const data = params.source.item as Record<string, unknown>;
    let approxBytes = 0;
    try {
      approxBytes = JSON.stringify(data).length;
    } catch {
      throw invalidParams('item must be JSON-serializable');
    }
    if (approxBytes > 200_000) {
      throw invalidParams('item payload too large (max ~200KB JSON)', { approx_bytes: approxBytes });
    }

    const identifiers = extractIdentifiersFromItemData(data);
    const title = typeof (data as any).title === 'string' ? (data as any).title : undefined;
    return { data, title, identifiers };
  }

  if (params.source.type === 'doi') {
    const doi = normalizeZoteroDoi(normalizeZoteroExactIdentifier(params.source.doi, 'doi'));
    if (!doi) throw invalidParams('Unrecognized DOI format', { doi: params.source.doi });

    // Try INSPIRE first (richer metadata for HEP papers), fall back to CrossRef for non-HEP DOIs
    try {
      const paper = await inspireApi.getByDoi(doi);
      return {
        data: buildZoteroItemFromPaper(paper as unknown as Paper),
        title: paper.title,
        identifiers: { doi: paper.doi, arxiv_id: paper.arxiv_id, inspire_recid: paper.recid },
      };
    } catch (inspireErr) {
      // Only fall back to CrossRef for "not found" or "upstream error" (INSPIRE 404)
      // Re-throw transient errors (network, rate-limit) so they surface properly
      const isNotFound = inspireErr instanceof McpError && (inspireErr.code === 'NOT_FOUND' || inspireErr.code === 'UPSTREAM_ERROR');
      if (!isNotFound) throw inspireErr;

      const paper = await crossrefApi.getByDoi(doi);
      return {
        data: buildZoteroItemFromPaper(paper as unknown as Paper),
        title: paper.title,
        identifiers: { doi: paper.doi },
      };
    }
  }

  if (params.source.type === 'arxiv') {
    const arxiv_id = normalizeZoteroArxivId(normalizeZoteroExactIdentifier(params.source.arxiv_id, 'arxiv_id'));
    if (!arxiv_id) throw invalidParams('Unrecognized arXiv ID format', { arxiv_id: params.source.arxiv_id });
    const paper = await inspireApi.getByArxiv(arxiv_id);
    return {
      data: buildZoteroItemFromPaper(paper as unknown as Paper),
      title: paper.title,
      identifiers: { doi: paper.doi, arxiv_id: paper.arxiv_id, inspire_recid: paper.recid },
    };
  }

  const recid = normalizeZoteroExactIdentifier(params.source.recid, 'recid');
  if (!/^\d+$/.test(recid)) throw invalidParams('recid must be numeric', { recid: params.source.recid });
  const paper = await inspireApi.getPaper(recid);
  return {
    data: buildZoteroItemFromPaper(paper as unknown as Paper),
    title: paper.title,
    identifiers: { doi: paper.doi, arxiv_id: paper.arxiv_id, inspire_recid: paper.recid },
  };
}

async function previewUpdateExistingZoteroItem(params: {
  item_key: string;
  collection_keys: string[];
  tags: string[];
  note?: string;
  inspire_recid?: string;
}): Promise<{ collections_added: number; tags_added: number; note_added: boolean }> {
  const getRes = await zoteroGetJson<unknown>(`/users/0/items/${encodeURIComponent(params.item_key)}`);
  const { data } = extractItemDataForUpdate(getRes.data);

  const mergedCollections = mergeCollections((data as any).collections, params.collection_keys);
  const mergedTags = mergeTags((data as any).tags, params.tags);
  const noteAdded = Boolean(params.note && params.note.trim());

  return {
    collections_added: mergedCollections.added,
    tags_added: mergedTags.added,
    note_added: noteAdded,
  };
}

function parseTagSummary(value: unknown): { tag: string; type?: number; numItems?: number } | null {
  if (!isRecord(value)) {
    if (typeof value === 'string' && value.trim()) return { tag: value.trim() };
    return null;
  }
  const tag = typeof (value as any).tag === 'string' ? String((value as any).tag).trim() : '';
  if (!tag) return null;
  const type = typeof (value as any).type === 'number' && Number.isFinite((value as any).type) ? Math.trunc((value as any).type) : undefined;
  const numItems =
    typeof (value as any).numItems === 'number' && Number.isFinite((value as any).numItems) ? Math.trunc((value as any).numItems) : undefined;
  return { tag, ...(type !== undefined ? { type } : {}), ...(numItems !== undefined ? { numItems } : {}) };
}

export async function zoteroListTags(params: {
  scope?: { kind: 'library' } | { kind: 'collection'; collection_key: string } | { kind: 'item'; item_key: string };
  q?: string;
  qmode?: 'contains' | 'startsWith';
  limit?: number;
  start?: number;
}): Promise<{
  meta: { url: string; status: number; total_results?: number };
  scope: { kind: 'library' } | { kind: 'collection'; collection_key: string } | { kind: 'item'; item_key: string };
  tags: Array<{ tag: string; type?: number; numItems?: number }>;
  summary: { returned: number; total_results?: number };
}> {
  const scope = params.scope ?? { kind: 'library' };
  const limit = params.limit ?? 50;
  const start = params.start ?? 0;
  const q = typeof params.q === 'string' && params.q.trim() ? params.q.trim() : undefined;
  const qmode = params.qmode;

  const query = { limit, start, q, qmode };

  if (scope.kind === 'collection') {
    const collectionKey = normalizeZoteroKey(scope.collection_key, 'collection_key');
    const res = await zoteroGetJson<unknown[]>(`/users/0/collections/${encodeURIComponent(collectionKey)}/tags`, query);
    const tags = (Array.isArray(res.data) ? res.data : []).map(parseTagSummary).filter(Boolean) as Array<{
      tag: string;
      type?: number;
      numItems?: number;
    }>;
    return {
      meta: res.meta,
      scope: { kind: 'collection', collection_key: collectionKey },
      tags,
      summary: { returned: tags.length, total_results: res.meta.total_results },
    };
  }

  if (scope.kind === 'item') {
    const itemKey = normalizeZoteroKey(scope.item_key, 'item_key');
    const res = await zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/tags`, query);
    const tags = (Array.isArray(res.data) ? res.data : []).map(parseTagSummary).filter(Boolean) as Array<{
      tag: string;
      type?: number;
      numItems?: number;
    }>;
    return {
      meta: res.meta,
      scope: { kind: 'item', item_key: itemKey },
      tags,
      summary: { returned: tags.length, total_results: res.meta.total_results },
    };
  }

  const res = await zoteroGetJson<unknown[]>('/users/0/tags', query);
  const tags = (Array.isArray(res.data) ? res.data : []).map(parseTagSummary).filter(Boolean) as Array<{
    tag: string;
    type?: number;
    numItems?: number;
  }>;
  return {
    meta: res.meta,
    scope: { kind: 'library' },
    tags,
    summary: { returned: tags.length, total_results: res.meta.total_results },
  };
}

export async function zoteroExportItems(params: {
  scope:
    | { kind: 'item_keys'; item_keys: string[] }
    | { kind: 'collection'; collection_key: string; limit?: number; start?: number }
    | { kind: 'library_top'; limit?: number; start?: number };
  format: string;
  style?: string;
  locale?: string;
  linkwrap?: boolean;
  max_chars?: number;
}): Promise<{
  meta: { url: string; status: number; total_results?: number };
  content_type: string | null;
  scope: Record<string, unknown>;
  format: string;
  content: string;
  total_chars: number;
  truncated: boolean;
  sha256: string;
}> {
  const maxCharsRaw = params.max_chars ?? 200_000;
  const maxChars = Math.min(Math.max(Math.trunc(maxCharsRaw), 1_000), 2_000_000);

  const format = String(params.format || '').trim();
  if (!format) throw invalidParams('format cannot be empty');

  const style = typeof params.style === 'string' && params.style.trim() ? params.style.trim() : undefined;
  const locale = typeof params.locale === 'string' && params.locale.trim() ? params.locale.trim() : undefined;
  const linkwrap = params.linkwrap === true ? 1 : undefined;

  const baseQuery: Record<string, string | number | boolean | undefined> = {
    format,
    style,
    locale,
    linkwrap,
  };

  let pathname: string;
  let scopeOut: Record<string, unknown>;
  let query: Record<string, string | number | boolean | undefined>;

  if (params.scope.kind === 'item_keys') {
    const itemKeys = Array.isArray(params.scope.item_keys) ? params.scope.item_keys : [];
    const normalized = itemKeys.map(k => normalizeZoteroKey(String(k), 'item_keys'));
    if (normalized.length === 0) throw invalidParams('item_keys cannot be empty');
    if (normalized.length > 50) throw invalidParams('Too many item_keys (max 50)', { length: normalized.length, max: 50 });

    pathname = '/users/0/items';
    scopeOut = { kind: 'item_keys', item_keys: normalized };
    query = { ...baseQuery, itemKey: normalized.join(','), limit: normalized.length };
  } else if (params.scope.kind === 'collection') {
    const collectionKey = normalizeZoteroKey(params.scope.collection_key, 'collection_key');
    const limit = params.scope.limit ?? 50;
    const start = params.scope.start ?? 0;
    pathname = `/users/0/collections/${encodeURIComponent(collectionKey)}/items`;
    scopeOut = { kind: 'collection', collection_key: collectionKey, limit, start };
    query = { ...baseQuery, limit, start };
  } else {
    const limit = params.scope.limit ?? 50;
    const start = params.scope.start ?? 0;
    pathname = '/users/0/items/top';
    scopeOut = { kind: 'library_top', limit, start };
    query = { ...baseQuery, limit, start };
  }

  const res = await zoteroGetText(pathname, query);
  const totalChars = res.data.length;
  const truncated = totalChars > maxChars;
  const content = truncated ? res.data.slice(0, maxChars) : res.data;

  return {
    meta: res.meta,
    content_type: res.content_type,
    scope: scopeOut,
    format,
    content,
    total_chars: totalChars,
    truncated,
    sha256: sha256HexString(res.data),
  };
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
  file_path?: string;
  dedupe?: 'return_existing' | 'update_existing' | 'error_on_existing';
  open_in_zotero?: boolean;
}): Promise<
  | {
      status: 'existing';
      item_key: string;
      select_uri?: string;
      summary: {
        title?: string;
        identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
        collections_added: number;
        tags_added: number;
        note_added: boolean;
      };
    }
  | {
      status: 'needs_confirm';
      confirm_token: string;
      expires_at: string;
      plan: {
        will: 'created' | 'updated';
        item_key?: string;
        selection?: { kind: 'collection'; collection_key: string; path: string } | { kind: 'library_root'; path: string };
        effective_collection_keys: string[];
        collections_added: number;
        tags: string[];
        tags_added: number;
        note_added: boolean;
        item_preview: Record<string, unknown>;
        identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
      };
      warnings: string[];
    }
> {
  const allowLibraryRoot = params.allow_library_root ?? false;
  const tags = normalizeTagStrings(params.tags);
  const dedupe = params.dedupe ?? 'return_existing';
  const open = params.open_in_zotero ?? true;
  const note = typeof params.note === 'string' ? params.note : undefined;
  const filePath = typeof params.file_path === 'string' && params.file_path.trim() ? params.file_path.trim() : undefined;

  const requestedCollectionKeys = normalizeCollectionKeys(params.collection_keys);
  const resolvedSelected =
    requestedCollectionKeys.length > 0 ? undefined : await resolveSelectedCollectionKey({ allow_library_root: allowLibraryRoot });
  const effectiveCollectionKeys =
    requestedCollectionKeys.length > 0 ? requestedCollectionKeys : resolvedSelected?.kind === 'collection' ? [resolvedSelected.collection_key] : [];

  const resolvedSource = await resolveZoteroAddSource({ source: params.source });
  const identifiers = resolvedSource.identifiers;

  const dedupeCandidates: Array<{ doi?: string; arxiv_id?: string; inspire_recid?: string }> = [];
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

    const preview = await previewUpdateExistingZoteroItem({
      item_key: existing.item_key,
      collection_keys: effectiveCollectionKeys,
      tags,
      note,
      inspire_recid: identifiers.inspire_recid,
    });

    const payload: ZoteroAddConfirmPayloadV1 = {
      planned: { mode: 'update_existing', item_key: existing.item_key },
      prepared_item: {
        data: resolvedSource.data,
        title: resolvedSource.title,
        identifiers,
      },
      write: {
        effective_collection_keys: effectiveCollectionKeys,
        allow_library_root: allowLibraryRoot,
        tags,
        note,
        file_path: filePath,
        dedupe,
        open_in_zotero: open,
      },
      selection:
        resolvedSelected?.kind === 'collection'
          ? { kind: 'collection', collection_key: resolvedSelected.collection_key, path: resolvedSelected.path }
          : resolvedSelected?.kind === 'library_root'
            ? { kind: 'library_root', path: resolvedSelected.path }
            : undefined,
    };

    const token = createConfirmAction({ kind: 'zotero_add_v1', payload: { params: payload } });

    return {
      status: 'needs_confirm',
      confirm_token: token.confirm_token,
      expires_at: token.expires_at,
      plan: {
        will: 'updated',
        item_key: existing.item_key,
        selection: payload.selection,
        effective_collection_keys: effectiveCollectionKeys,
        collections_added: preview.collections_added,
        tags,
        tags_added: preview.tags_added,
        note_added: Boolean(note && note.trim()),
        item_preview: summarizeZoteroItemData(resolvedSource.data),
        identifiers,
      },
      warnings: [],
    };
  }

  if (effectiveCollectionKeys.length === 0 && !allowLibraryRoot) {
    throw invalidParams(
      'No collection selected. Please select a collection in Zotero (left sidebar), provide collection_keys explicitly, or set allow_library_root=true to write to library root.'
    );
  }

  const payload: ZoteroAddConfirmPayloadV1 = {
    planned: { mode: 'create' },
    prepared_item: {
      data: resolvedSource.data,
      title: resolvedSource.title,
      identifiers,
    },
    write: {
      effective_collection_keys: effectiveCollectionKeys,
      allow_library_root: allowLibraryRoot,
      tags,
      note,
      file_path: filePath,
      dedupe,
      open_in_zotero: open,
    },
    selection:
      resolvedSelected?.kind === 'collection'
        ? { kind: 'collection', collection_key: resolvedSelected.collection_key, path: resolvedSelected.path }
        : resolvedSelected?.kind === 'library_root'
          ? { kind: 'library_root', path: resolvedSelected.path }
          : undefined,
  };

  const warnings: string[] = [];
  if (effectiveCollectionKeys.length > 1) {
    warnings.push(
      'Multiple collection_keys requested. If Zotero Local API write access is disabled, connector saveItems may not reliably target multiple collections; enable Local API write access or use a single collection.'
    );
  }

  const token = createConfirmAction({ kind: 'zotero_add_v1', payload: { params: payload } });

  return {
    status: 'needs_confirm',
    confirm_token: token.confirm_token,
    expires_at: token.expires_at,
    plan: {
      will: 'created',
      selection: payload.selection,
      effective_collection_keys: effectiveCollectionKeys,
      collections_added: effectiveCollectionKeys.length,
      tags,
      tags_added: tags.length,
      note_added: Boolean(note && note.trim()),
      item_preview: summarizeZoteroItemData(resolvedSource.data),
      identifiers,
    },
    warnings,
  };
}

export async function zoteroAddConfirm(payload: ZoteroAddConfirmPayloadV1): Promise<{
  status: 'created' | 'existing' | 'updated';
  item_key: string;
  select_uri?: string;
  summary: {
    title?: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
    collections_added: number;
    tags_added: number;
    note_added: boolean;
    file_attached?: boolean;
  };
}> {
  const allowLibraryRoot = payload.write.allow_library_root;
  const tags = normalizeTagStrings(payload.write.tags);
  const dedupe = payload.write.dedupe;
  const open = payload.write.open_in_zotero;
  const note = typeof payload.write.note === 'string' ? payload.write.note : undefined;
  const filePath = typeof payload.write.file_path === 'string' && payload.write.file_path.trim() ? payload.write.file_path.trim() : undefined;
  const effectiveCollectionKeys = normalizeCollectionKeys(payload.write.effective_collection_keys);
  const identifiers = payload.prepared_item.identifiers;

  if (payload.planned.mode === 'update_existing') {
    const updated = await updateExistingZoteroItem({
      item_key: payload.planned.item_key,
      collection_keys: effectiveCollectionKeys,
      tags,
      note,
      inspire_recid: identifiers.inspire_recid,
    });

    let fileAttached = false;
    if (filePath) {
      await createZoteroLinkedFileAttachment({ parent_item_key: payload.planned.item_key, file_path: filePath });
      fileAttached = true;
    }

    return {
      status: updated.collections_added > 0 || updated.tags_added > 0 || updated.note_added || fileAttached ? 'updated' : 'existing',
      item_key: payload.planned.item_key,
      select_uri: open ? buildZoteroSelectUri(payload.planned.item_key) : undefined,
      summary: {
        title: payload.prepared_item.title,
        identifiers,
        collections_added: updated.collections_added,
        tags_added: updated.tags_added,
        note_added: updated.note_added,
        file_attached: fileAttached || undefined,
      },
    };
  }

  const dedupeCandidates: Array<{ doi?: string; arxiv_id?: string; inspire_recid?: string }> = [];
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

    let fileAttached = false;
    if (filePath) {
      await createZoteroLinkedFileAttachment({ parent_item_key: existing.item_key, file_path: filePath });
      fileAttached = true;
    }

    return {
      status: updated.collections_added > 0 || updated.tags_added > 0 || updated.note_added || fileAttached ? 'updated' : 'existing',
      item_key: existing.item_key,
      select_uri: open ? buildZoteroSelectUri(existing.item_key) : undefined,
      summary: {
        title: existing.title,
        identifiers: existing.identifiers,
        collections_added: updated.collections_added,
        tags_added: updated.tags_added,
        note_added: updated.note_added,
        file_attached: fileAttached || undefined,
      },
    };
  }

  if (effectiveCollectionKeys.length === 0 && !allowLibraryRoot) {
    throw invalidParams(
      'No collection selected. Please select a collection in Zotero (left sidebar), provide collection_keys explicitly, or set allow_library_root=true to write to library root.'
    );
  }

  const created = await createZoteroItem({ data: payload.prepared_item.data, collection_keys: effectiveCollectionKeys, tags, note });

  let fileAttached = false;
  if (filePath) {
    await createZoteroLinkedFileAttachment({ parent_item_key: created.item_key, file_path: filePath });
    fileAttached = true;
  }

  return {
    status: 'created',
    item_key: created.item_key,
    select_uri: open ? buildZoteroSelectUri(created.item_key) : undefined,
    summary: {
      title: payload.prepared_item.title,
      identifiers,
      collections_added: effectiveCollectionKeys.length,
      tags_added: tags.length,
      note_added: created.note_added,
      file_attached: fileAttached || undefined,
    },
  };
}
