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
  format: z.enum(['json', 'yaml']).default('json'),
});

export const HepDataDownloadSchema = z.object({
  hepdata_id: z.number().int().positive(),
  _confirm: z.literal(true),
});
