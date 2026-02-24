/**
 * INSPIRE Bibliography Validator
 * Cross-validates LaTeX bibliography entries against INSPIRE database
 */

import * as api from '../../../api/client.js';
import type { BibEntry } from './bibliographyExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MatchMethod = 'recid' | 'doi' | 'arxiv' | 'texkey' | 'publication_info';

export interface Discrepancy {
  field: string;
  local: string;
  inspire: string;
}

export interface ValidationResult {
  /** Citation key from bibliography */
  key: string;
  /** Validation status */
  status: 'matched' | 'not_found' | 'error';
  /** INSPIRE recid if matched */
  inspire_recid?: string;
  /** Method used to match */
  match_method?: MatchMethod;
  /** Field discrepancies between local and INSPIRE */
  discrepancies?: Discrepancy[];
  /** Error message if status is 'error' */
  error?: string;
}

export interface ValidateBibliographyOptions {
  /** Check for discrepancies (default: true) */
  check_discrepancies?: boolean;
  /** Maximum entries to validate (default: all) */
  max_entries?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize string for comparison (lowercase, trim, remove extra spaces)
 */
function normalize(str: string | undefined): string {
  if (!str) return '';
  return str.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check if key looks like an INSPIRE texkey
 * INSPIRE texkeys follow pattern: Author:YYYYxxx (e.g., Guo:2017jvc, LlewellynSmith:1972abc)
 */
export function isValidTexkey(key: string): boolean {
  // Pattern: Name(s):YYYYxxx where xxx is 2-4 lowercase letters
  // Supports compound names like LlewellynSmith, DeGrand, etc.
  return /^[A-Za-z][A-Za-z-]*:\d{4}[a-z]{2,4}$/i.test(key);
}

/**
 * Normalize journal name for INSPIRE search
 * Maps various journal name formats to INSPIRE's standard abbreviations
 */
export function normalizeJournal(journal: string): string {
  const lower = journal.toLowerCase().trim();
  // Remove punctuation for matching
  const normalized = lower.replace(/[.,;:'"()[\]{}]/g, '').replace(/\s+/g, ' ');

  // Comprehensive journal mappings to INSPIRE format
  // Format: normalized input -> INSPIRE abbreviation
  const mappings: Record<string, string> = {
    // Physical Review family
    'physical review letters': 'Phys.Rev.Lett.',
    'phys rev lett': 'Phys.Rev.Lett.',
    'physical review d': 'Phys.Rev.D',
    'phys rev d': 'Phys.Rev.D',
    'physical review c': 'Phys.Rev.C',
    'phys rev c': 'Phys.Rev.C',
    'physical review a': 'Phys.Rev.A',
    'phys rev a': 'Phys.Rev.A',
    'physical review b': 'Phys.Rev.B',
    'phys rev b': 'Phys.Rev.B',
    'physical review e': 'Phys.Rev.E',
    'phys rev e': 'Phys.Rev.E',
    'physical review x': 'Phys.Rev.X',
    'phys rev x': 'Phys.Rev.X',
    'physical review research': 'Phys.Rev.Res.',
    'phys rev res': 'Phys.Rev.Res.',
    'physical review accel beams': 'Phys.Rev.Accel.Beams',

    // JHEP - special handling for various formats
    'journal of high energy physics': 'JHEP',
    'j high energy phys': 'JHEP',
    'jhep': 'JHEP',

    // Nuclear Physics
    'nuclear physics b': 'Nucl.Phys.B',
    'nucl phys b': 'Nucl.Phys.B',
    'nuclear physics a': 'Nucl.Phys.A',
    'nucl phys a': 'Nucl.Phys.A',

    // Physics Letters
    'physics letters b': 'Phys.Lett.B',
    'phys lett b': 'Phys.Lett.B',
    'physics letters a': 'Phys.Lett.A',
    'phys lett a': 'Phys.Lett.A',

    // European Physical Journal
    'european physical journal c': 'Eur.Phys.J.C',
    'eur phys j c': 'Eur.Phys.J.C',
    'european physical journal a': 'Eur.Phys.J.A',
    'eur phys j a': 'Eur.Phys.J.A',

    // Reviews and Reports
    'reviews of modern physics': 'Rev.Mod.Phys.',
    'rev mod phys': 'Rev.Mod.Phys.',
    'physics reports': 'Phys.Rept.',
    'phys rep': 'Phys.Rept.',
    'phys rept': 'Phys.Rept.',
    'reports on progress in physics': 'Rept.Prog.Phys.',
    'rep prog phys': 'Rept.Prog.Phys.',

    // Cosmology and Gravity
    'journal of cosmology and astroparticle physics': 'JCAP',
    'j cosmol astropart phys': 'JCAP',
    'jcap': 'JCAP',
    'classical and quantum gravity': 'Class.Quant.Grav.',
    'class quantum grav': 'Class.Quant.Grav.',
    'living reviews in relativity': 'Living Rev.Rel.',
    'living rev rel': 'Living Rev.Rel.',
    'physics of the dark universe': 'Phys.Dark Univ.',
    'phys dark univ': 'Phys.Dark Univ.',

    // Astrophysics
    'astrophysical journal': 'Astrophys.J.',
    'astrophys j': 'Astrophys.J.',
    'astrophysical journal letters': 'Astrophys.J.Lett.',
    'astrophys j lett': 'Astrophys.J.Lett.',
    'monthly notices of the royal astronomical society': 'Mon.Not.Roy.Astron.Soc.',
    'mon not roy astron soc': 'Mon.Not.Roy.Astron.Soc.',
    'astronomy and astrophysics': 'Astron.Astrophys.',
    'astron astrophys': 'Astron.Astrophys.',

    // Japanese journals
    'progress of theoretical physics': 'Prog.Theor.Phys.',
    'prog theor phys': 'Prog.Theor.Phys.',
    'progress of theoretical and experimental physics': 'PTEP',
    'prog theor exp phys': 'PTEP',
    'ptep': 'PTEP',

    // International journals
    'international journal of modern physics a': 'Int.J.Mod.Phys.A',
    'int j mod phys a': 'Int.J.Mod.Phys.A',
    'international journal of modern physics d': 'Int.J.Mod.Phys.D',
    'int j mod phys d': 'Int.J.Mod.Phys.D',
    'international journal of modern physics e': 'Int.J.Mod.Phys.E',
    'int j mod phys e': 'Int.J.Mod.Phys.E',
    'modern physics letters a': 'Mod.Phys.Lett.A',
    'mod phys lett a': 'Mod.Phys.Lett.A',

    // Chinese journals
    'chinese physics c': 'Chin.Phys.C',
    'chin phys c': 'Chin.Phys.C',
    'chinese physics letters': 'Chin.Phys.Lett.',
    'chin phys lett': 'Chin.Phys.Lett.',
    'chinese physics b': 'Chin.Phys.B',
    'chin phys b': 'Chin.Phys.B',
    'communications in theoretical physics': 'Commun.Theor.Phys.',
    'commun theor phys': 'Commun.Theor.Phys.',
    'science china physics mechanics and astronomy': 'Sci.China Phys.Mech.Astron.',
    'sci china phys mech astron': 'Sci.China Phys.Mech.Astron.',
    'acta physica sinica': 'Acta Phys.Sin.',
    'acta phys sin': 'Acta Phys.Sin.',
    'nuclear science and techniques': 'Nucl.Sci.Tech.',
    'nucl sci tech': 'Nucl.Sci.Tech.',
    'science bulletin': 'Sci.Bull.',
    'sci bull': 'Sci.Bull.',

    // Other important journals
    'annals of physics': 'Annals Phys.',
    'ann phys': 'Annals Phys.',
    'new journal of physics': 'New J.Phys.',
    'new j phys': 'New J.Phys.',
    'journal of physics g': 'J.Phys.G',
    'j phys g': 'J.Phys.G',
    'communications in mathematical physics': 'Commun.Math.Phys.',
    'commun math phys': 'Commun.Math.Phys.',
    'nuclear instruments and methods a': 'Nucl.Instrum.Meth.A',
    'nucl instrum meth a': 'Nucl.Instrum.Meth.A',
    'computer physics communications': 'Comput.Phys.Commun.',
    'comput phys commun': 'Comput.Phys.Commun.',
    'few body systems': 'Few Body Syst.',
    'few body syst': 'Few Body Syst.',
    'fortschritte der physik': 'Fortsch.Phys.',
    'fortsch phys': 'Fortsch.Phys.',

    // Nature and Science
    'nature': 'Nature',
    'nature physics': 'Nature Phys.',
    'nat phys': 'Nature Phys.',
    'nature communications': 'Nature Commun.',
    'nat commun': 'Nature Commun.',
    'science': 'Science',
    'science advances': 'Sci.Adv.',
    'sci adv': 'Sci.Adv.',

    // Historical journals
    'zeitschrift fur physik c': 'Z.Phys.C',
    'z phys c': 'Z.Phys.C',
    'zeitschrift fur physik a': 'Z.Phys.A',
    'z phys a': 'Z.Phys.A',
    'nuovo cimento a': 'Nuovo Cim.A',
    'nuovo cim a': 'Nuovo Cim.A',
    'nuovo cimento b': 'Nuovo Cim.B',
    'nuovo cim b': 'Nuovo Cim.B',
  };

  // Try normalized match first
  if (mappings[normalized]) return mappings[normalized];

  // Try original lowercase match
  if (mappings[lower]) return mappings[lower];

  // Already in abbreviated form (contains dots)
  if (journal.includes('.')) return journal;

  return journal;
}

/**
 * Compare years with tolerance for publication delays
 */
function yearsMatch(local: string | undefined, inspire: number | undefined): boolean {
  if (!local || !inspire) return true; // Skip if either missing
  const localYear = parseInt(local, 10);
  if (isNaN(localYear)) return true;
  // Allow 1 year difference for publication delays
  return Math.abs(localYear - inspire) <= 1;
}

/**
 * Find discrepancies between local entry and INSPIRE data
 */
function findDiscrepancies(
  entry: BibEntry,
  inspirePaper: { title?: string; year?: number; authors?: string[] }
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  // Check year
  if (entry.year && inspirePaper.year) {
    const localYear = parseInt(entry.year, 10);
    if (!isNaN(localYear) && Math.abs(localYear - inspirePaper.year) > 1) {
      discrepancies.push({
        field: 'year',
        local: entry.year,
        inspire: String(inspirePaper.year),
      });
    }
  }

  // Check title (fuzzy match)
  if (entry.title && inspirePaper.title) {
    const localTitle = normalize(entry.title);
    const inspireTitle = normalize(inspirePaper.title);
    // Simple similarity check - if less than 50% overlap, flag as discrepancy
    if (localTitle && inspireTitle && !titlesMatch(localTitle, inspireTitle)) {
      discrepancies.push({
        field: 'title',
        local: entry.title,
        inspire: inspirePaper.title,
      });
    }
  }

  return discrepancies;
}

/**
 * Check if two titles are similar enough
 */
function titlesMatch(a: string, b: string): boolean {
  // Remove common LaTeX artifacts
  const cleanA = a.replace(/[{}$\\]/g, '').toLowerCase();
  const cleanB = b.replace(/[{}$\\]/g, '').toLowerCase();

  // Check if one contains the other (handles truncation)
  if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;

  // Simple word overlap check
  const wordsA = new Set(cleanA.split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(cleanB.split(/\s+/).filter(w => w.length > 3));

  if (wordsA.size === 0 || wordsB.size === 0) return true;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Internal result with paper data for discrepancy check */
interface MatchResult {
  result: ValidationResult;
  paper?: { title?: string; year?: number; authors?: string[] };
}

/**
 * Try to match entry by recid (if stored in inspire_recid field)
 */
async function matchByRecid(entry: BibEntry): Promise<MatchResult | null> {
  if (!entry.inspire_recid) return null;

  try {
    const paper = await api.getPaper(entry.inspire_recid);
    return {
      result: {
        key: entry.key,
        status: 'matched',
        inspire_recid: paper.recid,
        match_method: 'recid',
      },
      paper,
    };
  } catch (err) {
    // Return error status for API failures
    return {
      result: {
        key: entry.key,
        status: 'error',
        error: `recid lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Try to match entry by DOI
 */
async function matchByDoi(entry: BibEntry): Promise<MatchResult | null> {
  if (!entry.doi) return null;

  try {
    const paper = await api.getByDoi(entry.doi);
    return {
      result: {
        key: entry.key,
        status: 'matched',
        inspire_recid: paper.recid,
        match_method: 'doi',
      },
      paper,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 means not found, other errors are API failures
    if (msg.includes('404') || msg.includes('not found')) {
      return null;
    }
    return {
      result: {
        key: entry.key,
        status: 'error',
        error: `DOI lookup failed: ${msg}`,
      },
    };
  }
}

/**
 * Try to match entry by arXiv ID
 */
async function matchByArxiv(entry: BibEntry): Promise<MatchResult | null> {
  if (!entry.arxiv_id) return null;

  try {
    const paper = await api.getByArxiv(entry.arxiv_id);
    return {
      result: {
        key: entry.key,
        status: 'matched',
        inspire_recid: paper.recid,
        match_method: 'arxiv',
      },
      paper,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('not found')) {
      return null;
    }
    return {
      result: {
        key: entry.key,
        status: 'error',
        error: `arXiv lookup failed: ${msg}`,
      },
    };
  }
}

/**
 * Try to match entry by texkey
 */
async function matchByTexkey(entry: BibEntry): Promise<MatchResult | null> {
  if (!isValidTexkey(entry.key)) return null;

  try {
    const searchResult = await api.search(`texkey:${entry.key}`, { size: 1 });
    if (searchResult.papers.length > 0) {
      const paper = searchResult.papers[0];
      return {
        result: {
          key: entry.key,
          status: 'matched',
          inspire_recid: paper.recid,
          match_method: 'texkey',
        },
        paper,
      };
    }
  } catch {
    // Search failed
  }
  return null;
}

/**
 * Try to match entry by publication info (journal, volume, page)
 */
async function matchByPublicationInfo(entry: BibEntry): Promise<MatchResult | null> {
  if (!entry.journal) return null;

  let volume: string | undefined;
  let page: string | undefined;

  if (entry.raw) {
    const volMatch = entry.raw.match(/\b(\d{1,4})\s*[,(]/);
    if (volMatch) volume = volMatch[1];
    const pageMatch = entry.raw.match(/\b(\d{6}|\d{4,5})\b/);
    if (pageMatch) page = pageMatch[1];
  }

  if (!volume) return null;

  try {
    const journal = normalizeJournal(entry.journal);
    const query = page ? `j ${journal},${volume},${page}` : `j ${journal},${volume}`;
    const searchResult = await api.search(query, { size: 1 });

    if (searchResult.papers.length > 0) {
      const paper = searchResult.papers[0];
      if (yearsMatch(entry.year, paper.year)) {
        return {
          result: {
            key: entry.key,
            status: 'matched',
            inspire_recid: paper.recid,
            match_method: 'publication_info',
          },
          paper,
        };
      }
    }
  } catch {
    // Search failed
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate bibliography entries against INSPIRE database
 */
export async function validateBibliography(
  entries: BibEntry[],
  options: ValidateBibliographyOptions = {}
): Promise<ValidationResult[]> {
  const { check_discrepancies = true, max_entries } = options;
  const toValidate = max_entries ? entries.slice(0, max_entries) : entries;
  const results: ValidationResult[] = [];

  for (const entry of toValidate) {
    let matchResult: MatchResult | null = null;

    // Try matching methods in priority order
    matchResult = await matchByRecid(entry);
    if (!matchResult) matchResult = await matchByDoi(entry);
    if (!matchResult) matchResult = await matchByArxiv(entry);
    if (!matchResult) matchResult = await matchByTexkey(entry);
    if (!matchResult) matchResult = await matchByPublicationInfo(entry);

    if (matchResult) {
      const result = matchResult.result;
      // Check discrepancies using cached paper data (no extra API call)
      if (check_discrepancies && matchResult.paper) {
        const discrepancies = findDiscrepancies(entry, matchResult.paper);
        if (discrepancies.length > 0) {
          result.discrepancies = discrepancies;
        }
      }
      results.push(result);
    } else {
      results.push({ key: entry.key, status: 'not_found' });
    }
  }

  return results;
}
