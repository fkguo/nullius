import { z } from 'zod';
import { PaperIdentifiersSchema } from './identifiers.js';
import { AuthorSchema } from './author.js';

// ─────────────────────────────────────────────────────────────────────────────
// Publication Info Schema
// ─────────────────────────────────────────────────────────────────────────────

export const PublicationInfoSchema = z.object({
  journal: z.string().optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  year: z.number().optional(),
  publisher: z.string().optional(),
});

export type PublicationInfo = z.infer<typeof PublicationInfoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Document Link Schema
// ─────────────────────────────────────────────────────────────────────────────

export const DocumentLinkSchema = z.object({
  url: z.string().url(),
  source: z.string().optional(),
  contentType: z.string().optional(),
  openAccess: z.boolean().optional(),
});

export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Paper Summary Schema
// ─────────────────────────────────────────────────────────────────────────────

export const PaperSummarySchema = PaperIdentifiersSchema.extend({
  title: z.string(),
  authors: z.array(z.string()),
  /** Total author count on the record (may exceed `authors.length` when output is truncated for payload size) */
  author_count: z.number().int().optional(),
  /** Collaboration names (e.g. ATLAS) when available */
  collaborations: z.array(z.string()).optional(),
  year: z.number().optional(),
  earliest_date: z.string().optional(),
  citation_count: z.number().optional(),
  citation_count_without_self_citations: z.number().optional(),
  publication_summary: z.string().optional(),  // Formatted publication info, e.g., "Rev. Mod. Phys. 90 (2018) 015004 [arXiv:1705.00141]"
  inspire_url: z.string().url().optional(),
  arxiv_url: z.string().url().optional(),
  doi_url: z.string().url().optional(),
  // Phase 3 enhancements: document access links
  pdf_url: z.string().url().optional(),      // Direct PDF link (arXiv or publisher)
  source_url: z.string().url().optional(),   // arXiv LaTeX source download link
  // INSPIRE publication type (e.g., ['review'], ['lectures', 'review'])
  // Used for reliable review paper detection (tc r in INSPIRE search)
  publication_type: z.array(z.string()).optional(),
  // INSPIRE document type (e.g., ['article'], ['conference paper'])
  // Used for conference paper detection (tc c in INSPIRE search)
  document_type: z.array(z.string()).optional(),
  // BibTeX key (e.g., 'Maldacena:1997re')
  texkey: z.string().optional(),
  // arXiv primary category (e.g., 'hep-th', 'cond-mat.str-el', 'cs.LG')
  // First element of arxiv_eprints[0].categories
  arxiv_primary_category: z.string().optional(),
  // All arXiv categories (primary + cross-list)
  // e.g., ['hep-th', 'gr-qc', 'cond-mat.str-el']
  arxiv_categories: z.array(z.string()).optional(),
});

export type PaperSummary = z.infer<typeof PaperSummarySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Paper Schema (Full)
// ─────────────────────────────────────────────────────────────────────────────

export const PaperSchema = PaperSummarySchema.extend({
  abstract: z.string().optional(),
  author_details: z.array(AuthorSchema).optional(),
  publication: PublicationInfoSchema.optional(),
  keywords: z.array(z.string()).optional(),
  arxiv_categories: z.array(z.string()).optional(),
  documents: z.array(DocumentLinkSchema).optional(),
  paper_type: z.enum(['theory', 'experiment']).optional(),
});

export type Paper = z.infer<typeof PaperSchema>;
