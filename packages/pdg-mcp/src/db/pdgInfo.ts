import { sqlite3JsonQuery } from './sqlite3Cli.js';

export type PdgInfoMap = Record<string, string | null>;

export async function readPdgInfoMap(dbPath: string): Promise<PdgInfoMap> {
  const rows = await sqlite3JsonQuery(dbPath, 'SELECT name, value FROM pdginfo ORDER BY id;');

  const out: PdgInfoMap = {};
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as { name?: unknown; value?: unknown };
    if (typeof r.name !== 'string' || r.name.length === 0) continue;
    out[r.name] = typeof r.value === 'string' ? r.value : r.value === null ? null : String(r.value);
  }
  return out;
}
