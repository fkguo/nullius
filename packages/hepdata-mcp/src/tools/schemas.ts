import { z } from 'zod';
import { optionalBudgetInt } from '@autoresearch/shared';

export const HepDataSearchSchema = z.object({
  inspire_recid: z.number().int().positive().optional(),
  arxiv_id: z.string().trim().min(1).optional(),
  doi: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  reactions: z.string().trim().min(1).optional(),
  collaboration: z.string().trim().min(1).optional(),
  observables: z.string().trim().min(1).optional(),
  phrases: z.string().trim().min(1).optional(),
  cmenergies: z.string().trim()
    .regex(/^\d+(\.\d+)?,\d+(\.\d+)?$/, 'Format: "min,max" in GeV (e.g. "0.0,1.0")')
    .optional(),
  subject_areas: z.string().trim().min(1).optional(),
  sort_by: z.enum(['relevance', 'collaborations', 'title', 'date', 'latest']).optional(),
  page: optionalBudgetInt({ min: 1 }).default(1),
  size: optionalBudgetInt({ min: 1, max: 25 }).default(10),
  // Bounded auto-pagination. When max_results > size, the client loops over
  // pages (each a separate, rate-limited request) accumulating results until
  // max_results is reached or a short page signals no more data. Omitting it
  // preserves single-page behavior (effective default = size). HARD upper
  // bound 200: larger requests are clamped down to 200 (good citizen — no
  // unbounded crawl of HEPData).
  max_results: optionalBudgetInt({ min: 1 }),
}).refine(
  p =>
    p.inspire_recid != null || p.arxiv_id != null || p.doi != null || p.query != null ||
    p.reactions != null || p.collaboration != null || p.observables != null ||
    p.phrases != null || p.cmenergies != null || p.subject_areas != null,
  { message: 'At least one search condition must be provided' },
);

export const HepDataGetRecordSchema = z.object({
  hepdata_id: z.number().int().positive(),
});

export const HepDataGetTableSchema = z.object({
  table_id: z.number().int().positive(),
  // Text-renderable formats returned INLINE. json is parsed + normalized;
  // yaml and csv are returned as raw text. Heavy/binary formats (root, yoda,
  // …) are NOT here — use hepdata_download to write those to disk.
  format: z.enum(['json', 'yaml', 'csv']).default('json'),
});

// Heavy/archive download formats written to disk. `original` is the full
// submission zip (current behavior). json yields a single .json file; the
// six science formats (csv, root, yaml, yoda, yoda1, yoda.h5) are delivered
// by HEPData as a .tar.gz archive.
export const HEPDATA_DOWNLOAD_FORMATS = [
  'original',
  'json',
  'csv',
  'root',
  'yaml',
  'yoda',
  'yoda1',
  'yoda.h5',
] as const;

export const HepDataDownloadSchema = z.object({
  hepdata_id: z.number().int().positive(),
  format: z.enum(HEPDATA_DOWNLOAD_FORMATS).default('original'),
  _confirm: z.literal(true),
});
