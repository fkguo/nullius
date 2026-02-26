import { z } from 'zod';

export const DraftVersionSchema = z.literal(1);

export const SentenceTypeSchema = z.enum([
  'fact',
  'definition',
  'comparison',
  'interpretation',
  'transition',
  'limitation',
  'future_work',
]);

const RecidTokenSchema = z
  .string()
  .min(1)
  .refine(v => /^(?:inspire:)?\d+$/.test(v.trim()), {
    message: 'recids[] entries must be digits or inspire:<digits>',
  });

export const SentenceDraftSchema = z.object({
  sentence: z.string().min(1),
  sentence_latex: z.string().min(1).optional(),
  type: SentenceTypeSchema.optional().default('fact'),
  is_grounded: z.boolean().optional().default(true),
  claim_ids: z.array(z.string().min(1)).optional().default([]),
  evidence_ids: z.array(z.string().min(1)).optional().default([]),
  recids: z.array(RecidTokenSchema).optional().default([]),
});

export const ParagraphDraftSchema = z.object({
  sentences: z.array(SentenceDraftSchema).min(1),
});

export const SectionDraftSchema = z.object({
  version: DraftVersionSchema.optional().default(1),
  title: z.string().optional(),
  paragraphs: z.array(ParagraphDraftSchema).min(1),
});

export const ReportDraftSchema = z.object({
  version: DraftVersionSchema.optional().default(1),
  title: z.string().optional(),
  sections: z.array(SectionDraftSchema).min(1),
});

export type SentenceDraft = z.output<typeof SentenceDraftSchema>;
export type ParagraphDraft = z.output<typeof ParagraphDraftSchema>;
export type SectionDraft = z.output<typeof SectionDraftSchema>;
export type ReportDraft = z.output<typeof ReportDraftSchema>;

