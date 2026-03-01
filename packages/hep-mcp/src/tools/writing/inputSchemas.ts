import { z } from 'zod';

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
