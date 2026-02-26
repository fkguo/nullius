import { z } from 'zod';

export const SectionOutputSubmissionSchema = z
  .object({
    section_number: z.string().min(1).optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    attributions: z.array(z.object({}).passthrough()).optional(),
    figures_used: z.array(z.object({}).passthrough()).optional(),
    equations_used: z.array(z.object({}).passthrough()).optional(),
    tables_used: z.array(z.object({}).passthrough()).optional(),
  })
  .passthrough();

export type SectionOutputSubmission = z.output<typeof SectionOutputSubmissionSchema>;

