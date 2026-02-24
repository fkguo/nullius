import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Journal Style Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported journal writing styles
 * - rmp: Rev. Mod. Phys. - Comprehensive review, pedagogical, educational
 * - prl: Phys. Rev. Lett. - Brief, 4-page limit, impactful discoveries
 * - nature: Nature - Cross-disciplinary, narrative-driven, broad audience
 * - nature-physics: Nature Physics - Physics-focused, narrative style
 * - prd: Phys. Rev. D - Technical, detailed derivations, rigorous
 */
export const JournalStyleSchema = z.enum([
  'rmp',           // Rev. Mod. Phys.
  'prl',           // Phys. Rev. Lett.
  'nature',        // Nature
  'nature-physics', // Nature Physics
  'prd',           // Phys. Rev. D
]);

export type JournalStyle = z.infer<typeof JournalStyleSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Evidence Locator Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Precise location of evidence within a paper
 */
export const EvidenceLocatorSchema = z.object({
  /** Section name or number */
  section: z.string(),
  /** Paragraph index within section (0-based) */
  paragraph: z.number().int().min(0),
  /** PDF page number (if available) */
  pdf_page: z.number().int().min(1).optional(),
  /** Bounding box in PDF [x1, y1, x2, y2] (if available) */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Line number in LaTeX source (if available) */
  latex_line: z.number().int().min(1).optional(),
});

export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

/**
 * A snippet of evidence supporting a claim
 */
export const EvidenceSnippetSchema = z.object({
  /** Paper identifier (recid or arXiv ID) */
  paper_id: z.string(),
  /** Precise location within the paper */
  locator: EvidenceLocatorSchema,
  /** Quoted text from the paper */
  quote: z.string(),
  /** Confidence score (0-1) for automatic extraction */
  confidence: z.number().min(0).max(1),
  /** Type of evidence */
  evidence_type: z.enum([
    'direct_statement',    // Explicit claim in text
    'numerical_result',    // Measurement or calculation
    'figure_caption',      // Evidence from figure
    'table_entry',         // Evidence from table
    'equation_derivation', // Mathematical derivation
  ]).optional(),
});

export type EvidenceSnippet = z.infer<typeof EvidenceSnippetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Claim Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stance of a claim relative to a topic
 */
export const ClaimStanceSchema = z.enum([
  'supports',     // Confirms the main hypothesis
  'contradicts',  // Refutes the main hypothesis
  'neutral',      // Neither supports nor contradicts
  'conditional',  // Support depends on conditions
]);

export type ClaimStance = z.infer<typeof ClaimStanceSchema>;

/**
 * Evidence grade for a claim
 */
export const EvidenceGradeSchema = z.enum([
  'discovery',    // 5σ+ observation, independently verified
  'evidence',     // 3-5σ, multiple consistent measurements
  'hint',         // 2-3σ, emerging signal
  'indirect',     // Theoretical inference or limit
  'theoretical',  // Pure calculation, no experimental support yet
]);

export type EvidenceGrade = z.infer<typeof EvidenceGradeSchema>;

/**
 * A single claim with supporting evidence
 */
export const ClaimSchema = z.object({
  /** Unique identifier for this claim */
  claim_id: z.string(),
  /** Text of the claim */
  claim_text: z.string(),
  /** Supporting evidence snippets with locators */
  supporting_snippets: z.array(EvidenceSnippetSchema),
  /** Assumptions underlying this claim */
  assumptions: z.array(z.string()).optional(),
  /** Scope/applicability of the claim */
  scope: z.string().optional(),
  /** Stance relative to main topic */
  stance: ClaimStanceSchema.optional(),
  /** Evidence quality grade */
  evidence_grade: EvidenceGradeSchema.optional(),
  /** Related claim IDs (for grouping) */
  related_claims: z.array(z.string()).optional(),
  /** Tags for categorization */
  tags: z.array(z.string()).optional(),
});

export type Claim = z.infer<typeof ClaimSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Corpus Snapshot Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A paper entry in the corpus snapshot
 */
export const CorpusPaperSchema = z.object({
  /** INSPIRE record ID */
  recid: z.string(),
  /** arXiv ID (if available) */
  arxiv_id: z.string().optional(),
  /** Paper title */
  title: z.string(),
  /** Authors */
  authors: z.array(z.string()),
  /** Publication year */
  year: z.number().int().optional(),
  /** Citation count at snapshot time */
  citation_count: z.number().int().optional(),
  /** DOI (if available) */
  doi: z.string().optional(),
  /** Journal reference */
  journal_ref: z.string().optional(),
});

export type CorpusPaper = z.infer<typeof CorpusPaperSchema>;

/**
 * Snapshot of the literature corpus at a point in time
 */
export const CorpusSnapshotSchema = z.object({
  /** INSPIRE query used to build corpus */
  query: z.string(),
  /** Timestamp of snapshot (ISO 8601) */
  timestamp: z.string(),
  /** Papers in the corpus */
  paper_list: z.array(CorpusPaperSchema),
  /** Version identifier */
  version: z.string(),
  /** Total papers found (may exceed paper_list if truncated) */
  total_found: z.number().int().optional(),
  /** Search filters applied */
  filters: z.record(z.string(), z.string()).optional(),
});

export type CorpusSnapshot = z.infer<typeof CorpusSnapshotSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Disagreement Graph Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node in the disagreement graph (represents a claim or measurement)
 */
export const DisagreementNodeSchema = z.object({
  /** Node identifier */
  id: z.string(),
  /** Type of node */
  type: z.enum(['claim', 'measurement', 'prediction']),
  /** Description or value */
  label: z.string(),
  /** Associated paper IDs */
  paper_ids: z.array(z.string()),
  /** Numerical value (for measurements) */
  value: z.number().optional(),
  /** Uncertainty (for measurements) */
  uncertainty: z.number().optional(),
  /** Unit (for measurements) */
  unit: z.string().optional(),
});

export type DisagreementNode = z.infer<typeof DisagreementNodeSchema>;

/**
 * An edge in the disagreement graph (represents tension/conflict)
 */
export const DisagreementEdgeSchema = z.object({
  /** Source node ID */
  source: z.string(),
  /** Target node ID */
  target: z.string(),
  /** Type of relationship */
  relation: z.enum([
    'tension',       // Numerical disagreement
    'contradiction', // Logical contradiction
    'refinement',    // One supersedes the other
    'complement',    // Different aspects of same phenomenon
  ]),
  /** Tension in sigma (for numerical disagreement) */
  tension_sigma: z.number().optional(),
  /** Description of the disagreement */
  description: z.string().optional(),
});

export type DisagreementEdge = z.infer<typeof DisagreementEdgeSchema>;

/**
 * Graph of disagreements and tensions between claims/measurements
 */
export const DisagreementGraphSchema = z.object({
  /** Nodes (claims/measurements) */
  nodes: z.array(DisagreementNodeSchema),
  /** Edges (tensions/conflicts) */
  edges: z.array(DisagreementEdgeSchema),
});

export type DisagreementGraph = z.infer<typeof DisagreementGraphSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Claims Table Schema (SSOT)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claims Table - Single Source of Truth for academic writing
 *
 * This is the core data structure that bridges research tools and writing tools.
 * All claims must be traceable to specific locations in source papers.
 */
export const ClaimsTableSchema = z.object({
  /** Unique identifier for this claims table */
  id: z.string(),
  /** Research topic or question */
  topic: z.string(),
  /** Corpus snapshot (literature used) */
  corpus_snapshot: CorpusSnapshotSchema,
  /** Claims with evidence */
  claims: z.array(ClaimSchema),
  /** Disagreement/tension graph */
  disagreement_graph: DisagreementGraphSchema.optional(),
  /** Creation timestamp (ISO 8601) */
  created_at: z.string(),
  /** Last update timestamp (ISO 8601) */
  updated_at: z.string(),
  /** Metadata */
  metadata: z.object({
    /** Total papers analyzed */
    papers_analyzed: z.number().int(),
    /** Total claims extracted */
    claims_count: z.number().int(),
    /** Coverage score (0-1) */
    coverage_score: z.number().min(0).max(1).optional(),
    /** Target journal style (if specified) */
    target_style: JournalStyleSchema.optional(),
  }).optional(),
});

export type ClaimsTable = z.infer<typeof ClaimsTableSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Writing Outline Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base outline section schema (without subsections for type safety)
 */
const OutlineSectionBaseSchema = z.object({
  /** Section number (e.g., "1", "2.1", "2.1.3") */
  number: z.string(),
  /** Section title */
  title: z.string(),
  /** Brief description of content */
  description: z.string().optional(),
  /** Estimated word count */
  word_count_target: z.number().int().optional(),
  /** Claim IDs to cover in this section */
  claim_ids: z.array(z.string()).optional(),
});

/**
 * A section in a writing outline (recursive type)
 */
export interface OutlineSection extends z.infer<typeof OutlineSectionBaseSchema> {
  /** Subsections */
  subsections?: OutlineSection[];
}

/**
 * Full outline section schema with recursive subsections
 */
export const OutlineSectionSchema: z.ZodType<OutlineSection> = OutlineSectionBaseSchema.extend({
  subsections: z.lazy(() => z.array(OutlineSectionSchema)).optional(),
});

/**
 * Writing outline for a paper
 */
export const WritingOutlineSchema = z.object({
  /** Paper title */
  title: z.string(),
  /** Target journal style */
  style: JournalStyleSchema,
  /** Abstract summary */
  abstract_notes: z.string().optional(),
  /** Sections */
  sections: z.array(OutlineSectionSchema),
  /** Total target word count */
  total_word_count: z.number().int().optional(),
  /** Associated claims table ID */
  claims_table_id: z.string().optional(),
});

export type WritingOutline = z.infer<typeof WritingOutlineSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Style Rules Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentence pattern template
 */
export const SentencePatternSchema = z.object({
  /** Category of pattern */
  category: z.enum([
    'topic_introduction',
    'comparison',
    'limitation',
    'outlook',
    'transition',
    'summary',
    'definition',
    'example',
  ]),
  /** Pattern template with placeholders */
  template: z.string(),
  /** Example usage */
  example: z.string().optional(),
  /** Notes on when to use */
  usage_notes: z.string().optional(),
});

export type SentencePattern = z.infer<typeof SentencePatternSchema>;

/**
 * Writing style rules for a journal
 */
export const JournalStyleRulesSchema = z.object({
  /** Journal style identifier */
  style: JournalStyleSchema,
  /** Display name */
  display_name: z.string(),
  /** Brief description */
  description: z.string(),
  /** Required sections */
  required_sections: z.array(z.object({
    name: z.string(),
    max_words: z.number().int().optional(),
    min_words: z.number().int().optional(),
    required: z.boolean().default(true),
    aliases: z.array(z.string()).optional(),
  })),
  /** Recommended elements */
  recommended_elements: z.array(z.string()),
  /** Phrases to avoid */
  avoid_phrases: z.array(z.string()),
  /** Preferred phrases */
  prefer_phrases: z.array(z.string()),
  /** Sentence patterns */
  sentence_patterns: z.array(SentencePatternSchema),
  /** Structural constraints */
  constraints: z.object({
    max_pages: z.number().int().optional(),
    max_words: z.number().int().optional(),
    max_figures: z.number().int().optional(),
    max_references: z.number().int().optional(),
    abstract_max_words: z.number().int().optional(),
  }).optional(),
});

export type JournalStyleRules = z.infer<typeof JournalStyleRulesSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Quality Check Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a quality check
 */
export const QualityCheckResultSchema = z.object({
  /** Check name */
  check: z.string(),
  /** Pass/fail status */
  passed: z.boolean(),
  /** Severity if failed */
  severity: z.enum(['error', 'warning', 'info']).optional(),
  /** Message describing the result */
  message: z.string(),
  /** Suggestions for improvement */
  suggestions: z.array(z.string()).optional(),
  /** Location in document (if applicable) */
  location: z.object({
    section: z.string().optional(),
    paragraph: z.number().int().optional(),
    line: z.number().int().optional(),
  }).optional(),
});

export type QualityCheckResult = z.infer<typeof QualityCheckResultSchema>;

/**
 * Overall quality assessment
 */
export const QualityAssessmentSchema = z.object({
  /** Overall score (0-100) */
  score: z.number().min(0).max(100),
  /** Individual check results */
  checks: z.array(QualityCheckResultSchema),
  /** Summary statistics */
  summary: z.object({
    total_checks: z.number().int(),
    passed: z.number().int(),
    warnings: z.number().int(),
    errors: z.number().int(),
  }),
  /** Ready for submission */
  ready_for_submission: z.boolean(),
});

export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;
