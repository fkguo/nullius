import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Identifier Type Schema
// ─────────────────────────────────────────────────────────────────────────────

export const IdentifierTypeSchema = z.enum([
  'recid',
  'arxiv',
  'doi',
  'zotero_key',
  'texkey',
  'unknown',
]);

export type IdentifierType = z.infer<typeof IdentifierTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Paper Identifiers Schema
// ─────────────────────────────────────────────────────────────────────────────

export const PaperIdentifiersSchema = z.object({
  recid: z.string().optional(),
  arxiv_id: z.string().optional(),
  doi: z.string().optional(),
  zotero_key: z.string().optional(),
  texkey: z.string().optional(),
});

export type PaperIdentifiers = z.infer<typeof PaperIdentifiersSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Author Identifiers Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AuthorIdentifiersSchema = z.object({
  bai: z.string().optional(),
  recid: z.string().optional(),
  orcid: z.string().optional(),
});

export type AuthorIdentifiers = z.infer<typeof AuthorIdentifiersSchema>;
