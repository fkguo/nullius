import { z } from 'zod';

const SafePathSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(s => !s.includes('/') && !s.includes('\\'), {
    message: 'must not include path separators',
  })
  .refine(s => s !== '.' && s !== '..' && !s.includes('..'), {
    message: 'contains unsafe segment',
  });

export const StyleIdSchema = SafePathSegmentSchema;

export const YearBinSchema = z.object({
  id: z.string().min(1).max(50),
  start_year: z.number().int().optional(),
  end_year: z.number().int().optional(),
});

export const StyleProfileSchema = z
  .object({
    version: z.literal(1),
    style_id: StyleIdSchema,
    title: z.string().min(1),
    description: z.string().optional(),

    /** Base INSPIRE query that defines the eligible pool (e.g., journal filter) */
    inspire_query: z.string().min(1),

    selection: z.object({
      strategy: z.enum(['stratified_v1']),
      target_categories: z.array(z.string().min(1)).min(1),
      year_bins: z.array(YearBinSchema).min(1),
      sort_within_stratum: z.enum(['mostcited', 'mostrecent', 'recid']).default('mostcited'),
    }),

    defaults: z.object({
      target_papers: z.number().int().positive().default(200),
    }),

    created_at: z.string().datetime().optional(),
    updated_at: z.string().datetime().optional(),
  })
  .strict();

export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export const ManifestStatusSchema = z.enum(['planned', 'downloaded', 'evidence_built', 'indexed', 'error']);

export const StyleCorpusManifestEntrySchema = z
  .object({
    version: z.literal(1),
    style_id: StyleIdSchema,
    recid: z.string().min(1),

    title: z.string().min(1),
    year: z.number().int().optional(),
    arxiv_id: z.string().optional(),
    doi: z.string().optional(),
    texkey: z.string().optional(),
    arxiv_primary_category: z.string().optional(),
    arxiv_categories: z.array(z.string()).optional(),
    citation_count: z.number().int().optional(),

    selection: z
      .object({
        strategy: z.enum(['stratified_v1']),
        category: z.string().optional(),
        year_bin: z.string().optional(),
        rank_in_stratum: z.number().int().nonnegative().optional(),
        order_key: z.string().optional(),
      })
      .optional(),

    status: ManifestStatusSchema,
    error: z.string().optional(),

    source: z
      .object({
        source_type: z.enum(['latex', 'pdf', 'none']).default('none'),
        /** Relative paths within the corpus directory */
        source_dir: z.string().optional(),
        source_archive: z.string().optional(),
        main_tex: z.string().optional(),
        pdf_path: z.string().optional(),
        sha256: z.string().optional(),
        size_bytes: z.number().int().nonnegative().optional(),
        provenance_url: z.string().url().optional(),
        updated_at: z.string().datetime().optional(),
      })
      .optional(),

    assets: z
      .object({
        evidence_items: z.number().int().nonnegative().optional(),
        by_type: z.record(z.string(), z.number().int().nonnegative()).optional(),
        figures_copied: z.number().int().nonnegative().optional(),
        figures_converted: z.number().int().nonnegative().optional(),
        tikz_rendered: z.number().int().nonnegative().optional(),
        equations: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

export type StyleCorpusManifestEntry = z.infer<typeof StyleCorpusManifestEntrySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Corpus pack (R6)
// ─────────────────────────────────────────────────────────────────────────────

const SafeRelZipPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(p => !p.includes('\\') && !p.includes('\0'), {
    message: 'path contains invalid characters',
  })
  .refine(p => !p.startsWith('/'), {
    message: 'path must be relative',
  })
  .refine(p => !p.startsWith('../') && !p.includes('/../') && !p.endsWith('/..'), {
    message: 'path contains traversal segments',
  });

export const StyleCorpusPackManifestV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('style_corpus_pack'),
    style_id: StyleIdSchema,
    exported_at: z.string().datetime(),
    includes: z.object({
      sources: z.boolean(),
      pdf: z.boolean(),
      evidence: z.boolean(),
      index: z.boolean(),
      artifacts: z.boolean(),
    }),
    files: z
      .array(z.object({
        path: SafeRelZipPathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size_bytes: z.number().int().nonnegative(),
        mimeType: z.string().optional(),
      }))
      .min(1),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export type StyleCorpusPackManifestV1 = z.infer<typeof StyleCorpusPackManifestV1Schema>;
