import type { PaperSummary } from '@autoresearch/shared';
import * as api from '../../../api/client.js';
import type { BibEntry } from './bibliographyExtractor.js';
import { isValidTexkey, normalizeJournal } from './inspireValidator.js';

export type CitekeyMatchMethod = 'doi' | 'arxiv' | 'texkey' | 'journal_ref' | 'title_author_year';

export interface CitekeyCandidate {
  recid: string;
  score: number;
  title?: string;
  year?: number;
  authors?: string[];
  texkey?: string;
}

export interface CitekeyMapping {
  status: 'matched' | 'not_found' | 'error';
  recid?: string;
  match_method?: CitekeyMatchMethod;
  confidence?: number;
  candidates?: CitekeyCandidate[];
  error?: string;
}

function looksLikeNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('404') || msg.toLowerCase().includes('not found');
}

function parseYear(year: string | number | undefined): number | undefined {
  if (typeof year === 'number' && Number.isFinite(year)) return year;
  if (typeof year !== 'string') return undefined;
  const m = year.match(/\b(19|20)\d{2}\b/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeTitleForMatch(title: string): string {
  return title
    .replace(/[{}$]/g, '')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenizeTitle(title: string): string[] {
  const cleaned = normalizeTitleForMatch(title).replace(/[^a-z0-9 ]/g, ' ');
  return cleaned
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 4);
}

function titleSimilarity(a: string, b: string): number {
  const wa = new Set(tokenizeTitle(a));
  const wb = new Set(tokenizeTitle(b));
  if (wa.size === 0 || wb.size === 0) return 0.5;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size);
}

function firstAuthorLastName(authors: string[] | undefined): string | undefined {
  const a0 = authors?.[0]?.trim();
  if (!a0) return undefined;
  if (a0.includes(',')) {
    const last = a0.split(',')[0]?.trim();
    return last || undefined;
  }
  const parts = a0.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1];
}

function authorMatches(lastName: string | undefined, paperAuthors: string[] | undefined): boolean {
  const ln = lastName?.toLowerCase();
  if (!ln) return false;
  for (const a of paperAuthors || []) {
    if (a.toLowerCase().includes(ln)) return true;
  }
  return false;
}

function extractPageToken(pages: string | undefined): string | undefined {
  if (!pages) return undefined;
  const trimmed = pages.trim();
  const m = trimmed.match(/\b(\d{6}|\d{4,5}|\d{1,4})\b/);
  return m?.[1];
}

function buildTitleAuthorYearQuery(entry: BibEntry): string | null {
  if (!entry.title) return null;
  const title = normalizeTitleForMatch(entry.title);
  if (!title) return null;

  const parts: string[] = [];
  // Phrase search is more robust for long titles; fallback scoring handles mismatches.
  parts.push(`t:\"${title.replace(/\"/g, '')}\"`);

  const lastName = firstAuthorLastName(entry.authors);
  if (lastName) parts.push(`a:${lastName}`);

  const year = parseYear(entry.year);
  if (year) parts.push(`date:${year}->${year}`);

  return parts.join(' ');
}

function scoreCandidates(entry: BibEntry, candidates: PaperSummary[]): CitekeyCandidate[] {
  const entryYear = parseYear(entry.year);
  const entryLast = firstAuthorLastName(entry.authors);

  const scored: CitekeyCandidate[] = candidates
    .filter((p): p is PaperSummary & { recid: string } => typeof p.recid === 'string' && p.recid.length > 0)
    .map(p => {
    const tScore = entry.title && p.title ? titleSimilarity(entry.title, p.title) : 0.5;
    const aScore = authorMatches(entryLast, p.authors) ? 1 : 0;
    const yScore = entryYear && p.year ? (entryYear === p.year ? 1 : 0) : 0.5;
    const score = 0.6 * tScore + 0.2 * aScore + 0.2 * yScore;
    return {
      recid: p.recid,
      score,
      title: p.title,
      year: p.year,
      authors: p.authors,
      texkey: p.texkey,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function matchByDoi(entry: BibEntry): Promise<CitekeyMapping | null> {
  if (!entry.doi) return null;
  try {
    const paper = await api.getByDoi(entry.doi);
    return {
      status: 'matched',
      recid: paper.recid,
      match_method: 'doi',
      confidence: 1,
    };
  } catch (err) {
    if (looksLikeNotFoundError(err)) return null;
    return { status: 'error', error: `DOI lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function matchByArxiv(entry: BibEntry): Promise<CitekeyMapping | null> {
  if (!entry.arxiv_id) return null;
  try {
    const paper = await api.getByArxiv(entry.arxiv_id);
    return {
      status: 'matched',
      recid: paper.recid,
      match_method: 'arxiv',
      confidence: 1,
    };
  } catch (err) {
    if (looksLikeNotFoundError(err)) return null;
    return { status: 'error', error: `arXiv lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function matchByTexkey(entry: BibEntry): Promise<CitekeyMapping | null> {
  if (!isValidTexkey(entry.key)) return null;

  try {
    const res = await api.search(`texkey:${entry.key}`, { size: 5 });
    const papers = res.papers.filter((p): p is PaperSummary & { recid: string } => typeof p.recid === 'string' && p.recid.length > 0);
    if (papers.length === 0) return null;
    const candidates = papers.slice(0, 5).map((p, idx) => ({
      recid: p.recid,
      score: idx === 0 ? 0.95 : 0.6,
      title: p.title,
      year: p.year,
      authors: p.authors,
      texkey: p.texkey,
    }));
    return {
      status: 'matched',
      recid: papers[0].recid,
      match_method: 'texkey',
      confidence: papers.length === 1 ? 0.95 : 0.75,
      candidates: papers.length > 1 ? candidates : undefined,
    };
  } catch {
    return null;
  }
}

async function matchByJournalRef(entry: BibEntry): Promise<CitekeyMapping | null> {
  if (!entry.journal) return null;

  const volume = entry.volume || (() => {
    if (!entry.raw) return undefined;
    const m = entry.raw.match(/\b(\d{1,4})\s*[,(]/);
    return m?.[1];
  })();

  if (!volume) return null;
  const page = extractPageToken(entry.pages) || extractPageToken(entry.raw);

  const journal = normalizeJournal(entry.journal);
  const query = page ? `j ${journal},${volume},${page}` : `j ${journal},${volume}`;

  try {
    const res = await api.search(query, { size: 5 });
    const papers = res.papers.filter((p): p is PaperSummary & { recid: string } => typeof p.recid === 'string' && p.recid.length > 0);
    if (papers.length === 0) return null;
    const entryYear = parseYear(entry.year);

    const pick =
      entryYear ? papers.find(p => (p.year ?? -1) === entryYear) || papers[0] : papers[0];

    const candidates = papers.slice(0, 5).map((p, idx) => ({
      recid: p.recid,
      score: idx === 0 ? 0.8 : 0.6,
      title: p.title,
      year: p.year,
      authors: p.authors,
      texkey: p.texkey,
    }));

    return {
      status: 'matched',
      recid: pick.recid,
      match_method: 'journal_ref',
      confidence: 0.8,
      candidates: papers.length > 1 ? candidates : undefined,
    };
  } catch {
    return null;
  }
}

async function matchByTitleAuthorYear(entry: BibEntry): Promise<CitekeyMapping | null> {
  if (!entry.title || !entry.authors || entry.authors.length === 0) return null;

  const query = buildTitleAuthorYearQuery(entry);
  if (!query) return null;

  try {
    const res = await api.search(query, { size: 10 });
    const papers = res.papers.filter((p): p is PaperSummary & { recid: string } => typeof p.recid === 'string' && p.recid.length > 0);
    if (papers.length === 0) return null;

    const scored = scoreCandidates(entry, papers);
    const best = scored[0];
    if (!best) return null;

    // Conservative threshold to avoid unsafe expansion.
    const threshold = 0.78;
    if (best.score < threshold) {
      return {
        status: 'not_found',
        match_method: 'title_author_year',
        confidence: best.score,
        candidates: scored.slice(0, 5),
      };
    }

    return {
      status: 'matched',
      recid: best.recid,
      match_method: 'title_author_year',
      confidence: best.score,
      candidates: scored.slice(0, 5),
    };
  } catch {
    return null;
  }
}

export async function mapBibEntryToInspire(entry: BibEntry): Promise<CitekeyMapping> {
  const methods: Array<(e: BibEntry) => Promise<CitekeyMapping | null>> = [
    matchByDoi,
    matchByArxiv,
    matchByTexkey,
    matchByJournalRef,
    matchByTitleAuthorYear,
  ];

  for (const method of methods) {
    const res = await method(entry);
    if (res) return res;
  }

  return { status: 'not_found' };
}

export async function mapBibEntriesToInspire(
  entries: BibEntry[]
): Promise<Record<string, CitekeyMapping>> {
  const out: Record<string, CitekeyMapping> = {};
  for (const entry of entries) {
    // Last-one-wins on duplicate keys (rare but possible).
    out[entry.key] = await mapBibEntryToInspire(entry);
  }
  return out;
}
