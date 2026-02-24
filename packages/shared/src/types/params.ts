import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Basic Search Params
// ─────────────────────────────────────────────────────────────────────────────

export const InspireSearchParamsSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  sort: z.enum(['mostrecent', 'mostcited']).optional(),
  size: z.number().int().min(1).max(1000).optional().default(10),
  page: z.number().int().min(1).optional().default(1),
  fields: z.string().optional(),
});

export type InspireSearchParams = z.infer<typeof InspireSearchParamsSchema>;

export const LookupByIdParamsSchema = z.object({
  identifier: z.string().min(1),
});

export type LookupByIdParams = z.infer<typeof LookupByIdParamsSchema>;

export const SearchAuthorParamsSchema = z.object({
  author: z.string().min(1),
  exact: z.boolean().optional().default(false),
  sort: z.enum(['mostrecent', 'mostcited']).optional(),
  size: z.number().int().min(1).max(1000).optional().default(25),
});

export type SearchAuthorParams = z.infer<typeof SearchAuthorParamsSchema>;

export const SearchTitleParamsSchema = z.object({
  title_query: z.string().min(1),
  size: z.number().int().min(1).max(1000).optional().default(25),
});

export type SearchTitleParams = z.infer<typeof SearchTitleParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// BibTeX Params
// ─────────────────────────────────────────────────────────────────────────────

export const GetBibtexParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
});

export type GetBibtexParams = z.infer<typeof GetBibtexParamsSchema>;
