import { z } from 'zod';
import { ReportDraftSchema, SectionDraftSchema } from '../../core/writing/draftSchemas.js';

const SortSchema = z.enum(['mostrecent', 'mostcited']);

export const SafePathSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(s => !s.includes('/') && !s.includes('\\'), {
    message: 'must not include path separators',
  })
  .refine(s => s !== '.' && s !== '..' && !s.includes('..'), {
    message: 'contains unsafe segment',
  });

export const HepProjectCreateToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const HepProjectGetToolSchema = z.object({
  project_id: SafePathSegmentSchema,
});

export const HepProjectListToolSchema = z.object({});

export const HepHealthToolSchema = z.object({
  check_inspire: z.boolean().optional().default(false),
  inspire_timeout_ms: z.number().int().positive().optional().default(5000),
});

export const HepRunCreateToolSchema = z.object({
  project_id: SafePathSegmentSchema,
  args_snapshot: z.unknown().optional(),
});

export const HepRunReadArtifactChunkToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  artifact_name: SafePathSegmentSchema,
  offset: z.number().int().nonnegative().optional().default(0),
  length: z.number().int().positive().optional().default(4096),
});

export const HepRunClearManifestLockToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  force: z.boolean().optional().default(false),
});

export const HepRunStageContentToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  content_type: z.enum(['section_output', 'outline_plan', 'paperset_curation', 'revision_plan', 'reviewer_report', 'judge_decision']).default('section_output'),
  content: z.string().min(1),
  artifact_suffix: SafePathSegmentSchema.optional(),
});

export const HepRunBuildCitationMappingToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  identifier: z.string().min(1),
  allowed_citations_primary: z.array(z.string().min(1)).optional().default([]),
  include_mapped_references: z.boolean().optional().default(true),
});

const CitekeyMappingSchema = z
  .object({
    status: z.enum(['matched', 'not_found', 'error']),
    recid: z.string().optional(),
  })
  .passthrough();

const CitekeyToInspireMappingsSchema = z.record(z.string().min(1), CitekeyMappingSchema);

const CitekeyToInspireArtifactInputSchema = z
  .object({
    version: z.literal(1).optional(),
    generated_at: z.string().optional(),
    mappings: CitekeyToInspireMappingsSchema,
  })
  .passthrough();

const CiteMappingInputSchema = z.union([CitekeyToInspireMappingsSchema, CitekeyToInspireArtifactInputSchema]);

export const HepRenderLatexToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  draft: z.union([SectionDraftSchema, ReportDraftSchema]),
  cite_mapping: CiteMappingInputSchema.optional(),
  latex_artifact_name: SafePathSegmentSchema.optional().default('rendered_latex.tex'),
  section_output_artifact_name: SafePathSegmentSchema.optional().default('rendered_section_output.json'),
});

export const HepExportProjectToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  rendered_latex_artifact_name: SafePathSegmentSchema.optional().default('rendered_latex.tex'),
  rendered_latex_verification_artifact_name: SafePathSegmentSchema.optional().default('rendered_latex_verification.json'),
  bibliography_raw_artifact_name: SafePathSegmentSchema.optional().default('bibliography_raw_v1.json'),
  master_bib_artifact_name: SafePathSegmentSchema.optional().default('master.bib'),
  report_tex_artifact_name: SafePathSegmentSchema.optional().default('report.tex'),
  report_md_artifact_name: SafePathSegmentSchema.optional().default('report.md'),
  research_pack_zip_artifact_name: SafePathSegmentSchema.optional().default('research_pack.zip'),
  notebooklm_pack_prefix: SafePathSegmentSchema.optional().default('notebooklm_pack'),
  max_chars_per_notebooklm_file: z.number().int().positive().optional().default(80_000),
  include_evidence_digests: z.boolean().optional().default(true),
  include_pdg_artifacts: z.boolean().optional().default(false),
  include_paper_bundle: z.boolean().optional().default(false),
  paper_bundle_zip_artifact_name: SafePathSegmentSchema.optional().default('paper_bundle.zip'),
  paper_bundle_manifest_artifact_name: SafePathSegmentSchema.optional().default('paper_bundle_manifest.json'),
  _confirm: z.boolean().optional(),
});

export const HepExportPaperScaffoldToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  output_dir_name: SafePathSegmentSchema.optional().default('paper'),
  overwrite: z.boolean().optional().default(false),
  integrated_latex_artifact_name: SafePathSegmentSchema.optional().default('writing_integrated.tex'),
  writing_master_bib_artifact_name: SafePathSegmentSchema.optional().default('writing_master.bib'),
  bibliography_raw_artifact_name: SafePathSegmentSchema.optional().default('bibliography_raw_v1.json'),
  zip_artifact_name: SafePathSegmentSchema.optional().default('paper_scaffold.zip'),
  paper_manifest_artifact_name: SafePathSegmentSchema.optional().default('paper_manifest.json'),
  version: z.number().int().min(1).optional(),
  _confirm: z.boolean().optional(),
});

export const HepImportPaperBundleToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  paper_dir_name: SafePathSegmentSchema.optional().default('paper'),
  version: z.number().int().min(1).optional(),
  zip_artifact_name: SafePathSegmentSchema.optional().default('paper_bundle.zip'),
  bundle_manifest_artifact_name: SafePathSegmentSchema.optional().default('paper_bundle_manifest.json'),
  pdf_artifact_name: SafePathSegmentSchema.optional().default('paper_final.pdf'),
  overwrite: z.boolean().optional().default(false),
  dereference_symlinks: z.boolean().optional().default(false),
  allow_external_symlink_targets: z.boolean().optional().default(false),
});

export const HepImportFromZoteroToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  collection_key: SafePathSegmentSchema.optional(),
  item_keys: z.array(SafePathSegmentSchema).optional().default([]),
  limit: z.number().int().positive().optional(),
  start: z.number().int().nonnegative().optional(),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .default(4)
    .transform(v => Math.min(Math.max(v, 1), 16)),
}).refine(v => Boolean(v.collection_key) || v.item_keys.length > 0, {
  message: 'Either collection_key or item_keys is required',
});

const PdfExtractModeSchema = z.enum(['text', 'visual', 'visual+ocr']);
const PdfEvidenceTypeSchema = z.enum(['pdf_page', 'pdf_region']);

export const HepRunBuildPdfEvidenceToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  pdf_path: z.string().min(1).optional(),
  pdf_artifact_name: SafePathSegmentSchema.optional(),
  zotero_attachment_key: SafePathSegmentSchema.optional(),
  fulltext_artifact_name: SafePathSegmentSchema.optional(),
  docling_json_path: z.string().min(1).optional(),
  docling_json_artifact_name: SafePathSegmentSchema.optional(),
  mode: PdfExtractModeSchema.optional().default('text'),
  max_pages: z.number().int().positive().optional().default(80),
  render_dpi: z.number().int().positive().optional().default(144),
  output_prefix: SafePathSegmentSchema.optional().default('pdf'),
  max_regions_total: z.number().int().nonnegative().optional().default(25),
}).refine(v => Boolean(v.pdf_path) || Boolean(v.pdf_artifact_name) || Boolean(v.zotero_attachment_key), {
  message: 'Either pdf_path, pdf_artifact_name, or zotero_attachment_key is required',
});

export const HepRunIngestSkillArtifactsToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  skill_artifacts_dir: z.string().min(1).describe('Absolute path to skill artifacts directory (must be within run_dir)'),
  manifest_path: z.string().optional().describe('Optional path to computation_manifest_v1.json (within run_dir)'),
  step_id: z.string().min(1).optional().describe('Optional manifest step_id for traceability (generated UUID if omitted)'),
  tags: z.array(z.string()).max(20).optional().describe('Classification tags (e.g. feyncalc, one-loop)'),
});

export const HepRunCreateFromIdeaToolSchema = z.object({
  handoff_uri: z.string().min(1).describe('hep:// URI or file path pointing to an IdeaHandoffC2 artifact'),
  project_id: SafePathSegmentSchema.optional().describe('Existing project ID; auto-created from thesis if omitted'),
  run_label: z.string().optional().describe('Optional label for the new run'),
});

export const SearchExportFormatSchema = z.enum(['jsonl', 'json']);

export const HepInspireSearchExportToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  query: z.string().min(1),
  sort: SortSchema.optional(),
  size: z
    .number()
    .int()
    .optional()
    .default(1000)
    .transform(v => Math.min(Math.max(v, 1), 1000)),
  max_results: z
    .number()
    .int()
    .optional()
    .default(10_000)
    .transform(v => Math.min(Math.max(v, 1), 10_000)),
  output_format: SearchExportFormatSchema.optional().default('jsonl'),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
});

export const HepInspireResolveIdentifiersToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  identifiers: z.array(z.string().min(1)).min(1),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
});

const EvidenceTypeSchema = z.enum([
  'title',
  'abstract',
  'section',
  'paragraph',
  'equation',
  'figure',
  'table',
  'theorem',
  'citation_context',
]);

export const HepRunBuildMeasurementsToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  latex_catalog_artifact_name: SafePathSegmentSchema.optional().default('latex_evidence_catalog.jsonl'),
  include_types: z
    .array(EvidenceTypeSchema)
    .optional()
    .default(['paragraph', 'equation', 'figure', 'table', 'citation_context']),
  target_quantities: z.array(z.string().min(1)).optional(),
  max_results: z
    .number()
    .int()
    .optional()
    .default(500)
    .transform(v => Math.min(Math.max(v, 1), 50_000)),
  measurements_artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
});

const HepProjectCompareMeasurementsInputRunSchema = z.object({
  run_id: SafePathSegmentSchema,
  measurements_artifact_name: SafePathSegmentSchema.optional(),
  label: z.string().min(1).optional(),
});

export const HepProjectCompareMeasurementsToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  input_runs: z.array(HepProjectCompareMeasurementsInputRunSchema).min(2),
  min_tension_sigma: z.number().positive().optional().default(2),
  max_flags: z
    .number()
    .int()
    .optional()
    .default(500)
    .transform(v => Math.min(Math.max(v, 1), 5_000)),
  include_not_comparable: z.boolean().optional().default(false),
  output_artifact_name: SafePathSegmentSchema.optional(),
});

const WritingLatexSourceSchema = z
  .object({
    identifier: z.string().min(1).optional(),
    main_tex_path: z.string().min(1).optional(),
    paper_id: SafePathSegmentSchema.optional(),
    include_inline_math: z.boolean().optional(),
    include_cross_refs: z.boolean().optional(),
    max_paragraph_length: z.number().int().optional(),
  })
  .refine(v => Boolean(v.identifier) || Boolean(v.main_tex_path), {
    message: 'Either identifier or main_tex_path is required',
  });

const WritingPdfSourceSchema = z
  .object({
    pdf_path: z.string().min(1).optional(),
    pdf_artifact_name: SafePathSegmentSchema.optional(),
    zotero_attachment_key: SafePathSegmentSchema.optional(),
    fulltext_artifact_name: SafePathSegmentSchema.optional(),
    docling_json_path: z.string().min(1).optional(),
    docling_json_artifact_name: SafePathSegmentSchema.optional(),
    mode: PdfExtractModeSchema.optional(),
    max_pages: z.number().int().positive().optional(),
    render_dpi: z.number().int().positive().optional(),
    output_prefix: SafePathSegmentSchema.optional(),
    max_regions_total: z.number().int().nonnegative().optional(),
  })
  .refine(v => Boolean(v.pdf_path) || Boolean(v.pdf_artifact_name) || Boolean(v.zotero_attachment_key), {
    message: 'Either pdf_path, pdf_artifact_name, or zotero_attachment_key is required',
  });

export const HepRunBuildWritingEvidenceToolSchema = z
  .object({
    run_id: SafePathSegmentSchema,
    latex_sources: z.array(WritingLatexSourceSchema).optional().default([]),
    pdf_source: WritingPdfSourceSchema.optional(),
    continue_on_error: z.boolean().optional().default(false),
    latex_types: z
      .array(EvidenceTypeSchema)
      .optional()
      .default(['paragraph', 'equation', 'figure', 'table', 'citation_context']),
    pdf_types: z.array(PdfEvidenceTypeSchema).optional().default(['pdf_page', 'pdf_region']),
    max_evidence_items: z
      .number()
      .int()
      .optional()
      .default(2000)
      .transform(v => Math.min(Math.max(v, 1), 20000)),
    embedding_dim: z
      .number()
      .int()
      .optional()
      .default(256)
      .transform(v => Math.min(Math.max(v, 32), 1024)),
    latex_catalog_artifact_name: SafePathSegmentSchema.optional().default('latex_evidence_catalog.jsonl'),
    latex_embeddings_artifact_name: SafePathSegmentSchema.optional().default('latex_evidence_embeddings.jsonl'),
    latex_enrichment_artifact_name: SafePathSegmentSchema.optional().default('latex_evidence_enrichment.jsonl'),
    pdf_embeddings_artifact_name: SafePathSegmentSchema.optional().default('pdf_evidence_embeddings.jsonl'),
    pdf_enrichment_artifact_name: SafePathSegmentSchema.optional().default('pdf_evidence_enrichment.jsonl'),
  })
  .refine(v => v.latex_sources.length > 0 || Boolean(v.pdf_source), {
    message: 'At least one latex_sources entry or pdf_source is required',
  });

export const HepProjectBuildEvidenceToolSchema = z
  .object({
    project_id: SafePathSegmentSchema,
    paper_id: SafePathSegmentSchema.optional(),
    identifier: z.string().min(1).optional(),
    main_tex_path: z.string().min(1).optional(),
    include_inline_math: z.boolean().optional().default(false),
    include_cross_refs: z.boolean().optional().default(false),
    max_paragraph_length: z.number().int().optional().default(0),
  })
  .refine(p => Boolean(p.identifier) || Boolean(p.main_tex_path), {
    message: 'Either identifier or main_tex_path is required',
  });

export const HepProjectQueryEvidenceToolSchema = z
  .object({
    project_id: SafePathSegmentSchema,
    paper_id: SafePathSegmentSchema.optional(),
    query: z.string().min(1),
    types: z.array(EvidenceTypeSchema).optional(),
    mode: z.enum(['lexical', 'semantic']).optional().default('lexical'),
    run_id: SafePathSegmentSchema.optional(),
    include_explanation: z.boolean().optional().default(false),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .default(4)
      .transform(v => Math.min(Math.max(v, 1), 16)),
    limit: z
      .number()
      .int()
      .optional()
      .default(10)
      .transform(v => Math.min(Math.max(v, 1), 50)),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'semantic' && !v.run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run_id is required. Create one with hep_run_create first.',
        path: ['run_id'],
      });
    }
  });

export const HepProjectQueryEvidenceSemanticToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  project_id: SafePathSegmentSchema,
  paper_id: SafePathSegmentSchema.optional(),
  query: z.string().min(1),
  types: z.array(EvidenceTypeSchema).optional(),
  include_explanation: z.boolean().optional().default(false),
  limit: z
    .number()
    .int()
    .optional()
    .default(10)
    .transform(v => Math.min(Math.max(v, 1), 50)),
});

export const HepProjectPlaybackEvidenceToolSchema = z.object({
  project_id: SafePathSegmentSchema,
  paper_id: SafePathSegmentSchema,
  evidence_id: z.string().min(1),
  before_chars: z
    .number()
    .int()
    .optional()
    .default(40)
    .transform(v => Math.min(Math.max(v, 0), 1000)),
  after_chars: z
    .number()
    .int()
    .optional()
    .default(120)
    .transform(v => Math.min(Math.max(v, 0), 2000)),
});
