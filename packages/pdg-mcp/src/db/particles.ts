import { sqlite3JsonQuery, sqlStringLiteral } from './sqlite3Cli.js';

export type NameMatchMode = 'exact' | 'contains' | 'prefix';

export interface PdgParticleCandidate {
  pdgid_id: number;
  pdgid: string;
  name: string;
  mcid: number | null;
  charge: number | null;
  cc_type: string | null;
  pdg_description: string | null;
  match: {
    source: 'particle' | 'item';
    matched_name: string;
    matched_item_type?: string | null;
  };
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

function buildNameMatchExpr(columnSql: string, name: string, mode: NameMatchMode, caseSensitive: boolean): string {
  const lit = sqlStringLiteral(name);
  const col = caseSensitive ? columnSql : `lower(${columnSql})`;
  const needle = caseSensitive ? lit : `lower(${lit})`;

  if (mode === 'exact') {
    return `${col} = ${needle}`;
  }
  if (mode === 'prefix') {
    return `substr(${col}, 1, length(${needle})) = ${needle}`;
  }
  return `instr(${col}, ${needle}) > 0`;
}

export async function findPdgParticlesByName(
  dbPath: string,
  name: string,
  opts: { mode: NameMatchMode; case_sensitive: boolean; start: number; limit: number }
): Promise<{ candidates: PdgParticleCandidate[]; has_more: boolean }> {
  const whereParticle = buildNameMatchExpr('p.name', name, opts.mode, opts.case_sensitive);
  const whereItem = buildNameMatchExpr('i.name', name, opts.mode, opts.case_sensitive);

  const sql = `
WITH
direct AS (
  SELECT
    p.pdgid_id AS pdgid_id,
    g.pdgid AS pdgid,
    p.name AS name,
    p.mcid AS mcid,
    p.charge AS charge,
    p.cc_type AS cc_type,
    g.description AS pdg_description,
    0 AS match_rank,
    'particle' AS match_source,
    p.name AS matched_name,
    NULL AS matched_item_type,
    g.sort AS pdgid_sort,
    0 AS map_sort
  FROM pdgparticle p
  JOIN pdgid g ON g.id = p.pdgid_id
  WHERE ${whereParticle}
),
matched_items AS (
  SELECT i.id AS item_id, i.name AS item_name, i.item_type AS item_type
  FROM pdgitem i
  WHERE ${whereItem}
),
item_targets AS (
  SELECT mi.item_name AS matched_name, mi.item_type AS matched_item_type, mi.item_id AS target_id, 0 AS map_sort
  FROM matched_items mi
  UNION ALL
  SELECT mi.item_name AS matched_name, mi.item_type AS matched_item_type, m.target_id AS target_id, m.sort AS map_sort
  FROM matched_items mi
  JOIN pdgitem_map m ON m.pdgitem_id = mi.item_id
),
from_items AS (
  SELECT
    p.pdgid_id AS pdgid_id,
    g.pdgid AS pdgid,
    p.name AS name,
    p.mcid AS mcid,
    p.charge AS charge,
    p.cc_type AS cc_type,
    g.description AS pdg_description,
    1 AS match_rank,
    'item' AS match_source,
    it.matched_name AS matched_name,
    it.matched_item_type AS matched_item_type,
    g.sort AS pdgid_sort,
    it.map_sort AS map_sort
  FROM item_targets it
  JOIN pdgparticle p ON p.pdgitem_id = it.target_id
  JOIN pdgid g ON g.id = p.pdgid_id
),
unioned AS (
  SELECT * FROM direct
  UNION ALL
  SELECT * FROM from_items
),
deduped AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY pdgid_id, name, COALESCE(mcid, -999999999)
      ORDER BY match_rank ASC, map_sort ASC
    ) AS rn
  FROM unioned
)
SELECT
  pdgid_id,
  pdgid,
  name,
  mcid,
  charge,
  cc_type,
  pdg_description,
  match_source,
  matched_name,
  matched_item_type
FROM deduped
WHERE rn = 1
ORDER BY match_rank ASC, map_sort ASC, pdgid_sort ASC, name ASC
LIMIT ${opts.limit + 1} OFFSET ${opts.start};
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const parsed: PdgParticleCandidate[] = [];

  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pdgidId = toNumber(r.pdgid_id);
    const pdgid = toStringOrNull(r.pdgid);
    const particleName = toStringOrNull(r.name);
    const matchSource = toStringOrNull(r.match_source);
    const matchedName = toStringOrNull(r.matched_name);

    if (pdgidId === null || pdgid === null || particleName === null || matchSource === null || matchedName === null) continue;
    if (matchSource !== 'particle' && matchSource !== 'item') continue;

    parsed.push({
      pdgid_id: pdgidId,
      pdgid,
      name: particleName,
      mcid: toNumber(r.mcid),
      charge: toNumber(r.charge),
      cc_type: toStringOrNull(r.cc_type),
      pdg_description: toStringOrNull(r.pdg_description),
      match: {
        source: matchSource,
        matched_name: matchedName,
        matched_item_type: toStringOrNull(r.matched_item_type),
      },
    });
  }

  const has_more = parsed.length > opts.limit;
  return { candidates: has_more ? parsed.slice(0, opts.limit) : parsed, has_more };
}

export async function findPdgParticlesByMcid(
  dbPath: string,
  mcid: number,
  opts: { start: number; limit: number }
): Promise<{ candidates: PdgParticleCandidate[]; has_more: boolean }> {
  const sql = `
SELECT
  p.pdgid_id AS pdgid_id,
  g.pdgid AS pdgid,
  p.name AS name,
  p.mcid AS mcid,
  p.charge AS charge,
  p.cc_type AS cc_type,
  g.description AS pdg_description
FROM pdgparticle p
JOIN pdgid g ON g.id = p.pdgid_id
WHERE p.mcid = ${mcid}
ORDER BY g.sort ASC, p.name ASC
LIMIT ${opts.limit + 1} OFFSET ${opts.start};
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const parsed: PdgParticleCandidate[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pdgidId = toNumber(r.pdgid_id);
    const pdgid = toStringOrNull(r.pdgid);
    const particleName = toStringOrNull(r.name);
    if (pdgidId === null || pdgid === null || particleName === null) continue;
    parsed.push({
      pdgid_id: pdgidId,
      pdgid,
      name: particleName,
      mcid: toNumber(r.mcid),
      charge: toNumber(r.charge),
      cc_type: toStringOrNull(r.cc_type),
      pdg_description: toStringOrNull(r.pdg_description),
      match: { source: 'particle', matched_name: particleName, matched_item_type: null },
    });
  }
  const has_more = parsed.length > opts.limit;
  return { candidates: has_more ? parsed.slice(0, opts.limit) : parsed, has_more };
}

export async function findPdgParticlesByPdgid(
  dbPath: string,
  pdgid: string,
  opts: { start: number; limit: number; case_sensitive: boolean }
): Promise<{ candidates: PdgParticleCandidate[]; has_more: boolean }> {
  const lit = sqlStringLiteral(pdgid);
  const where = opts.case_sensitive ? `g.pdgid = ${lit}` : `lower(g.pdgid) = lower(${lit})`;

  const sql = `
SELECT
  p.pdgid_id AS pdgid_id,
  g.pdgid AS pdgid,
  p.name AS name,
  p.mcid AS mcid,
  p.charge AS charge,
  p.cc_type AS cc_type,
  g.description AS pdg_description
FROM pdgparticle p
JOIN pdgid g ON g.id = p.pdgid_id
WHERE ${where}
ORDER BY g.sort ASC, p.name ASC
LIMIT ${opts.limit + 1} OFFSET ${opts.start};
`.trim();

  const rows = await sqlite3JsonQuery(dbPath, sql);
  const parsed: PdgParticleCandidate[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pdgidId = toNumber(r.pdgid_id);
    const pdgidOut = toStringOrNull(r.pdgid);
    const particleName = toStringOrNull(r.name);
    if (pdgidId === null || pdgidOut === null || particleName === null) continue;
    parsed.push({
      pdgid_id: pdgidId,
      pdgid: pdgidOut,
      name: particleName,
      mcid: toNumber(r.mcid),
      charge: toNumber(r.charge),
      cc_type: toStringOrNull(r.cc_type),
      pdg_description: toStringOrNull(r.pdg_description),
      match: { source: 'particle', matched_name: pdgid, matched_item_type: null },
    });
  }
  const has_more = parsed.length > opts.limit;
  return { candidates: has_more ? parsed.slice(0, opts.limit) : parsed, has_more };
}
