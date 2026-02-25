import { z } from 'zod';

import { StyleIdSchema } from '../../corpora/style/schemas.js';

export const ClaimsTableInputSchema = z.object({
  recids: z.array(z.string().min(1)).min(1),
  topic: z.string().min(1),
  include_visual_assets: z.boolean().optional(),
  use_disk_storage: z.union([z.boolean(), z.literal('auto')]).optional(),
});

export const VerifyCitationsInputSchema = z.object({
  section_output: z
    .object({
      content: z.string().optional(),
      attributions: z.array(z.object({}).passthrough()).optional(),
    })
    .passthrough(),
  claims_table: z.object({}).passthrough(),
  allowed_citations: z.array(z.string()).optional(),
});

export const CheckOriginalityInputSchema = z.object({
  generated_text: z.string().min(1),
  source_evidences: z.array(
    z
      .object({
        quote: z.string().optional(),
        caption: z.string().optional(),
      })
      .passthrough()
  ),
  threshold: z.number().min(0).max(1).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Style corpus (RMP 起步, R5)
// ─────────────────────────────────────────────────────────────────────────────

const CorpusEvidenceTypeSchema = z.enum([
  'title',
  'abstract',
  'section',
  'paragraph',
  'sentence',
  'equation',
  'figure',
  'table',
  'citation_context',
]);

export const StyleCorpusInitProfileToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  overwrite: z.boolean().optional().default(false),
});

export const StyleCorpusBuildManifestToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  target_papers: z.number().int().positive().optional(),
  search_sort: z.enum(['mostrecent', 'mostcited']).optional(),
  page_size: z.number().int().positive().optional(),
  max_results_per_category: z.number().int().positive().optional(),
});

export const StyleCorpusDownloadToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  concurrency: z.number().int().positive().optional(),
  force: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
});

export const StyleCorpusBuildEvidenceToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  concurrency: z.number().int().positive().optional(),
  force: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
  include_inline_math: z.boolean().optional().default(false),
  max_paragraph_length: z.number().int().positive().optional(),
  map_citations_to_inspire: z.boolean().optional().default(true),
});

export const StyleCorpusBuildIndexToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  embedding_dim: z.number().int().positive().optional(),
  embedding_model: z.string().optional(),
});

export const StyleCorpusQueryToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  query: z.string().min(1),
  top_k: z.number().int().positive().max(150).optional().default(10),
  mode: z.enum(['off', 'lite', 'full']).optional().default('full'),
  retrieval: z
    .enum(['any', 'sentence', 'paragraph', 'figure', 'table', 'equation', 'citation_context', 'section', 'abstract', 'title'])
    .optional()
    .default('any'),
  types: z.array(CorpusEvidenceTypeSchema).min(1).optional(),
  filters: z
    .object({
      year_min: z.number().int().optional(),
      year_max: z.number().int().optional(),
      arxiv_category: z.string().min(1).optional(),
      only_latex: z.boolean().optional(),
    })
    .optional(),
});

export const StyleCorpusExportPackToolSchema = z.object({
  style_id: StyleIdSchema.optional().default('rmp'),
  include_sources: z.boolean().optional().default(true),
  include_pdf: z.boolean().optional().default(true),
  include_evidence: z.boolean().optional().default(true),
  include_index: z.boolean().optional().default(true),
  include_artifacts: z.boolean().optional().default(false),
  compression_level: z.number().int().min(0).max(9).optional().default(6),
  _confirm: z.boolean().optional(),
});

export const StyleCorpusImportPackToolSchema = z.object({
  pack_path: z.string().min(1),
  overwrite: z.boolean().optional().default(false),
});
