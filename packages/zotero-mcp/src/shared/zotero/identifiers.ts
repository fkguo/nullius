import { invalidParams } from '@autoresearch/shared';

export interface ZoteroItemIdentifiers {
  zotero_item_key: string;
  title?: string;
  doi?: string;
  arxiv_id?: string;
  inspire_recid?: string;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(obj: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function normalizeZoteroDoi(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const m = s.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
  return m?.[0];
}

export function normalizeZoteroArxivId(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  // New style: 1234.56789[vN]
  const modern = s.match(/\b(\d{4}\.\d{4,5})(v\d+)?\b/i);
  if (modern) return `${modern[1]}${modern[2] ?? ''}`;

  // Old style: hep-ph/9701234[vN]
  const legacy = s.match(/\b([a-z\-]+\/\d{7})(v\d+)?\b/i);
  if (legacy) return `${legacy[1]}${legacy[2] ?? ''}`;

  return undefined;
}

export function parseZoteroExtraIdentifiers(
  extra: string
): Partial<Pick<ZoteroItemIdentifiers, 'doi' | 'arxiv_id' | 'inspire_recid'>> {
  const out: Partial<Pick<ZoteroItemIdentifiers, 'doi' | 'arxiv_id' | 'inspire_recid'>> = {};

  const lines = extra
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!out.inspire_recid) {
      const m = line.match(/\b(?:INSPIRE|inspire)\s*:\s*(\d+)\b/);
      if (m) out.inspire_recid = m[1];
    }

    if (!out.arxiv_id) {
      const m = line.match(/\b(?:arXiv|_eprint)\s*:\s*(.+)\b/i);
      if (m) {
        const raw = m[1] ?? '';
        const token = raw.split(/\s+/).filter(Boolean)[0] ?? '';
        const normalized = normalizeZoteroArxivId(token);
        if (normalized) out.arxiv_id = normalized;
      }
    }

    if (!out.doi) {
      const normalized = normalizeZoteroDoi(line);
      if (normalized) out.doi = normalized;
      else {
        const m = line.match(/\bdoi\s*:\s*([^\s]+)\b/i);
        if (m) {
          const doi2 = normalizeZoteroDoi(m[1]);
          if (doi2) out.doi = doi2;
        }
      }
    }
  }

  return out;
}

export function extractZoteroItemIdentifiers(item: unknown): ZoteroItemIdentifiers {
  if (!isRecord(item)) throw invalidParams('Invalid Zotero item (expected object)');
  const key = item.key;
  if (typeof key !== 'string' || !key.trim()) throw invalidParams('Invalid Zotero item: missing key');

  const warnings: string[] = [];

  const data = isRecord(item.data) ? item.data : {};
  const title = readStringField(data, ['title', 'Title']);
  const doiField = readStringField(data, ['DOI', 'doi']);
  const urlField = readStringField(data, ['url', 'URL']);
  const journalAbbrev = readStringField(data, ['journalAbbreviation', 'journalAbbrev', 'JournalAbbreviation']);
  const publicationTitle = readStringField(data, ['publicationTitle', 'PublicationTitle']);
  const extra = readStringField(data, ['extra', 'Extra']) ?? '';

  const archive = readStringField(data, ['archive', 'Archive']);
  const archiveLocation = readStringField(data, ['archiveLocation', 'archive_location', 'ArchiveLocation']);

  const parsedExtra = extra ? parseZoteroExtraIdentifiers(extra) : {};
  const doiFromUrl = urlField ? normalizeZoteroDoi(urlField) : undefined;
  const doi = normalizeZoteroDoi(doiField ?? doiFromUrl ?? parsedExtra.doi ?? '');
  const arxivIdField = readStringField(data, ['arXiv', 'arxiv', 'arXivID', 'arxivId']);
  const arxivFromUrl = (() => {
    if (!urlField) return undefined;
    const m = urlField.match(/arxiv\.org\/abs\/([^\s?#]+)/i);
    return m ? normalizeZoteroArxivId(m[1]) : undefined;
  })();
  const arxivFromJournal = journalAbbrev ? normalizeZoteroArxivId(journalAbbrev) : undefined;
  const arxivFromPublication = publicationTitle ? normalizeZoteroArxivId(publicationTitle) : undefined;
  const arxiv_id = normalizeZoteroArxivId(
    arxivIdField ?? arxivFromUrl ?? arxivFromJournal ?? arxivFromPublication ?? parsedExtra.arxiv_id ?? ''
  );
  const inspire_recid =
    archive && archive.toLowerCase() === 'inspire' && archiveLocation && /^\d+$/.test(archiveLocation)
      ? archiveLocation
      : parsedExtra.inspire_recid;

  if (doiField && !doi) warnings.push(`Unrecognized DOI format: ${doiField}`);
  if (arxivIdField && !arxiv_id) warnings.push(`Unrecognized arXiv ID format: ${arxivIdField}`);

  return {
    zotero_item_key: key.trim(),
    title,
    doi,
    arxiv_id,
    inspire_recid,
    warnings,
  };
}

