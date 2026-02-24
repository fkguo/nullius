import * as fs from 'fs';
import { notFound } from '@autoresearch/shared';
import { stableJsonStringify, parseJsonObject, parseJsonl } from './json.js';
import { StyleProfileSchema, type StyleProfile, StyleCorpusManifestEntrySchema, type StyleCorpusManifestEntry } from './schemas.js';
import { getCorpusManifestPath, getCorpusProfilePath, getCorpusSourcesDir, getCorpusPdfDir, getCorpusEvidenceDir, getCorpusIndexDir } from './paths.js';

export function ensureCorpusLayout(styleId: string): void {
  // Ensure these directories exist for predictable layout.
  getCorpusSourcesDir(styleId);
  getCorpusPdfDir(styleId);
  getCorpusEvidenceDir(styleId);
  getCorpusIndexDir(styleId);
}

export function readStyleProfile(styleId: string): StyleProfile {
  const profilePath = getCorpusProfilePath(styleId);
  if (!fs.existsSync(profilePath)) {
    throw notFound('Style profile not found', { style_id: styleId, path: profilePath });
  }
  const parsed = parseJsonObject(fs.readFileSync(profilePath, 'utf-8'), 'profile.json');
  return StyleProfileSchema.parse(parsed);
}

export function writeStyleProfile(profile: StyleProfile): void {
  // Create layout deterministically before writing.
  ensureCorpusLayout(profile.style_id);

  const profilePath = getCorpusProfilePath(profile.style_id);
  fs.writeFileSync(profilePath, stableJsonStringify(profile, 2) + '\n', 'utf-8');
}

export function readCorpusManifest(styleId: string): StyleCorpusManifestEntry[] {
  const manifestPath = getCorpusManifestPath(styleId);
  if (!fs.existsSync(manifestPath)) return [];
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const lines = parseJsonl(raw);
  const out: StyleCorpusManifestEntry[] = [];
  for (const line of lines) {
    out.push(StyleCorpusManifestEntrySchema.parse(line));
  }
  return out;
}

function sortManifest(entries: StyleCorpusManifestEntry[]): StyleCorpusManifestEntry[] {
  return [...entries].sort((a, b) => {
    const aNum = Number(a.recid);
    const bNum = Number(b.recid);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
    const byRecid = a.recid.localeCompare(b.recid);
    if (byRecid !== 0) return byRecid;
    return a.title.localeCompare(b.title);
  });
}

export function writeCorpusManifest(styleId: string, entries: StyleCorpusManifestEntry[]): void {
  ensureCorpusLayout(styleId);
  const manifestPath = getCorpusManifestPath(styleId);
  const sorted = sortManifest(entries);
  const content = sorted.map(e => stableJsonStringify(e)).join('\n') + (sorted.length > 0 ? '\n' : '');
  fs.writeFileSync(manifestPath, content, 'utf-8');
}

export function upsertCorpusManifestEntries(styleId: string, updates: StyleCorpusManifestEntry[]): void {
  const existing = readCorpusManifest(styleId);
  const byRecid = new Map(existing.map(e => [e.recid, e]));
  for (const u of updates) {
    byRecid.set(u.recid, u);
  }
  writeCorpusManifest(styleId, Array.from(byRecid.values()));
}
