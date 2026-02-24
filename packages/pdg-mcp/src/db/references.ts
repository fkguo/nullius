import { sqlite3JsonQuery, sqlStringLiteral } from './sqlite3Cli.js';

export type ReferenceMatchMode = 'exact' | 'contains' | 'prefix';
export type ReferenceMatchField = 'doi' | 'inspire_id' | 'document_id' | 'title';

export interface PdgReferenceRow {
  id: number;
  document_id: string;
  publication_name: string | null;
  publication_year: number | null;
  doi: string | null;
  inspire_id: string | null;
  title: string | null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toNonEmptyStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : String(v);
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildMatchExpr(columnSql: string, needle: string, mode: ReferenceMatchMode, caseSensitive: boolean): string {
  const lit = sqlStringLiteral(needle);
  const col = caseSensitive ? columnSql : `lower(${columnSql})`;
  const target = caseSensitive ? lit : `lower(${lit})`;

  if (mode === 'exact') return `${col} = ${target}`;
  if (mode === 'prefix') return `substr(${col}, 1, length(${target})) = ${target}`;
  return `instr(${col}, ${target}) > 0`;
}

function orderSqlForField(field: ReferenceMatchField): string {
  if (field === 'document_id') return 'trim(document_id) ASC, id ASC';
  if (field === 'doi') return 'trim(doi) ASC, id ASC';
  if (field === 'inspire_id') return 'trim(inspire_id) ASC, id ASC';
  return 'COALESCE(publication_year, 0) DESC, id ASC';
}

function parseReferenceRow(row: unknown): PdgReferenceRow | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  const id = toNumber(r.id);
  const document_id = toNonEmptyStringOrNull(r.document_id);
  if (id === null || document_id === null) return null;

  return {
    id,
    document_id,
    publication_name: toNonEmptyStringOrNull(r.publication_name),
    publication_year: toNumber(r.publication_year),
    doi: toNonEmptyStringOrNull(r.doi),
    inspire_id: toNonEmptyStringOrNull(r.inspire_id),
    title: toNonEmptyStringOrNull(r.title),
  };
}

export async function findPdgReferences(
  dbPath: string,
  field: ReferenceMatchField,
  query: string,
  opts: { mode: ReferenceMatchMode; case_sensitive: boolean; start: number; limit: number }
): Promise<{ candidates: PdgReferenceRow[]; has_more: boolean }> {
  const value = query.trim();
  const col = field === 'title' ? 'title' : field;
  const columnSql = `trim(${col})`;
  const matchExpr = buildMatchExpr(columnSql, value, opts.mode, opts.case_sensitive);

  const whereNullable = field !== 'document_id';
  const where = whereNullable ? `${col} IS NOT NULL AND ${matchExpr}` : matchExpr;

  const sql = `
SELECT
  id,
  trim(document_id) AS document_id,
  publication_name,
  publication_year,
  trim(doi) AS doi,
  trim(inspire_id) AS inspire_id,
  title
FROM pdgreference
WHERE ${where}
ORDER BY ${orderSqlForField(field)}
LIMIT ${opts.limit + 1} OFFSET ${opts.start};
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const parsed = rows.map(parseReferenceRow).filter((r): r is PdgReferenceRow => r !== null);
  const has_more = parsed.length > opts.limit;
  return { candidates: has_more ? parsed.slice(0, opts.limit) : parsed, has_more };
}

export async function getPdgReferenceById(dbPath: string, id: number): Promise<PdgReferenceRow | undefined> {
  const sql = `
SELECT
  id,
  trim(document_id) AS document_id,
  publication_name,
  publication_year,
  trim(doi) AS doi,
  trim(inspire_id) AS inspire_id,
  title
FROM pdgreference
WHERE id = ${id}
LIMIT 1;
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const parsed = parseReferenceRow(rows[0]);
  return parsed ?? undefined;
}

export async function getPdgReferenceByDocumentId(
  dbPath: string,
  documentId: string,
  caseSensitive: boolean
): Promise<PdgReferenceRow | undefined> {
  const lit = sqlStringLiteral(documentId.trim());
  const where = caseSensitive ? `trim(document_id) = ${lit}` : `lower(trim(document_id)) = lower(${lit})`;

  const sql = `
SELECT
  id,
  trim(document_id) AS document_id,
  publication_name,
  publication_year,
  trim(doi) AS doi,
  trim(inspire_id) AS inspire_id,
  title
FROM pdgreference
WHERE ${where}
ORDER BY id ASC
LIMIT 1;
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const parsed = parseReferenceRow(rows[0]);
  return parsed ?? undefined;
}

export async function getPdgReferencesByIds(dbPath: string, ids: readonly number[]): Promise<Map<number, PdgReferenceRow>> {
  const unique = Array.from(new Set(ids.filter(n => Number.isFinite(n) && n > 0)));
  if (unique.length === 0) return new Map();

  const sql = `
SELECT
  id,
  trim(document_id) AS document_id,
  publication_name,
  publication_year,
  trim(doi) AS doi,
  trim(inspire_id) AS inspire_id,
  title
FROM pdgreference
WHERE id IN (${unique.join(',')})
ORDER BY id ASC;
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const map = new Map<number, PdgReferenceRow>();
  for (const row of rows) {
    const parsed = parseReferenceRow(row);
    if (!parsed) continue;
    map.set(parsed.id, parsed);
  }
  return map;
}
