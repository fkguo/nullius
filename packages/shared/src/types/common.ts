import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const PaginationParamsSchema = z.object({
  page: z.number().int().min(1).optional().default(1),
  size: z.number().int().min(1).max(1000).optional().default(25),
  sort: z.enum(['mostrecent', 'mostcited']).optional(),
});

export type PaginationParams = z.infer<typeof PaginationParamsSchema>;

export const PaginatedResultSchema = <T extends z.ZodType<any, any>>(itemSchema: T) =>
  z.object({
    total: z.number(),
    items: z.array(itemSchema),
    has_more: z.boolean(),
    next_url: z.string().optional(),
  });

export interface PaginatedResult<T> {
  total: number;
  items: T[];
  has_more: boolean;
  next_url?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Format Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const OutputFormatSchema = z.enum([
  'json',
  'json-expanded',
  'bibtex',
  'latex-eu',
  'latex-us',
  'cv',
  'markdown',
  'text',
]);

export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const FormatOptionsSchema = z.object({
  format: OutputFormatSchema.optional(),
  include_abstract: z.boolean().optional(),
  max_authors: z.number().int().optional(),
  language: z.enum(['en', 'zh']).optional(),
});

export type FormatOptions = z.infer<typeof FormatOptionsSchema>;
