import { z } from 'zod';
import { AuthorIdentifiersSchema } from './identifiers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Author Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AuthorSchema = AuthorIdentifiersSchema.extend({
  full_name: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  affiliations: z.array(z.string()).optional(),
});

export type Author = z.infer<typeof AuthorSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Advisor Info Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AdvisorInfoSchema = z.object({
  name: z.string(),
  degree_type: z.enum(['PhD', 'Master', 'PostDoc']).optional(),
});

export type AdvisorInfo = z.infer<typeof AdvisorInfoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Author Profile Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AuthorProfileSchema = AuthorSchema.extend({
  current_position: z
    .object({
      institution: z.string(),
      rank: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  emails: z.array(z.string()).optional(),
  arxiv_categories: z.array(z.string()).optional(),
  status: z.enum(['active', 'departed', 'deceased']).optional(),
  advisors: z.array(AdvisorInfoSchema).optional(),
});

export type AuthorProfile = z.infer<typeof AuthorProfileSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Author Stats Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AuthorStatsSchema = z.object({
  paper_count: z.number(),
  total_citations: z.number(),
  h_index: z.number(),
  citations_without_self: z.number().optional(),
});

export type AuthorStats = z.infer<typeof AuthorStatsSchema>;
