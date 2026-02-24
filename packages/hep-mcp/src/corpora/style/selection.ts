import type { PaperSummary } from '@autoresearch/shared';
import { createHash } from 'crypto';
import type { StyleProfile } from './schemas.js';

type PaperSummaryWithRecid = PaperSummary & { recid: string };

export interface InspireSearchPage {
  total: number;
  papers: PaperSummary[];
  has_more: boolean;
  warning?: string;
}

export interface InspireSearchClient {
  search: (
    query: string,
    options?: { sort?: string; size?: number; page?: number; arxiv_categories?: string }
  ) => Promise<InspireSearchPage>;
}

export async function searchAllPapers(
  client: InspireSearchClient,
  query: string,
  options?: { sort?: string; page_size?: number; max_results?: number; arxiv_categories?: string }
): Promise<{ total: number; papers: PaperSummary[]; truncated: boolean; warning?: string }> {
  const pageSizeRaw = options?.page_size ?? 1000;
  const pageSize = Math.min(1000, Math.max(1, Math.trunc(pageSizeRaw)));

  const hardCapRaw = options?.max_results ?? 10000;
  const hardCap = Math.min(10000, Math.max(1, Math.trunc(hardCapRaw)));

  const papers: PaperSummary[] = [];
  let total = 0;
  let warning: string | undefined;

  const maxPages = Math.ceil(hardCap / pageSize) + 1;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await client.search(query, { sort: options?.sort, size: pageSize, page, arxiv_categories: options?.arxiv_categories });
    if (page === 1) {
      total = res.total;
      warning = res.warning;
    }

    papers.push(...res.papers);

    if (!res.has_more) break;
    if (papers.length >= hardCap) break;
    if (res.papers.length === 0) break;
  }

  const sliced = papers.slice(0, hardCap);
  const truncated = total > sliced.length;
  const mergedWarning = truncated
    ? warning
      ? `${warning} Truncated to max_results=${hardCap} (total=${total}).`
      : `Truncated to max_results=${hardCap} (total=${total}).`
    : warning;

  return {
    total,
    papers: sliced,
    truncated,
    warning: mergedWarning,
  };
}

function sha256Hex16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function paperYearBin(year: number | undefined, bins: StyleProfile['selection']['year_bins']): string | null {
  if (!year || !Number.isFinite(year)) return null;
  for (const bin of bins) {
    const startOk = bin.start_year === undefined ? true : year >= bin.start_year;
    const endOk = bin.end_year === undefined ? true : year <= bin.end_year;
    if (startOk && endOk) return bin.id;
  }
  return null;
}

function pickCategory(paper: PaperSummary, target: string[]): { category: string | null; source: 'primary' | 'cross' | 'none' } {
  const primary = paper.arxiv_primary_category?.trim();
  if (primary && target.includes(primary)) {
    return { category: primary, source: 'primary' };
  }
  const cats = paper.arxiv_categories ?? [];
  for (const t of target) {
    if (cats.includes(t)) return { category: t, source: 'cross' };
  }
  return { category: null, source: 'none' };
}

function compareWithinStratum(a: PaperSummary, b: PaperSummary, sort: StyleProfile['selection']['sort_within_stratum']): number {
  if (sort === 'mostrecent') {
    const ay = a.year ?? -1;
    const by = b.year ?? -1;
    if (ay !== by) return by - ay;
  }
  if (sort === 'mostcited') {
    const ac = a.citation_count ?? -1;
    const bc = b.citation_count ?? -1;
    if (ac !== bc) return bc - ac;
  }

  const aRecid = Number(a.recid);
  const bRecid = Number(b.recid);
  if (Number.isFinite(aRecid) && Number.isFinite(bRecid) && aRecid !== bRecid) return aRecid - bRecid;
  return String(a.recid).localeCompare(String(b.recid));
}

export interface StratifiedSelectionItem {
  paper: PaperSummaryWithRecid;
  selection: {
    category: string | null;
    year_bin: string | null;
    category_source: 'primary' | 'cross' | 'none';
    rank_in_stratum?: number;
    order_key: string;
  };
}

function hasRecid(paper: PaperSummary): paper is PaperSummaryWithRecid {
  return typeof paper?.recid === 'string' && paper.recid.length > 0;
}

export function buildStratifiedSelection(params: {
  profile: StyleProfile;
  candidates: PaperSummary[];
  target_papers: number;
  existing_recids?: Set<string>;
}): { selected: StratifiedSelectionItem[]; stats: { by_stratum: Record<string, number>; filled: number } } {
  const target = Math.max(1, Math.trunc(params.target_papers));
  const existing = params.existing_recids ?? new Set<string>();

  const bins = params.profile.selection.year_bins;
  const cats = params.profile.selection.target_categories;

  const eligible = params.candidates
    .filter(hasRecid)
    .filter(p => !existing.has(p.recid));

  const strataKeys: string[] = [];
  for (const c of cats) {
    for (const b of bins) strataKeys.push(`${c}__${b.id}`);
  }

  const base = Math.floor(target / strataKeys.length);
  const remainder = target % strataKeys.length;
  const quotaByStratum = new Map<string, number>();
  for (let i = 0; i < strataKeys.length; i++) {
    quotaByStratum.set(strataKeys[i]!, base + (i < remainder ? 1 : 0));
  }

  const grouped = new Map<
    string,
    Array<{ paper: PaperSummaryWithRecid; category: string; year_bin: string; category_source: 'primary' | 'cross' }>
  >();
  for (const p of eligible) {
    const { category, source } = pickCategory(p, cats);
    if (!category || source === 'none') continue;
    const yb = paperYearBin(p.year, bins);
    if (!yb) continue;
    const key = `${category}__${yb}`;
    const arr = grouped.get(key) ?? [];
    arr.push({ paper: p, category, year_bin: yb, category_source: source });
    grouped.set(key, arr);
  }

  const picked: StratifiedSelectionItem[] = [];
  const usedRecids = new Set<string>();

  for (const key of strataKeys) {
    const quota = quotaByStratum.get(key) ?? 0;
    if (quota <= 0) continue;
    const arr = grouped.get(key) ?? [];
    arr.sort((a, b) => compareWithinStratum(a.paper, b.paper, params.profile.selection.sort_within_stratum));

    const [category, year_bin] = key.split('__');
    for (let i = 0; i < Math.min(quota, arr.length); i++) {
      const pickedCandidate = arr[i]!;
      if (usedRecids.has(pickedCandidate.paper.recid)) continue;
      usedRecids.add(pickedCandidate.paper.recid);
      picked.push({
        paper: pickedCandidate.paper,
        selection: {
          category: category ?? null,
          year_bin: year_bin ?? null,
          category_source: pickedCandidate.category_source,
          rank_in_stratum: i,
          order_key: `${key}:${String(i).padStart(4, '0')}`,
        },
      });
    }
  }

  const remainingNeeded = Math.max(0, target - picked.length);
  const fillPool = eligible.filter(p => !usedRecids.has(p.recid));
  fillPool.sort((a, b) => sha256Hex16(a.recid).localeCompare(sha256Hex16(b.recid)));

  for (let i = 0; i < Math.min(remainingNeeded, fillPool.length); i++) {
    const paper = fillPool[i]!;
    if (usedRecids.has(paper.recid)) continue;
    usedRecids.add(paper.recid);
    picked.push({
      paper,
      selection: {
        category: null,
        year_bin: null,
        category_source: 'none',
        order_key: `fill:${String(i).padStart(4, '0')}:${sha256Hex16(paper.recid)}`,
      },
    });
  }

  const byStratum: Record<string, number> = {};
  for (const it of picked) {
    const k = it.selection.category && it.selection.year_bin ? `${it.selection.category}__${it.selection.year_bin}` : 'fill';
    byStratum[k] = (byStratum[k] || 0) + 1;
  }

  // Stable, monotonic ordering: primary picks already in strata order, then fill.
  return {
    selected: picked,
    stats: {
      by_stratum: byStratum,
      filled: byStratum.fill ?? 0,
    },
  };
}
