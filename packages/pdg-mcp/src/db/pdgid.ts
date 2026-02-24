import { sqlite3JsonQuery, sqlStringLiteral } from './sqlite3Cli.js';

export interface PdgIdRow {
  id: number;
  pdgid: string;
  parent_pdgid: string | null;
  description: string | null;
  data_type: string | null;
  flags: string | null;
  sort: number | null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

export async function getPdgidRowByPdgid(
  dbPath: string,
  pdgid: string,
  caseSensitive: boolean = true
): Promise<PdgIdRow | undefined> {
  const lit = sqlStringLiteral(pdgid);
  const where = caseSensitive ? `pdgid = ${lit}` : `lower(pdgid) = lower(${lit})`;
  const sql = `
SELECT id, pdgid, parent_pdgid, description, data_type, flags, sort
FROM pdgid
WHERE ${where}
LIMIT 1;
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const row = rows[0];
  if (row === null || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const id = toNumber(r.id);
  const pdgidOut = toStringOrNull(r.pdgid);
  if (id === null || pdgidOut === null) return undefined;

  return {
    id,
    pdgid: pdgidOut,
    parent_pdgid: toStringOrNull(r.parent_pdgid),
    description: toStringOrNull(r.description),
    data_type: toStringOrNull(r.data_type),
    flags: toStringOrNull(r.flags),
    sort: toNumber(r.sort),
  };
}
