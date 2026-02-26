import { createHash } from 'crypto';
import { z } from 'zod';
import { TOOL_SPECS as PDG_TOOL_SPECS } from '@autoresearch/pdg-mcp/tooling';
import { TOOL_SPECS as ZOTERO_TOOL_SPECS } from '@autoresearch/zotero-mcp/tooling';
import {
  invalidParams,
  notFound,
  HEP_PROJECT_CREATE,
  HEP_PROJECT_GET,
  HEP_PROJECT_LIST,
  HEP_HEALTH,
  HEP_PROJECT_BUILD_EVIDENCE,
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC,
  HEP_PROJECT_PLAYBACK_EVIDENCE,
  HEP_PROJECT_COMPARE_MEASUREMENTS,
  HEP_RUN_CREATE,
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_CLEAR_MANIFEST_LOCK,
  HEP_RUN_STAGE_CONTENT,
  HEP_RUN_BUILD_PDF_EVIDENCE,
  HEP_RUN_BUILD_EVIDENCE_INDEX_V1,
  HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
  HEP_RUN_WRITING_TOKEN_GATE_V1,
  HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1,
  HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1,
  HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_SECTION_JUDGE_DECISION_V1,
  HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET,
  HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION,
  HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1,
  HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_OUTLINE_JUDGE_DECISION_V1,
  HEP_RUN_BUILD_WRITING_EVIDENCE,
  HEP_RUN_BUILD_MEASUREMENTS,
  HEP_RUN_BUILD_WRITING_CRITICAL,
  HEP_RUN_BUILD_CITATION_MAPPING,
  HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2,
  HEP_RUN_WRITING_SUBMIT_RERANK_RESULT_V1,
  HEP_RUN_WRITING_SUBMIT_REVIEW,
  HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
  HEP_RUN_WRITING_REFINEMENT_ORCHESTRATOR_V1,
  HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1,
  HEP_RENDER_LATEX,
  HEP_EXPORT_PROJECT,
  HEP_EXPORT_PAPER_SCAFFOLD,
  HEP_IMPORT_PAPER_BUNDLE,
  HEP_IMPORT_FROM_ZOTERO,
  HEP_INSPIRE_SEARCH_EXPORT,
  HEP_INSPIRE_RESOLVE_IDENTIFIERS,
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_LITERATURE,
  INSPIRE_RESOLVE_CITEKEY,
  INSPIRE_PARSE_LATEX,
  INSPIRE_RESEARCH_NAVIGATOR,
  INSPIRE_CRITICAL_RESEARCH,
  INSPIRE_PAPER_SOURCE,
  INSPIRE_DEEP_RESEARCH,
  INSPIRE_FIND_CROSSOVER_TOPICS,
  INSPIRE_ANALYZE_CITATION_STANCE,
  INSPIRE_CLEANUP_DOWNLOADS,
  INSPIRE_VALIDATE_BIBLIOGRAPHY,
  INSPIRE_STYLE_CORPUS_QUERY,
  INSPIRE_STYLE_CORPUS_INIT_PROFILE,
  INSPIRE_STYLE_CORPUS_BUILD_MANIFEST,
  INSPIRE_STYLE_CORPUS_DOWNLOAD,
  INSPIRE_STYLE_CORPUS_BUILD_EVIDENCE,
  INSPIRE_STYLE_CORPUS_BUILD_INDEX,
  INSPIRE_STYLE_CORPUS_EXPORT_PACK,
  INSPIRE_STYLE_CORPUS_IMPORT_PACK,
  TOOL_RISK_LEVELS,
  type ToolRiskLevel,
} from '@autoresearch/shared';
import * as api from '../api/client.js';
import { formatExpertsMarkdown } from '../utils/formatters.js';
import { zodToMcpInputSchema } from './mcpSchema.js';
import { discoveryNextActions, deepResearchAnalyzeNextActions, withNextActions } from './utils/discoveryHints.js';
import {
  StyleCorpusInitProfileToolSchema,
  StyleCorpusBuildManifestToolSchema,
  StyleCorpusDownloadToolSchema,
  StyleCorpusBuildEvidenceToolSchema,
  StyleCorpusBuildIndexToolSchema,
  StyleCorpusQueryToolSchema,
  StyleCorpusExportPackToolSchema,
  StyleCorpusImportPackToolSchema,
} from './writing/inputSchemas.js';
import { createProject, getProject, listProjects } from '../core/projects.js';
import { createRun, getRun, updateRunManifestAtomic, type RunArtifactRef, type RunManifest } from '../core/runs.js';
import { buildAllowedCitationsArtifact, buildCitekeyToInspireStats, writeRunJsonArtifact } from '../core/citations.js';
import { buildProjectEvidenceCatalog, playbackProjectEvidence, queryProjectEvidence } from '../core/evidence.js';
import { ReportDraftSchema, SectionDraftSchema } from '../core/writing/draftSchemas.js';
import { PromptPacketSchema } from '../core/contracts/promptPacket.js';
import { ReviewerReportV2Schema } from '../core/contracts/reviewerReport.js';
import { RevisionPlanV1Schema } from '../core/contracts/revisionPlan.js';
import { PaperSetCurationV1Schema } from '../core/writing/papersetPlanner.js';
import { SectionQualityEvalV1Schema } from '../core/writing/sectionQualityEvaluator.js';
import { renderLatexForRun } from '../core/writing/renderLatex.js';
import { buildRunPdfEvidence } from '../core/pdf/evidence.js';
import { exportProjectForRun } from '../core/export/exportProject.js';
import { exportPaperScaffoldForRun } from '../core/export/exportPaperScaffold.js';
import { importPaperBundleForRun } from '../core/export/importPaperBundle.js';
import { hepInspireSearchExport } from '../core/inspire/searchExport.js';
import { hepInspireResolveIdentifiers } from '../core/inspire/resolveIdentifiers.js';
import { buildRunMeasurements } from '../core/hep/measurements.js';
import { compareProjectMeasurements } from '../core/hep/compareMeasurements.js';
import { hepImportFromZotero } from '../core/zotero/tools.js';
import { getHepHealth } from './utils/health.js';
import { extractKeyFromBibtex } from './writing/reference/bibtexUtils.js';
import {
  TimeRangeSchema,
} from './research/schemas.js';
import { ResearchNavigatorToolSchema } from './research/researchNavigator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolExposureMode = 'standard' | 'full';
export type ToolExposure = 'standard' | 'full';
export type ToolTier = 'core' | 'consolidated' | 'advanced' | 'writing';
export type ToolMaturity = 'stable' | 'experimental' | 'deprecated';

export interface ToolHandlerContext {
  reportProgress?: (progress: number, total?: number, message?: string) => void;
  rawArgs?: Record<string, unknown>;
}

export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  tier: ToolTier;
  intent?: string;
  maturity?: ToolMaturity;
  /** Minimal mode required to expose this tool */
  exposure: ToolExposure;
  /** Risk classification (H-11a) */
  riskLevel: ToolRiskLevel;
  /** Tool input schema (SSOT) */
  zodSchema: TSchema;
  /** Business handler called with parsed params */
  handler: (params: z.output<TSchema>, ctx: ToolHandlerContext) => Promise<unknown>;
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  return mode === 'full' ? true : spec.exposure === 'standard';
}

export function isAdvancedToolSpec(spec: ToolSpec): boolean {
  return spec.tier === 'advanced';
}

function isZoteroIntegrationEnabled(): boolean {
  const raw = process.env.HEP_ENABLE_ZOTERO;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw invalidParams('Invalid HEP_ENABLE_ZOTERO (expected 0/1/true/false/yes/no/on/off)', {
    raw,
    normalized: v,
  });
}

const ZOTERO_INTEGRATION_ENABLED = isZoteroIntegrationEnabled();

// ─────────────────────────────────────────────────────────────────────────────
// Shared schemas
// ─────────────────────────────────────────────────────────────────────────────

const SortSchema = z.enum(['mostrecent', 'mostcited']);
const JsonMarkdownSchema = z.enum(['json', 'markdown']);

// ─────────────────────────────────────────────────────────────────────────────
// vNext: Project/Run tools (M3 foundation)
// ─────────────────────────────────────────────────────────────────────────────

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

const HepProjectCreateToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const HepProjectGetToolSchema = z.object({
  project_id: SafePathSegmentSchema,
});

const HepProjectListToolSchema = z.object({});

const HepHealthToolSchema = z.object({
  check_inspire: z.boolean().optional().default(false),
  inspire_timeout_ms: z.number().int().positive().optional().default(5000),
});

const HepRunCreateToolSchema = z.object({
  project_id: SafePathSegmentSchema,
  args_snapshot: z.unknown().optional(),
});

const HepRunReadArtifactChunkToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  artifact_name: SafePathSegmentSchema,
  offset: z.number().int().nonnegative().optional().default(0),
  length: z.number().int().positive().optional().default(4096),
});

const HepRunClearManifestLockToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  force: z.boolean().optional().default(false),
});

const HepRunStageContentToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  content_type: z.enum(['section_output', 'outline_plan', 'paperset_curation', 'revision_plan', 'reviewer_report', 'judge_decision']).default('section_output'),
  content: z.string().min(1),
  artifact_suffix: SafePathSegmentSchema.optional(),
});

const WritingTokenBudgetPlanReservedOutputTokensOverridesSchema = z
  .object({
    outline: z.number().int().nonnegative().optional(),
    evidence_rerank: z.number().int().nonnegative().optional(),
    section_write: z.number().int().nonnegative().optional(),
    review: z.number().int().nonnegative().optional(),
    revise: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const HepRunWritingCreateTokenBudgetPlanV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  model_context_tokens: z.number().int().positive(),
  model: z.string().optional(),
  safety_margin_tokens: z.number().int().nonnegative().optional(),
  reserved_output_tokens: WritingTokenBudgetPlanReservedOutputTokensOverridesSchema.optional(),
  output_artifact_name: SafePathSegmentSchema.optional(),
  tokenizer_model: z.string().optional().describe('Tokenizer model for token estimation (default: claude-opus-4-6). Recorded in artifact metadata for reproducibility.'),
});

const TokenGateStepSchema = z.enum([
  'outline',
  'evidence_rerank',
  'section_write',
  'review',
  'revise',
  'custom',
]);

const HepRunWritingTokenGateV1ToolSchema = z
  .object({
    run_id: SafePathSegmentSchema,
    step: TokenGateStepSchema,
    prompt_packet: PromptPacketSchema.optional(),
    prompt_packet_uri: z.string().min(1).optional(),
    evidence_packet_uri: z.string().min(1).optional(),
    token_budget_plan_artifact_name: SafePathSegmentSchema.optional(),
    max_context_tokens: z.number().int().positive().optional(),
    reserved_output_tokens: z.number().int().nonnegative().optional(),
    safety_margin_tokens: z.number().int().nonnegative().optional(),
    section_index: z.number().int().positive().optional(),
    output_pass_artifact_name: SafePathSegmentSchema.optional(),
    output_overflow_artifact_name: SafePathSegmentSchema.optional(),
    tokenizer_model: z.string().optional().describe('Tokenizer model for token estimation (default: claude-opus-4-6). Recorded in artifact metadata for reproducibility.'),
  })
  .refine(v => !(v.prompt_packet && v.prompt_packet_uri), {
    message: 'Only one of prompt_packet or prompt_packet_uri may be provided',
  })
  .refine(v => Boolean(v.prompt_packet) || Boolean(v.prompt_packet_uri) || Boolean(v.evidence_packet_uri), {
    message: 'At least one of prompt_packet, prompt_packet_uri, or evidence_packet_uri is required',
  });

const HepRunWritingCreateSectionWritePacketV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  outline_artifact_name: SafePathSegmentSchema.optional(),
  paperset_artifact_name: SafePathSegmentSchema.optional(),
  claims_table_artifact_name: SafePathSegmentSchema.optional(),
  evidence_packet_artifact_name: SafePathSegmentSchema.optional(),
  token_budget_plan_artifact_name: SafePathSegmentSchema.optional(),
  output_packet_artifact_name: SafePathSegmentSchema.optional(),
  output_prompt_text_artifact_name: SafePathSegmentSchema.optional(),
  output_evidence_context_artifact_name: SafePathSegmentSchema.optional(),
});

const HepRunWritingCreateOutlineCandidatesPacketV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  language: z.enum(['en', 'zh', 'auto']).optional().default('auto'),
  target_length: z.enum(['short', 'medium', 'long']),
  title: z.string().min(1),
  topic: z.string().optional(),
  structure_hints: z.string().optional(),
  user_outline: z.string().optional(),
  claims_table_artifact_name: SafePathSegmentSchema.optional(),
  n_candidates: z.number().int().min(2).optional(),
  variation_strategy: z.string().min(1).optional(),
  temperatures: z.array(z.number()).optional(),
  seeds: z.array(z.union([z.number(), z.string()])).optional(),
});

const HepRunWritingSubmitOutlineCandidatesV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  candidates: z
    .array(
      z.object({
        candidate_index: z.number().int().nonnegative(),
        outline_plan_uri: z.string().min(1),
        client_model: z.string().min(1).nullable().optional(),
        temperature: z.number().nullable().optional(),
        seed: z.union([z.number(), z.string()]).nullable().optional(),
      })
    )
    .min(2),
});

const HepRunWritingCreateOutlineJudgePacketV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  candidates_uri: z.string().min(1),
});

const HepRunWritingSubmitOutlineJudgeDecisionV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  judge_decision_uri: z.string().min(1),
  client_model: z.string().min(1).nullable().optional(),
  temperature: z.number().nullable().optional(),
  seed: z.union([z.number(), z.string()]).nullable().optional(),
});

const HepRunWritingCreatePapersetCurationPacketToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  language: z.enum(['en', 'zh', 'auto']).optional().default('auto'),
  target_length: z.enum(['short', 'medium', 'long']),
  title: z.string().min(1),
  topic: z.string().optional(),
  structure_hints: z.string().optional(),
  seed_identifiers: z.array(z.string().min(1)).min(1),
  candidate_pool_artifact_name: SafePathSegmentSchema.optional(),
  output_artifact_name: SafePathSegmentSchema.optional(),
});

const HepRunWritingSubmitPapersetCurationToolSchema = z
  .object({
    run_id: SafePathSegmentSchema,
    paperset: PaperSetCurationV1Schema.optional(),
    paperset_uri: z.string().min(1).optional(),
    paperset_artifact_name: SafePathSegmentSchema.optional(),
    prompt_packet_artifact_name: SafePathSegmentSchema.optional(),
  })
  .refine(v => Boolean(v.paperset) !== Boolean(v.paperset_uri), {
    message: 'Exactly one of paperset or paperset_uri must be provided',
  });

const HepRunBuildCitationMappingToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  /** Paper identifier: recid, arXiv ID, or DOI */
  identifier: z.string().min(1),
  /** Primary allowlist (typically the reviewed corpus recids); supports "123" or "inspire:123" */
  allowed_citations_primary: z.array(z.string().min(1)).optional().default([]),
  /** Whether to include mapped references from bibliography into allowlist (default: true) */
  include_mapped_references: z.boolean().optional().default(true),
});

const HepRunWritingCreateSectionCandidatesPacketV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  n_candidates: z.number().int().min(2).optional(),
  variation_strategy: z.string().min(1).optional(),
  temperatures: z.array(z.number()).optional(),
  seeds: z.array(z.union([z.number(), z.string()])).optional(),
  output_artifact_name: SafePathSegmentSchema.optional(),
});

const HepRunWritingSubmitSectionCandidatesV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  candidates: z
    .array(
      z.object({
        candidate_index: z.number().int().nonnegative(),
        section_output_uri: z.string().min(1),
        client_model: z.string().min(1).nullable().optional(),
        temperature: z.number().nullable().optional(),
        seed: z.union([z.number(), z.string()]).nullable().optional(),
      })
    )
    .min(2),
});

const HepRunWritingCreateSectionJudgePacketV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  candidates_uri: z.string().min(1),
});

const HepRunWritingSubmitSectionJudgeDecisionV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  judge_decision_uri: z.string().min(1),
  client_model: z.string().min(1).nullable().optional(),
  temperature: z.number().nullable().optional(),
  seed: z.union([z.number(), z.string()]).nullable().optional(),
  quality_eval: SectionQualityEvalV1Schema.optional(),
});

const HepRunWritingSubmitReviewToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  round: z.number().int().positive().optional().default(1),
  reviewer_report: ReviewerReportV2Schema.optional(),
  reviewer_report_uri: z.string().min(1).optional(),
  client_model: z.string().min(1).nullable().optional(),
  temperature: z.number().nullable().optional(),
  seed: z.union([z.number(), z.string()]).nullable().optional(),
}).refine(
  v => Boolean(v.reviewer_report) !== Boolean(v.reviewer_report_uri),
  { message: 'Exactly one of reviewer_report or reviewer_report_uri must be provided' }
);

const HepRunWritingCreateRevisionPlanPacketV1ToolSchema = z.object({
  reviewer_report_uri: z.string().min(1),
  manifest_uri: z.string().min(1),
  quality_policy_uri: z.string().min(1).optional(),
  round: z.number().int().positive().optional().default(1),
});

const HepRunWritingSubmitRevisionPlanV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  revision_plan: RevisionPlanV1Schema.optional(),
  revision_plan_uri: z.string().min(1).optional(),
}).refine(
  v => Boolean(v.revision_plan) !== Boolean(v.revision_plan_uri),
  { message: 'Exactly one of revision_plan or revision_plan_uri must be provided' }
);

const HepRunWritingIntegrateSectionsV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  fix_unused_materials: z.boolean().optional().default(true),
  add_cross_references: z.boolean().optional().default(true),
  unify_terminology: z.boolean().optional().default(false),
  final_polish: z.boolean().optional().default(false),
  max_retries: z.number().int().nonnegative().optional(),
});

const HepRunWritingRefinementOrchestratorV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  round: z.number().int().positive().optional().default(1),
  reviewer_report_uri: z.string().min(1).optional(),
  revision_plan_uri: z.string().min(1).optional(),
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

const AllowedCitationsArtifactInputSchema = z
  .object({
    version: z.literal(1).optional(),
    allowed_citations: z.array(z.string().min(1)),
  })
  .passthrough();

const AllowedCitationsInputSchema = z.union([z.array(z.string().min(1)), AllowedCitationsArtifactInputSchema]);

const HepRenderLatexToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  draft: z.union([SectionDraftSchema, ReportDraftSchema]),
  allowed_citations: AllowedCitationsInputSchema.optional(),
  cite_mapping: CiteMappingInputSchema.optional(),
  latex_artifact_name: SafePathSegmentSchema.optional().default('rendered_latex.tex'),
  section_output_artifact_name: SafePathSegmentSchema.optional().default('rendered_section_output.json'),
  verification_artifact_name: SafePathSegmentSchema.optional().default('rendered_latex_verification.json'),
});

const HepExportProjectToolSchema = z.object({
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

const HepExportPaperScaffoldToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  output_dir_name: SafePathSegmentSchema.optional().default('paper'),
  overwrite: z.boolean().optional().default(false),
  integrated_latex_artifact_name: SafePathSegmentSchema.optional().default('writing_integrated.tex'),
  writing_master_bib_artifact_name: SafePathSegmentSchema.optional().default('writing_master.bib'),
  bibliography_raw_artifact_name: SafePathSegmentSchema.optional().default('bibliography_raw_v1.json'),
  zip_artifact_name: SafePathSegmentSchema.optional().default('paper_scaffold.zip'),
  paper_manifest_artifact_name: SafePathSegmentSchema.optional().default('paper_manifest.json'),
  _confirm: z.boolean().optional(),
});

const HepImportPaperBundleToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  paper_dir_name: SafePathSegmentSchema.optional().default('paper'),
  zip_artifact_name: SafePathSegmentSchema.optional().default('paper_bundle.zip'),
  bundle_manifest_artifact_name: SafePathSegmentSchema.optional().default('paper_bundle_manifest.json'),
  pdf_artifact_name: SafePathSegmentSchema.optional().default('paper_final.pdf'),
  overwrite: z.boolean().optional().default(false),
  dereference_symlinks: z.boolean().optional().default(false),
  allow_external_symlink_targets: z.boolean().optional().default(false),
});

const HepImportFromZoteroToolSchema = z.object({
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

const HepRunBuildPdfEvidenceToolSchema = z.object({
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

const HepRunBuildEvidenceIndexV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  paper_ids: z.array(z.string().min(1)).min(1),
  output_artifact_name: SafePathSegmentSchema.optional().default('evidence_index_v1.json'),
  metrics_artifact_name: SafePathSegmentSchema.optional().default('evidence_index_metrics_v1.json'),
  paper_cache_prefix: SafePathSegmentSchema.optional().default('evidence_paper'),
  force_rebuild: z.boolean().optional().default(false),
});

const RagSectionTypeSchema = z.enum(['introduction', 'methodology', 'results', 'discussion', 'conclusion']);

const HepRunWritingBuildEvidencePacketSectionV2ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  llm_mode: z.enum(['client', 'internal']).optional().default('client'),
  evidence_index_artifact_name: SafePathSegmentSchema.optional().default('evidence_index_v1.json'),
  outline_artifact_name: SafePathSegmentSchema.optional().default('writing_outline_v2.json'),
  claims_table_artifact_name: SafePathSegmentSchema.optional().default('writing_claims_table.json'),
  max_queries: z.number().int().nonnegative().optional().default(0),
  section_title: z.string().min(1).optional(),
  section_type: RagSectionTypeSchema.optional(),
  queries: z.array(z.string().min(1)).optional(),
  claim_ids: z.array(z.string().min(1)).optional().default([]),
  token_budget_plan_artifact_name: SafePathSegmentSchema.optional(),
  max_context_tokens: z.number().int().positive().optional(),
  reserved_output_tokens: z.number().int().nonnegative().optional(),
  safety_margin_tokens: z.number().int().nonnegative().optional(),
  top_k_per_query: z.number().int().positive().optional().default(20),
  max_candidates: z.number().int().positive().optional().default(200),
  rerank_top_k: z.number().int().positive().optional().default(100),
  rerank_output_top_n: z.number().int().positive().optional().default(50),
  max_chunk_chars: z.number().int().positive().optional().default(500),
  max_selected_chunks: z.number().int().positive().optional().default(25),
  max_total_tokens: z.number().int().positive().optional().default(10_000),
  max_chunks_per_source: z.number().int().positive().optional().default(10),
  min_sources: z.number().int().nonnegative().optional().default(3),
  min_per_query: z.number().int().nonnegative().optional().default(1),
  output_candidates_artifact_name: SafePathSegmentSchema.optional(),
  output_rerank_packet_artifact_name: SafePathSegmentSchema.optional(),
  output_rerank_prompt_artifact_name: SafePathSegmentSchema.optional(),
  output_rerank_raw_artifact_name: SafePathSegmentSchema.optional(),
  output_rerank_result_artifact_name: SafePathSegmentSchema.optional(),
  output_packet_artifact_name: SafePathSegmentSchema.optional(),
}).refine(v => {
  const hasQueries = Array.isArray(v.queries) && v.queries.length > 0;
  if (!hasQueries) return true;
  return Boolean(v.section_title) && Boolean(v.section_type);
}, { message: 'When queries are provided, section_title and section_type are required' });

const HepRunWritingSubmitRerankResultV1ToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  section_index: z.number().int().positive(),
  rerank_packet_artifact_name: SafePathSegmentSchema.optional(),
  ranked_indices: z.array(z.number().int().nonnegative()).min(1),
  token_budget_plan_artifact_name: SafePathSegmentSchema.optional(),
  max_context_tokens: z.number().int().positive().optional(),
  reserved_output_tokens: z.number().int().nonnegative().optional(),
  safety_margin_tokens: z.number().int().nonnegative().optional(),
  output_rerank_raw_artifact_name: SafePathSegmentSchema.optional(),
  output_rerank_result_artifact_name: SafePathSegmentSchema.optional(),
  output_packet_artifact_name: SafePathSegmentSchema.optional(),
});

const SearchExportFormatSchema = z.enum(['jsonl', 'json']);

const HepInspireSearchExportToolSchema = z.object({
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

const HepInspireResolveIdentifiersToolSchema = z.object({
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

const HepRunBuildMeasurementsToolSchema = z.object({
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

const HepProjectCompareMeasurementsToolSchema = z.object({
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

const HepRunBuildWritingEvidenceToolSchema = z
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

const HepRunBuildWritingCriticalToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  recids: z.array(z.string().min(1)).min(1),
  claims_artifact_name: SafePathSegmentSchema.optional().default('writing_claims_table.json'),
  conflicts_artifact_name: SafePathSegmentSchema.optional().default('writing_conflicts.json'),
  stance_artifact_name: SafePathSegmentSchema.optional().default('writing_stance.jsonl'),
  evidence_grades_artifact_name: SafePathSegmentSchema.optional().default('writing_evidence_grades.json'),
  summary_artifact_name: SafePathSegmentSchema.optional().default('writing_critical_summary.json'),
  min_tension_sigma: z.number().optional().default(2),
  target_quantities: z.array(z.string().min(1)).optional(),
  include_tables: z.boolean().optional().default(true),
});

const HepProjectBuildEvidenceToolSchema = z
  .object({
    project_id: SafePathSegmentSchema,
    paper_id: SafePathSegmentSchema.optional(),
    /** Paper identifier: recid, arXiv ID, or DOI */
    identifier: z.string().min(1).optional(),
    /** Local path to a main .tex file (avoids network) */
    main_tex_path: z.string().min(1).optional(),
    /** Include inline math (default: false) */
    include_inline_math: z.boolean().optional().default(false),
    /** Include cross refs (\\ref/\\eqref/\\autoref) as citation_context (default: false) */
    include_cross_refs: z.boolean().optional().default(false),
    /** Max paragraph text length (0 = no limit) */
    max_paragraph_length: z.number().int().optional().default(0),
  })
  .refine(p => Boolean(p.identifier) || Boolean(p.main_tex_path), {
    message: 'Either identifier or main_tex_path is required',
  });

const HepProjectQueryEvidenceToolSchema = z
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

const HepProjectQueryEvidenceSemanticToolSchema = z.object({
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

const HepProjectPlaybackEvidenceToolSchema = z.object({
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

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1: Core tools
// ─────────────────────────────────────────────────────────────────────────────

const InspireSearchToolSchema = z.object({
  query: z.string().min(1),
  sort: SortSchema.optional(),
  size: z.number().int().min(1).max(1000).optional().default(25),
  page: z.number().int().optional().default(1),
  format: JsonMarkdownSchema.optional().default('json'),
  review_mode: z.enum(['mixed', 'separate', 'deprioritize', 'exclude']).optional().default('mixed'),
});

const InspireSearchNextToolSchema = z.object({
  next_url: z.string().min(1),
  review_mode: z.enum(['mixed', 'separate', 'deprioritize', 'exclude']).optional().default('mixed'),
});

const InspireLiteratureModeSchema = z.enum([
  'get_paper',
  'get_references',
  'lookup_by_id',
  'get_citations',
  'search_affiliation',
  'get_bibtex',
  'get_author',
]);

const InspireLiteratureRecidsSchema = z.preprocess(
  value => {
    if (Array.isArray(value)) {
      return value
        .map(v => (typeof v === 'number' ? String(v) : v))
        .map(v => (typeof v === 'string' ? v.trim() : v))
        .filter(v => (typeof v === 'string' ? v.length > 0 : true));
    }

    if (typeof value === 'number') {
      return [String(value)];
    }

    if (typeof value === 'string') {
      return value
        .split(/[,\s]+/g)
        .map(v => v.trim())
        .filter(v => v.length > 0);
    }

    return value;
  },
  z.array(z.string().min(1)).min(1)
);

// Flattened schema to avoid top-level oneOf/anyOf/allOf (gateway compatibility).
// Mode-specific requirements are enforced in superRefine (fail-fast).
const InspireLiteratureToolSchema = z
  .object({
    mode: InspireLiteratureModeSchema,
    recid: z.string().min(1).optional(),
    size: z.number().int().optional(),
    identifier: z.string().min(1).optional(),
    sort: SortSchema.optional(),
    affiliation: z.string().min(1).optional(),
    recids: InspireLiteratureRecidsSchema.optional(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    const allowed = (() => {
      switch (v.mode) {
        case 'get_paper':
          return new Set(['recid']);
        case 'get_references':
          return new Set(['recid', 'size']);
        case 'lookup_by_id':
          return new Set(['identifier']);
        case 'get_citations':
          return new Set(['recid', 'size', 'sort']);
        case 'search_affiliation':
          return new Set(['affiliation', 'size', 'sort']);
        case 'get_bibtex':
          return new Set(['recids']);
        case 'get_author':
          return new Set(['identifier']);
        default:
          return new Set<string>();
      }
    })();

    const extraKeys = Object.keys(v)
      .filter(k => k !== 'mode')
      .filter(k => !allowed.has(k))
      .sort((a, b) => a.localeCompare(b));

    if (extraKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.unrecognized_keys,
        keys: extraKeys,
        path: [],
      });
    }

    const requireKey = (key: 'recid' | 'identifier' | 'affiliation' | 'recids', message: string) => {
      if (!(key in v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [key] });
      }
    };

    switch (v.mode) {
      case 'get_paper':
      case 'get_references':
      case 'get_citations':
        requireKey('recid', `mode='${v.mode}' requires recid`);
        break;
      case 'search_affiliation':
        requireKey('affiliation', "mode='search_affiliation' requires affiliation");
        break;
      case 'lookup_by_id':
      case 'get_author':
        requireKey('identifier', `mode='${v.mode}' requires identifier`);
        break;
      case 'get_bibtex':
        requireKey('recids', "mode='get_bibtex' requires recids");
        break;
      default:
        break;
    }
  });

const InspireRecidSchema = z.preprocess(
  value => {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value.trim();
    return value;
  },
  z.string().min(1)
);

const InspireResolveCitekeyToolSchema = z
  .object({
    recid: InspireRecidSchema.optional(),
    recids: InspireLiteratureRecidsSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasRecid = typeof v.recid === 'string' && v.recid.trim().length > 0;
    const hasRecids = Array.isArray(v.recids) && v.recids.length > 0;
    if (!hasRecid && !hasRecids) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide 'recid' or 'recids'",
        path: ['recid'],
      });
    }
  });

function preprocessQuery(query: string): string {
  return query.replace(/\ba:["']([^"']+)["']/gi, 'a:$1');
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(String(value));
  if (t === 'undefined') return 'undefined';
  if (t === 'function' || t === 'symbol') return JSON.stringify(String(value));

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }

  return JSON.stringify(String(value));
}

function hashParseLatexRequest(params: {
  identifier: string;
  components: string[];
  options?: unknown;
}): string {
  const material = stableStringify({
    identifier: params.identifier,
    components: params.components,
    options: params.options ?? null,
  });
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

function isNoLatexSourceError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('latex source not available') || msg.includes('could not identify main .tex file');
}

// For classifyPapers (used in search preprocessing)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let classifyPapersCache: ((papers: any[]) => any[]) | null = null;

async function getClassifyPapers() {
  if (classifyPapersCache) return classifyPapersCache;
  const module = await import('./research/paperClassifier.js');
  classifyPapersCache = module.classifyPapers as unknown as (papers: unknown[]) => unknown[];
  return classifyPapersCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: Consolidated tools
// ─────────────────────────────────────────────────────────────────────────────


const CriticalResearchToolSchema = z.object({
  mode: z.enum(['evidence', 'conflicts', 'analysis', 'reviews', 'theoretical']),
  recids: z.array(z.string().min(1)).min(1),
  run_id: SafePathSegmentSchema.optional(),
  options: z
    .object({
      search_confirmations: z.boolean().optional(),
      max_search_results: z.number().int().optional(),
      target_quantities: z.array(z.string()).optional(),
      min_tension_sigma: z.number().optional(),
      include_tables: z.boolean().optional(),
      include_evidence: z.boolean().optional(),
      include_questions: z.boolean().optional(),
      include_assumptions: z.boolean().optional(),
      check_literature: z.boolean().optional(),
      assumption_max_depth: z.number().int().optional(),
      current_threshold_years: z.number().int().optional(),

      // mode='theoretical' (P2.3b)
      subject_entity: z.string().min(1).optional(),
      inputs: z.array(z.enum(['title', 'abstract', 'citation_context', 'evidence_paragraph'])).optional(),
      max_papers: z.number().int().positive().optional(),
      max_claim_candidates_per_paper: z.number().int().positive().optional(),
      max_candidates_total: z.number().int().positive().optional(),
      llm_mode: z.enum(['passthrough', 'client', 'internal']).optional(),
      max_llm_requests: z.number().int().positive().optional(),
      strict_llm: z.boolean().optional(),
      prompt_version: z.string().min(1).optional(),
      stable_sort: z.boolean().optional(),
      client_llm_responses: z
        .array(
          z
            .object({
              request_id: z.string().min(1),
              json_response: z.unknown(),
              model: z.string().optional(),
              created_at: z.string().optional(),
            })
            .passthrough()
        )
        .optional(),
    })
    .optional(),
}).superRefine((v, ctx) => {
  if (v.mode === 'theoretical' && !v.run_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mode='theoretical' requires run_id (Evidence-first: writes run artifacts)",
      path: ['run_id'],
    });
  }
});

const PaperSourceToolSchema = z.object({
  identifier: z.string().min(1),
  mode: z.enum(['urls', 'content', 'metadata', 'auto']),
  options: z
    .object({
      prefer: z.enum(['latex', 'pdf', 'auto']).optional(),
      extract: z.boolean().optional(),
      auto_cleanup: z.boolean().optional(),
      check_availability: z.boolean().optional(),
      output_dir: z.string().optional(),
    })
    .optional(),
});

const DeepResearchToolSchema = z.object({
  identifiers: z.array(z.string().min(1)).min(1),
  mode: z.enum(['analyze', 'synthesize', 'write']),
  format: JsonMarkdownSchema.optional(),
  run_id: SafePathSegmentSchema.optional(),
  resume_from: z.enum(['paperset', 'claims', 'critical', 'outline', 'sections', 'verify', 'originality', 'review']).optional(),
  options: z
    .object({
      // Analyze mode options
      extract_equations: z.boolean().optional(),
      extract_theorems: z.boolean().optional(),
      extract_methodology: z.boolean().optional(),
      extract_conclusions: z.boolean().optional(),
      include_inline_math: z.boolean().optional(),
      max_section_length: z.number().int().optional(),

      // Synthesize mode options
      review_type: z.enum(['methodology', 'timeline', 'comparison', 'overview']).optional(),
      focus_topic: z.string().optional(),
      style: z.enum(['list', 'narrative']).optional(),
      include_critical_analysis: z.boolean().optional(),
      narrative_structure: z.enum(['top_down', 'bottom_up', 'historical']).optional(),
      include_equations: z.boolean().optional(),
      include_bibliography: z.boolean().optional(),
      max_papers_per_group: z.number().int().optional(),

      // Write mode options
      topic: z.string().optional(),
      title: z.string().optional(),
      target_length: z.enum(['short', 'medium', 'long']).optional(),
      quality_level: z.enum(['standard', 'publication']).optional(),
      structure_hints: z.string().optional(),
      user_outline: z.string().max(20_000).optional(),
      outline_policy: z.enum(['lock', 'allow_minimal_edits']).optional(),
      phase0_options: z
        .object({
          max_retries: z.number().int().min(0).max(5).optional(),
        })
        .optional(),
      phase1_options: z
        .object({
          max_retries: z.number().int().min(0).max(5).optional(),
          require_asset_coverage: z.boolean().optional(),
        })
        .optional(),
      phase2_options: z
        .object({
          max_retries: z.number().int().min(0).max(5).optional(),
        })
        .optional(),
      llm_mode: z.enum(['client', 'internal']).optional(),
      max_section_retries: z.number().int().min(0).max(5).optional().default(3),
      auto_fix_originality: z.boolean().optional().default(true),
      auto_fix_citations: z.boolean().optional().default(true),
      language: z.enum(['en', 'zh']).optional(),
    })
    .optional(),
}).strict().superRefine((v, ctx) => {
  if (v.mode === 'write' && !v.run_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mode='write' requires run_id (Evidence-first: use hep_project_create + hep_run_create first)",
      path: ['run_id'],
    });
  }
});

const InspireParseLatexToolSchema = z.object({
  run_id: SafePathSegmentSchema,
  identifier: z.string().min(1),
  components: z
    .array(
      z.enum([
        'sections',
        'equations',
        'theorems',
        'citations',
        'figures',
        'tables',
        'bibliography',
        'all',
      ])
    )
    .min(1),
  options: z
    .object({
      format: JsonMarkdownSchema.optional(),
      include_external: z.boolean().optional(),
      max_depth: z.number().int().min(1).optional(),
      cross_validate: z.boolean().optional(),
    })
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: Consolidated tools
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Full-only advanced tools (4)
// ─────────────────────────────────────────────────────────────────────────────

const FindCrossoverTopicsToolSchema = z.object({
  categories: z.array(z.string().min(1)).length(2).optional(),
  scan_popular: z.boolean().optional().default(true),
  time_range: TimeRangeSchema,
  min_papers: z.number().int().optional(),
  limit: z.number().int().optional(),
});

const AnalyzeCitationStanceToolSchema = z.object({
  latex_content: z.string().min(1),
  target_recid: z.string().min(1),
  bib_content: z.string().optional(),
  max_contexts: z.number().int().optional().default(20),
});

const CleanupDownloadsToolSchema = z.object({
  arxiv_id: z.string().optional(),
  older_than_hours: z.number().int().optional(),
  dry_run: z.boolean().optional(),
  _confirm: z.boolean().optional(),
});

const ValidateBibliographyToolSchema = z.object({
  identifier: z.string().min(1),
  scope: z.enum(['manual_only', 'all']).optional().default('manual_only'),
  check_discrepancies: z.boolean().optional().default(true),
  validate_against_inspire: z.boolean().optional().default(false),
  require_locatable: z.boolean().optional().default(true),
  max_entries: z.number().int().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry (SSOT)
// ─────────────────────────────────────────────────────────────────────────────

// Specs without riskLevel — injected from TOOL_RISK_LEVELS below
const _RAW_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  // vNext: Project/Run tools (M3)
  {
    name: HEP_PROJECT_CREATE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a local project (Project/Run foundation) and return `hep://projects/{project_id}` (read details via MCP resources; local-only)',
    zodSchema: HepProjectCreateToolSchema,
    handler: async params => {
      const project = createProject(params);
      return {
        project_id: project.project_id,
        project_uri: `hep://projects/${encodeURIComponent(project.project_id)}`,
        summary: {
          name: project.name,
          description: project.description,
          created_at: project.created_at,
        },
      };
    },
  },
  {
    name: HEP_PROJECT_GET,
    tier: 'core',
    exposure: 'standard',
    description:
      'Get a project summary + `hep://projects/{project_id}` URI (read the full manifest via MCP resources; local-only)',
    zodSchema: HepProjectGetToolSchema,
    handler: async params => {
      const project = getProject(params.project_id);
      return {
        project_id: project.project_id,
        project_uri: `hep://projects/${encodeURIComponent(project.project_id)}`,
        summary: {
          name: project.name,
          description: project.description,
          created_at: project.created_at,
          updated_at: project.updated_at,
        },
      };
    },
  },
  {
    name: HEP_PROJECT_LIST,
    tier: 'core',
    exposure: 'standard',
    description:
      'List local projects (small summaries + `hep://projects/{project_id}` URIs; read details via MCP resources; local-only)',
    zodSchema: HepProjectListToolSchema,
    handler: async () => {
      const projects = listProjects().map(p => ({
        project_id: p.project_id,
        name: p.name,
        updated_at: p.updated_at,
        project_uri: `hep://projects/${encodeURIComponent(p.project_id)}`,
      }));
      return { total: projects.length, projects };
    },
  },
  {
    name: HEP_HEALTH,
    tier: 'core',
    exposure: 'standard',
    description:
      'Server health/config snapshot + optional INSPIRE connectivity probe (local-only; network optional).',
    zodSchema: HepHealthToolSchema,
    handler: async params =>
      getHepHealth({ check_inspire: params.check_inspire, inspire_timeout_ms: params.inspire_timeout_ms }),
  },
  {
    name: HEP_PROJECT_BUILD_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build a LaTeX Evidence Catalog for a project paper and write `catalog.jsonl` (Evidence-first: URI + summary; local-only)',
    zodSchema: HepProjectBuildEvidenceToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxParagraphLengthProvided = Object.prototype.hasOwnProperty.call(raw, 'max_paragraph_length');
      return buildProjectEvidenceCatalog({ ...params, budget_hints: { max_paragraph_length_provided: maxParagraphLengthProvided } });
    },
  },
  {
    name: HEP_PROJECT_QUERY_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Unified query over a project Evidence Catalog (mode=lexical|semantic; semantic requires run embeddings and writes run artifact; local-only).',
    zodSchema: HepProjectQueryEvidenceToolSchema,
    handler: async (params, ctx) => {
      if (params.mode === 'semantic') {
        const { queryProjectEvidenceSemantic } = await import('../core/evidenceSemantic.js');
        return queryProjectEvidenceSemantic({
          run_id: params.run_id!,
          project_id: params.project_id,
          paper_id: params.paper_id,
          query: params.query,
          types: params.types,
          include_explanation: params.include_explanation,
          limit: params.limit,
        });
      }

      const raw = ctx.rawArgs ?? {};
      const concurrencyProvided = Object.prototype.hasOwnProperty.call(raw, 'concurrency');
      return queryProjectEvidence({
        project_id: params.project_id,
        paper_id: params.paper_id,
        query: params.query,
        types: params.types,
        limit: params.limit,
        concurrency: params.concurrency,
        budget_hints: { concurrency_provided: concurrencyProvided },
      });
    },
  },
  {
    name: HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC,
    tier: 'core',
    exposure: 'standard',
    description:
      'Semantic query interface for a project Evidence Catalog. Currently falls back to lexical search and writes a run artifact (URI + summary; local-only).',
    zodSchema: HepProjectQueryEvidenceSemanticToolSchema,
    handler: async params => {
      const { queryProjectEvidenceSemantic } = await import('../core/evidenceSemantic.js');
      return queryProjectEvidenceSemantic(params);
    },
  },
  {
    name: HEP_PROJECT_PLAYBACK_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description: 'Playback an evidence locator and return a stable snippet (local-only)',
    zodSchema: HepProjectPlaybackEvidenceToolSchema,
    handler: async params => playbackProjectEvidence(params),
  },
  {
    name: HEP_RUN_CREATE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a run under a project (writes run manifest + artifacts dir; returns `hep://runs/{run_id}` URIs; local-only)',
    zodSchema: HepRunCreateToolSchema,
    handler: async params => {
      const { manifest, artifacts } = createRun({
        project_id: params.project_id,
        args_snapshot: params.args_snapshot,
      });
      return {
        run_id: manifest.run_id,
        project_id: manifest.project_id,
        manifest_uri: `hep://runs/${encodeURIComponent(manifest.run_id)}/manifest`,
        artifacts,
        summary: {
          status: manifest.status,
          created_at: manifest.created_at,
        },
      };
    },
  },
  {
    name: HEP_RUN_READ_ARTIFACT_CHUNK,
    tier: 'core',
    exposure: 'standard',
    description:
      'Read a small byte-range chunk from a HEP run artifact (debug helper; returns base64 chunk; local-only). ' +
      'Note: This tool only works for HEP run artifacts (hep://runs/...). ' +
      'For PDG artifacts (pdg://artifacts/...), use MCP Resources (ReadResource request) instead.',
    zodSchema: HepRunReadArtifactChunkToolSchema,
    handler: async params => {
      const { readRunArtifactChunk } = await import('../core/artifactChunk.js');
      return readRunArtifactChunk({
        run_id: params.run_id,
        artifact_name: params.artifact_name,
        offset: params.offset,
        length: params.length,
      });
    },
  },
  {
    name: HEP_RUN_CLEAR_MANIFEST_LOCK,
    tier: 'core',
    exposure: 'standard',
    description:
      'Clear a stale run manifest lock file (fail-fast; local-only). Use force=true only if you are sure no other tool is updating the run manifest.',
    zodSchema: HepRunClearManifestLockToolSchema,
    handler: async params => {
      const { clearRunManifestLock } = await import('../core/runs.js');
      return clearRunManifestLock({ run_id: params.run_id, force: params.force });
    },
  },
  {
    name: HEP_RUN_STAGE_CONTENT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Stage large client content into a run artifact and return its URI (token-limit safe two-step submission; local-only)',
    zodSchema: HepRunStageContentToolSchema,
    handler: async params => {
      const { stageRunContent } = await import('../core/writing/staging.js');
      return stageRunContent({
        run_id: params.run_id,
        content_type: params.content_type,
        content: params.content,
        artifact_suffix: params.artifact_suffix,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a `writing_token_budget_plan_v1.json` artifact for a run (M05: TokenBudgetPlan SSOT; overflow_policy=fail_fast; Evidence-first; local-only).',
    zodSchema: HepRunWritingCreateTokenBudgetPlanV1ToolSchema,
    handler: async params => {
      const { createRunWritingTokenBudgetPlanV1 } = await import('../core/writing/tokenBudgetPlan.js');
      return createRunWritingTokenBudgetPlanV1({
        run_id: params.run_id,
        model_context_tokens: params.model_context_tokens,
        model: params.model,
        safety_margin_tokens: params.safety_margin_tokens,
        reserved_output_tokens: params.reserved_output_tokens,
        output_artifact_name: params.output_artifact_name,
        tokenizer_model: params.tokenizer_model,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_TOKEN_GATE_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Run TokenGate on a prompt_packet (+ optional evidence_packet) and write either token gate pass or writing_token_overflow artifacts (M05; fail-fast; Evidence-first; local-only).',
    zodSchema: HepRunWritingTokenGateV1ToolSchema,
    handler: async params => {
      const { runWritingTokenGateV1 } = await import('../core/writing/tokenGate.js');
      return runWritingTokenGateV1({
        run_id: params.run_id,
        step: params.step,
        prompt_packet: params.prompt_packet,
        prompt_packet_uri: params.prompt_packet_uri,
        evidence_packet_uri: params.evidence_packet_uri,
        token_budget_plan_artifact_name: params.token_budget_plan_artifact_name,
        max_context_tokens: params.max_context_tokens,
        reserved_output_tokens: params.reserved_output_tokens,
        safety_margin_tokens: params.safety_margin_tokens,
        section_index: params.section_index,
        output_pass_artifact_name: params.output_pass_artifact_name,
        output_overflow_artifact_name: params.output_overflow_artifact_name,
        tokenizer_model: params.tokenizer_model,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a per-section PromptPacket + evidence context artifacts for client section writing, gated by TokenGate (M06; fail-fast; Evidence-first; local-only).',
    zodSchema: HepRunWritingCreateSectionWritePacketV1ToolSchema,
    handler: async params => {
      const { createRunWritingSectionWritePacketV1 } = await import('../core/writing/sectionWritePacket.js');
      return createRunWritingSectionWritePacketV1({
        run_id: params.run_id,
        section_index: params.section_index,
        outline_artifact_name: params.outline_artifact_name,
        paperset_artifact_name: params.paperset_artifact_name,
        claims_table_artifact_name: params.claims_table_artifact_name,
        evidence_packet_artifact_name: params.evidence_packet_artifact_name,
        token_budget_plan_artifact_name: params.token_budget_plan_artifact_name,
        output_packet_artifact_name: params.output_packet_artifact_name,
        output_prompt_text_artifact_name: params.output_prompt_text_artifact_name,
        output_evidence_context_artifact_name: params.output_evidence_context_artifact_name,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create an N-best section candidates prompt_packet + next_actions (M13; N>=2 hard requirement; Evidence-first; fail-fast; local-only).',
    zodSchema: HepRunWritingCreateSectionCandidatesPacketV1ToolSchema,
    handler: async params => {
      const { createRunWritingSectionCandidatesPacketV1 } = await import('../core/writing/sectionCandidates.js');
      return createRunWritingSectionCandidatesPacketV1({
        run_id: params.run_id,
        section_index: params.section_index,
        n_candidates: params.n_candidates,
        variation_strategy: params.variation_strategy,
        temperatures: params.temperatures,
        seeds: params.seeds,
        output_artifact_name: params.output_artifact_name,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit N-best section candidates (strict schema validation; writes writing_candidates_section_###_v1.json; fail-fast; local-only).',
    zodSchema: HepRunWritingSubmitSectionCandidatesV1ToolSchema,
    handler: async params => {
      const { submitRunWritingSectionCandidatesV1 } = await import('../core/writing/sectionCandidates.js');
      return submitRunWritingSectionCandidatesV1({
        run_id: params.run_id,
        section_index: params.section_index,
        candidates: params.candidates,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a Judge prompt_packet for selecting the best section candidate (M13; hard gates; Evidence-first; fail-fast; local-only).',
    zodSchema: HepRunWritingCreateSectionJudgePacketV1ToolSchema,
    handler: async params => {
      const { createRunWritingSectionJudgePacketV1 } = await import('../core/writing/sectionJudge.js');
      return createRunWritingSectionJudgePacketV1({
        run_id: params.run_id,
        section_index: params.section_index,
        candidates_uri: params.candidates_uri,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_SECTION_JUDGE_DECISION_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit a client-generated JudgeDecision for section selection, enforce hard gates, then run verifiers (M13; fail-fast; local-only).',
    zodSchema: HepRunWritingSubmitSectionJudgeDecisionV1ToolSchema,
    handler: async params => {
      const { submitRunWritingSectionJudgeDecisionV1 } = await import('../core/writing/sectionJudge.js');
      return submitRunWritingSectionJudgeDecisionV1({
        run_id: params.run_id,
        section_index: params.section_index,
        judge_decision_uri: params.judge_decision_uri,
        client_model: params.client_model,
        temperature: params.temperature,
        seed: params.seed,
        quality_eval: params.quality_eval,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a PaperSetCuration prompt_packet artifact for client paperset planning (Evidence-first; writes run artifact; local-only).',
    zodSchema: HepRunWritingCreatePapersetCurationPacketToolSchema,
    handler: async params => {
      const { createRunWritingPaperSetCurationPacket } = await import('../core/writing/papersetCurationPacket.js');
      return createRunWritingPaperSetCurationPacket({
        run_id: params.run_id,
        language: params.language,
        target_length: params.target_length,
        title: params.title,
        topic: params.topic,
        structure_hints: params.structure_hints,
        seed_identifiers: params.seed_identifiers,
        candidate_pool_artifact_name: params.candidate_pool_artifact_name,
        output_artifact_name: params.output_artifact_name,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit a client-generated PaperSetCuration into run artifacts (fail-fast validated; writes writing_paperset_v1.json; local-only).',
    zodSchema: HepRunWritingSubmitPapersetCurationToolSchema,
    handler: async params => {
      const { submitRunWritingPaperSetCuration } = await import('../core/writing/submitPapersetCuration.js');
      return submitRunWritingPaperSetCuration({
        run_id: params.run_id,
        paperset: params.paperset,
        paperset_uri: params.paperset_uri,
        paperset_artifact_name: params.paperset_artifact_name,
        prompt_packet_artifact_name: params.prompt_packet_artifact_name,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create an N-best outline candidates prompt_packet + next_actions (M13; N>=2 hard requirement; Evidence-first; fail-fast; local-only).',
    zodSchema: HepRunWritingCreateOutlineCandidatesPacketV1ToolSchema,
    handler: async params => {
      const { createRunWritingOutlineCandidatesPacketV1 } = await import('../core/writing/outlineCandidates.js');
      return createRunWritingOutlineCandidatesPacketV1({
        run_id: params.run_id,
        language: params.language,
        target_length: params.target_length,
        title: params.title,
        topic: params.topic,
        structure_hints: params.structure_hints,
        user_outline: params.user_outline,
        claims_table_artifact_name: params.claims_table_artifact_name,
        n_candidates: params.n_candidates,
        variation_strategy: params.variation_strategy,
        temperatures: params.temperatures,
        seeds: params.seeds,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit N-best outline candidates (strict validation; writes writing_candidates_outline_v1.json; fail-fast; local-only).',
    zodSchema: HepRunWritingSubmitOutlineCandidatesV1ToolSchema,
    handler: async params => {
      const { submitRunWritingOutlineCandidatesV1 } = await import('../core/writing/outlineCandidates.js');
      return submitRunWritingOutlineCandidatesV1({
        run_id: params.run_id,
        candidates: params.candidates,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a Judge prompt_packet for selecting the best outline candidate (M13; hard gates; Evidence-first; fail-fast; local-only).',
    zodSchema: HepRunWritingCreateOutlineJudgePacketV1ToolSchema,
    handler: async params => {
      const { createRunWritingOutlineJudgePacketV1 } = await import('../core/writing/outlineJudge.js');
      return createRunWritingOutlineJudgePacketV1({
        run_id: params.run_id,
        candidates_uri: params.candidates_uri,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_OUTLINE_JUDGE_DECISION_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit a client-generated JudgeDecision for outline selection, enforce hard gates, then write writing_outline_v2.json (M13; fail-fast; local-only).',
    zodSchema: HepRunWritingSubmitOutlineJudgeDecisionV1ToolSchema,
    handler: async params => {
      const { submitRunWritingOutlineJudgeDecisionV1 } = await import('../core/writing/outlineJudge.js');
      return submitRunWritingOutlineJudgeDecisionV1({
        run_id: params.run_id,
        judge_decision_uri: params.judge_decision_uri,
        client_model: params.client_model,
        temperature: params.temperature,
        seed: params.seed,
      });
    },
  },
  {
    name: HEP_RUN_BUILD_WRITING_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build reusable writing evidence artifacts for a run (LaTeX evidence catalog + embeddings + enrichment; optional PDF evidence; Evidence-first, local-only). NOT FOR end-to-end manuscript drafting; use inspire_deep_research(mode=write) for full writing orchestration.',
    zodSchema: HepRunBuildWritingEvidenceToolSchema,
    handler: async (params, ctx) => {
      const { buildRunWritingEvidence } = await import('../core/writing/evidence.js');
      const raw = ctx.rawArgs ?? {};
      const maxEvidenceItemsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_evidence_items');
      return buildRunWritingEvidence({
        run_id: params.run_id,
        latex_sources: params.latex_sources,
        pdf_source: params.pdf_source,
        continue_on_error: params.continue_on_error,
        latex_types: params.latex_types,
        pdf_types: params.pdf_types,
        max_evidence_items: params.max_evidence_items,
        embedding_dim: params.embedding_dim,
        latex_catalog_artifact_name: params.latex_catalog_artifact_name,
        latex_embeddings_artifact_name: params.latex_embeddings_artifact_name,
        latex_enrichment_artifact_name: params.latex_enrichment_artifact_name,
        pdf_embeddings_artifact_name: params.pdf_embeddings_artifact_name,
        pdf_enrichment_artifact_name: params.pdf_enrichment_artifact_name,
        budget_hints: { max_evidence_items_provided: maxEvidenceItemsProvided },
      });
    },
  },
  {
    name: HEP_RUN_BUILD_MEASUREMENTS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Extract HEP-style numeric measurements from a run LaTeX evidence catalog and write artifacts + diagnostics (Evidence-first, local-only).',
    zodSchema: HepRunBuildMeasurementsToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxResultsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_results');
      return buildRunMeasurements({
        run_id: params.run_id,
        latex_catalog_artifact_name: params.latex_catalog_artifact_name,
        include_types: params.include_types,
        target_quantities: params.target_quantities,
        max_results: params.max_results,
        measurements_artifact_name: params.measurements_artifact_name,
        meta_artifact_name: params.meta_artifact_name,
        budget_hints: { max_results_provided: maxResultsProvided },
      });
    },
  },
  {
    name: HEP_PROJECT_COMPARE_MEASUREMENTS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Compare extracted measurements across multiple runs and flag pairwise tensions (flagging-only; not a world-average combiner; Evidence-first, local-only).',
    zodSchema: HepProjectCompareMeasurementsToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxFlagsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_flags');
      return compareProjectMeasurements({
        run_id: params.run_id,
        input_runs: params.input_runs,
        min_tension_sigma: params.min_tension_sigma,
        max_flags: params.max_flags,
        include_not_comparable: params.include_not_comparable,
        output_artifact_name: params.output_artifact_name,
        budget_hints: { max_flags_provided: maxFlagsProvided },
      });
    },
  },
  {
    name: HEP_RUN_BUILD_WRITING_CRITICAL,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build writing-critical artifacts for a run: conflicts.json, stance.jsonl, evidence_grades.json, and a summary (Evidence-first, local-only)',
    zodSchema: HepRunBuildWritingCriticalToolSchema,
    handler: async params => {
      const { buildRunWritingCritical } = await import('../core/writing/critical.js');
      return buildRunWritingCritical({
        run_id: params.run_id,
        recids: params.recids,
        claims_artifact_name: params.claims_artifact_name,
        conflicts_artifact_name: params.conflicts_artifact_name,
        stance_artifact_name: params.stance_artifact_name,
        evidence_grades_artifact_name: params.evidence_grades_artifact_name,
        summary_artifact_name: params.summary_artifact_name,
        min_tension_sigma: params.min_tension_sigma,
        target_quantities: params.target_quantities,
        include_tables: params.include_tables,
      });
    },
  },
  {
    name: HEP_RUN_BUILD_CITATION_MAPPING,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build bibliography→INSPIRE mapping artifacts for a run (runs locally; uses INSPIRE network) and write `bibliography_raw_v1.json`, `citekey_to_inspire_v1.json`, `allowed_citations_v1.json` (Evidence-first URIs + summary).',
    zodSchema: HepRunBuildCitationMappingToolSchema,
    handler: async params => {
      const run = getRun(params.run_id);

      const stepName = 'citation_mapping';
      const startedAt = new Date().toISOString();
      const toolInfo = {
        name: HEP_RUN_BUILD_CITATION_MAPPING,
        args: { run_id: params.run_id, identifier: params.identifier },
      };

      const computeRunStatus = (manifest: { steps: Array<{ status?: string }> }): RunManifest['status'] => {
        const statuses = manifest.steps.map(s => s.status);
        if (statuses.includes('failed')) return 'failed';
        if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
        return 'done';
      };

      await updateRunManifestAtomic({
        run_id: params.run_id,
        tool: toolInfo,
        update: current => {
          const step = { step: stepName, status: 'in_progress' as const, started_at: startedAt };
          const next = { ...current, updated_at: startedAt, steps: [...current.steps, step] };
          return { ...next, status: computeRunStatus(next) };
        },
      });

      const artifacts: RunArtifactRef[] = [];

      try {
        const { extractBibliography } = await import('./research/extractBibliography.js');
        const bib = await extractBibliography({ identifier: params.identifier });

        const { mapBibEntriesToInspire } = await import('./research/latex/citekeyMapper.js');
        const mappings = await mapBibEntriesToInspire(bib.entries);

        const bibliographyRaw = {
          version: 1 as const,
          generated_at: startedAt,
          source: {
            identifier: params.identifier,
            arxiv_id: bib.arxiv_id,
            source_file: bib.source_file,
          },
          entries: bib.entries,
        };

        const citekeyToInspire = {
          version: 1 as const,
          generated_at: startedAt,
          mappings,
          stats: buildCitekeyToInspireStats(mappings),
        };

        const secondary = Object.values(mappings)
          .flatMap(m => (m.status === 'matched' && m.recid ? [m.recid] : []));

        const allowedCitations = buildAllowedCitationsArtifact({
          include_mapped_references: params.include_mapped_references,
          allowed_citations_primary: params.allowed_citations_primary,
          allowed_citations_secondary: secondary,
        });

        const bibliographyRef = writeRunJsonArtifact(params.run_id, 'bibliography_raw_v1.json', bibliographyRaw);
        const mappingRef = writeRunJsonArtifact(params.run_id, 'citekey_to_inspire_v1.json', citekeyToInspire);
        const allowedRef = writeRunJsonArtifact(params.run_id, 'allowed_citations_v1.json', allowedCitations);

        artifacts.push(bibliographyRef, mappingRef, allowedRef);

        const completedAt = new Date().toISOString();
        await updateRunManifestAtomic({
          run_id: params.run_id,
          tool: toolInfo,
          update: current => {
            const idx = current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
            if (idx < 0) {
              throw invalidParams('Internal: unable to locate citation_mapping run step (fail-fast)', {
                run_id: params.run_id,
                step: stepName,
                started_at: startedAt,
              });
            }
            const byName = new Map<string, RunArtifactRef>();
            for (const a of current.steps[idx]?.artifacts ?? []) byName.set(a.name, a);
            for (const a of artifacts) byName.set(a.name, a);
            const merged = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

            const step = {
              ...current.steps[idx],
              status: 'done' as const,
              completed_at: completedAt,
              artifacts: merged,
            };
            const next = { ...current, updated_at: completedAt, steps: current.steps.map((s, i) => (i === idx ? step : s)) };
            return { ...next, status: computeRunStatus(next) };
          },
        });

        return {
          run_id: params.run_id,
          project_id: run.project_id,
          manifest_uri: `hep://runs/${encodeURIComponent(params.run_id)}/manifest`,
          artifacts,
          summary: {
            bibliography_entries: bib.total,
            mapped_matched: citekeyToInspire.stats.matched,
            mapped_not_found: citekeyToInspire.stats.not_found,
            mapped_errors: citekeyToInspire.stats.errors,
            match_methods: citekeyToInspire.stats.by_method,
            include_mapped_references: params.include_mapped_references,
            allowed_primary: allowedCitations.allowed_citations_primary.length,
            allowed_secondary: allowedCitations.allowed_citations_secondary.length,
            allowed_total: allowedCitations.allowed_citations.length,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          const failedAt = new Date().toISOString();
          await updateRunManifestAtomic({
            run_id: params.run_id,
            tool: toolInfo,
            update: current => {
              const idx = current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
              if (idx < 0) return current;
              const byName = new Map<string, RunArtifactRef>();
              for (const a of current.steps[idx]?.artifacts ?? []) byName.set(a.name, a);
              for (const a of artifacts) byName.set(a.name, a);
              const merged = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

              const step = {
                ...current.steps[idx],
                status: 'failed' as const,
                completed_at: failedAt,
                artifacts: merged,
                notes: message,
              };
              const next = { ...current, updated_at: failedAt, steps: current.steps.map((s, i) => (i === idx ? step : s)) };
              return { ...next, status: computeRunStatus(next) };
            },
          });
        } catch {
          // ignore secondary failures
        }
        throw err;
      }
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_REVIEW,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit a client-generated reviewer report for a completed run write (Evidence-first: writes run artifacts; local-only).',
    zodSchema: HepRunWritingSubmitReviewToolSchema,
    handler: async params => {
      const { submitRunWritingReview } = await import('../core/writing/submitReview.js');
      return submitRunWritingReview({
        run_id: params.run_id,
        round: params.round,
        reviewer_report: params.reviewer_report,
        reviewer_report_uri: params.reviewer_report_uri,
        client_model: params.client_model,
        temperature: params.temperature,
        seed: params.seed,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a RevisionPlanV1 prompt_packet for client revision planning (requires ReviewerReport v2; Evidence-first; local-only).',
    zodSchema: HepRunWritingCreateRevisionPlanPacketV1ToolSchema,
    handler: async params => {
      const { createRunWritingRevisionPlanPacketV1 } = await import('../core/writing/revisionPlanPacket.js');
      return createRunWritingRevisionPlanPacketV1({
        reviewer_report_uri: params.reviewer_report_uri,
        manifest_uri: params.manifest_uri,
        quality_policy_uri: params.quality_policy_uri,
        round: params.round,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit a client-generated RevisionPlan v1 into run artifacts (fail-fast validated; writes writing_revision_plan_round_XX_v1.json; local-only).',
    zodSchema: HepRunWritingSubmitRevisionPlanV1ToolSchema,
    handler: async params => {
      const { submitRunWritingRevisionPlanV1 } = await import('../core/writing/submitRevisionPlan.js');
      return submitRunWritingRevisionPlanV1({
        run_id: params.run_id,
        revision_plan: params.revision_plan,
        revision_plan_uri: params.revision_plan_uri,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_REFINEMENT_ORCHESTRATOR_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Advance one writing refinement round state machine step (Review → RevisionPlan → Execute → Re-verify → Integrate → Repeat) (Evidence-first; fail-fast; local-only).',
    zodSchema: HepRunWritingRefinementOrchestratorV1ToolSchema,
    handler: async params => {
      const { advanceRunWritingRefinementOrchestratorV1 } = await import('../core/writing/refinementOrchestrator.js');
      return advanceRunWritingRefinementOrchestratorV1({
        run_id: params.run_id,
        round: params.round,
        reviewer_report_uri: params.reviewer_report_uri,
        revision_plan_uri: params.revision_plan_uri,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Integrate run writing_section_*.json into writing_integrated.tex + diagnostics and run LaTeX compile gate (fail-fast; Evidence-first; local-only).',
    zodSchema: HepRunWritingIntegrateSectionsV1ToolSchema,
    handler: async params => {
      const { integrateWritingSections } = await import('../core/writing/integrate.js');
      return integrateWritingSections({
        run_id: params.run_id,
        fix_unused_materials: params.fix_unused_materials,
        add_cross_references: params.add_cross_references,
        unify_terminology: params.unify_terminology,
        final_polish: params.final_polish,
        max_retries: params.max_retries,
      });
    },
  },
  {
    name: HEP_RENDER_LATEX,
    tier: 'core',
    exposure: 'standard',
    description:
      'Render structured SectionDraft/ReportDraft into LaTeX, enforce allowed_citations via citation verifier, and write artifacts (Evidence-first, local-only)',
    zodSchema: HepRenderLatexToolSchema,
    handler: async params => renderLatexForRun({
      run_id: params.run_id,
      draft: params.draft,
      allowed_citations: params.allowed_citations,
      cite_mapping: params.cite_mapping,
      latex_artifact_name: params.latex_artifact_name,
      section_output_artifact_name: params.section_output_artifact_name,
      verification_artifact_name: params.verification_artifact_name,
    }),
  },
  {
    name: HEP_EXPORT_PROJECT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export run outputs as research assets: master.bib, report.tex, report.md, research_pack.zip, and NotebookLM-friendly artifacts (Evidence-first, local-only)',
    zodSchema: HepExportProjectToolSchema,
    handler: async params => exportProjectForRun({
      run_id: params.run_id,
      rendered_latex_artifact_name: params.rendered_latex_artifact_name,
      rendered_latex_verification_artifact_name: params.rendered_latex_verification_artifact_name,
      bibliography_raw_artifact_name: params.bibliography_raw_artifact_name,
      master_bib_artifact_name: params.master_bib_artifact_name,
      report_tex_artifact_name: params.report_tex_artifact_name,
      report_md_artifact_name: params.report_md_artifact_name,
      research_pack_zip_artifact_name: params.research_pack_zip_artifact_name,
      notebooklm_pack_prefix: params.notebooklm_pack_prefix,
      max_chars_per_notebooklm_file: params.max_chars_per_notebooklm_file,
      include_evidence_digests: params.include_evidence_digests,
      include_pdg_artifacts: params.include_pdg_artifacts,
      include_paper_bundle: params.include_paper_bundle,
      paper_bundle_zip_artifact_name: params.paper_bundle_zip_artifact_name,
      paper_bundle_manifest_artifact_name: params.paper_bundle_manifest_artifact_name,
    }),
  },
  {
    name: HEP_EXPORT_PAPER_SCAFFOLD,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export a publication-ready paper/ scaffold for a run (RevTeX4-2): materialize LaTeX + bib split into paper/ and write a portable paper_scaffold.zip (Evidence-first; local-only).',
    zodSchema: HepExportPaperScaffoldToolSchema,
    handler: async params => exportPaperScaffoldForRun({
      run_id: params.run_id,
      output_dir_name: params.output_dir_name,
      overwrite: params.overwrite,
      integrated_latex_artifact_name: params.integrated_latex_artifact_name,
      writing_master_bib_artifact_name: params.writing_master_bib_artifact_name,
      bibliography_raw_artifact_name: params.bibliography_raw_artifact_name,
      zip_artifact_name: params.zip_artifact_name,
      paper_manifest_artifact_name: params.paper_manifest_artifact_name,
    }),
  },
  {
    name: HEP_IMPORT_PAPER_BUNDLE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Import a finalized paper/ (post research-writer) back into a run as portable artifacts (paper_bundle.zip + paper_bundle_manifest.json + optional paper_final.pdf) (Evidence-first; local-only).',
    zodSchema: HepImportPaperBundleToolSchema,
    handler: async params => importPaperBundleForRun({
      run_id: params.run_id,
      paper_dir_name: params.paper_dir_name,
      zip_artifact_name: params.zip_artifact_name,
      bundle_manifest_artifact_name: params.bundle_manifest_artifact_name,
      pdf_artifact_name: params.pdf_artifact_name,
      overwrite: params.overwrite,
      dereference_symlinks: params.dereference_symlinks,
      allow_external_symlink_targets: params.allow_external_symlink_targets,
    }),
  },
  ...(ZOTERO_INTEGRATION_ENABLED
    ? ([
        {
          name: HEP_IMPORT_FROM_ZOTERO,
          tier: 'core',
          exposure: 'standard',
          description:
            'Import Zotero items into a run mapping (Zotero item → identifiers → INSPIRE recid). Requires Zotero Local API; resolves via INSPIRE when needed (network) and writes `zotero_map_v1.json` artifact (Evidence-first).',
          zodSchema: HepImportFromZoteroToolSchema,
          handler: async (params, ctx) => {
            const raw = ctx.rawArgs ?? {};
            const concurrencyProvided = Object.prototype.hasOwnProperty.call(raw, 'concurrency');
            const result = await hepImportFromZotero({
              run_id: params.run_id,
              collection_key: params.collection_key,
              item_keys: params.item_keys,
              limit: params.limit,
              start: params.start,
              concurrency: params.concurrency,
              budget_hints: { concurrency_provided: concurrencyProvided },
            });
            // NEW-CONN-01: suggest deep research after import (recids are in artifact, not return;
            // emit a generic hint when any items were resolved)
            const hasResolved = result.summary?.resolved_recids > 0;
            if (hasResolved) {
              return withNextActions(result, [{
                tool: INSPIRE_DEEP_RESEARCH,
                args: { mode: 'analyze', run_id: result.run_id },
                reason: 'Analyze the imported papers. Read zotero_map_v1.json artifact for recids.',
              }]);
            }
            return result;
          },
        },
      ] satisfies Omit<ToolSpec, 'riskLevel'>[])
    : []),
  // NOTE: Zotero tool specs are imported from `@autoresearch/zotero-mcp/tooling` (built output).
  ...(ZOTERO_INTEGRATION_ENABLED
    ? ZOTERO_TOOL_SPECS.map(
        (spec): Omit<ToolSpec, 'riskLevel'> => ({
          name: spec.name,
          tier: 'consolidated',
          exposure: spec.exposure,
          description: (() => {
            const d = String(spec.description ?? '').trim();
            if (!d) return d;
            const needsLocal = !/\blocal-only\b/i.test(d);
            if (!needsLocal) return d;
            const base = d.replace(/\.\s*$/, '');
            return `${base} (local-only).`;
          })(),
          zodSchema: spec.zodSchema,
          handler: spec.handler as unknown as ToolSpec['handler'],
        })
      )
    : []),
  {
    name: HEP_RUN_BUILD_PDF_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build PDF evidence for a run (text pages + optional visual region snippets) and write artifacts (Evidence-first, local-only)',
    zodSchema: HepRunBuildPdfEvidenceToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxPagesProvided = Object.prototype.hasOwnProperty.call(raw, 'max_pages');
      const maxRegionsTotalProvided = Object.prototype.hasOwnProperty.call(raw, 'max_regions_total');
      return buildRunPdfEvidence({
        run_id: params.run_id,
        pdf_path: params.pdf_path,
        pdf_artifact_name: params.pdf_artifact_name,
        zotero_attachment_key: params.zotero_attachment_key,
        fulltext_artifact_name: params.fulltext_artifact_name,
        docling_json_path: params.docling_json_path,
        docling_json_artifact_name: params.docling_json_artifact_name,
        mode: params.mode,
        max_pages: params.max_pages,
        render_dpi: params.render_dpi,
        output_prefix: params.output_prefix,
        max_regions_total: params.max_regions_total,
        budget_hints: {
          max_pages_provided: maxPagesProvided,
          max_regions_total_provided: maxRegionsTotalProvided,
        },
      });
    },
  },
  {
    name: HEP_RUN_BUILD_EVIDENCE_INDEX_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build LaTeX EvidenceChunks + BM25 index for a run (fail-fast; no PDF fallback) and write artifacts (Evidence-first)',
    zodSchema: HepRunBuildEvidenceIndexV1ToolSchema,
    handler: async params => {
      const { buildRunEvidenceIndexV1 } = await import('../core/writing/evidenceIndex.js');
      return buildRunEvidenceIndexV1({
        run_id: params.run_id,
        paper_ids: params.paper_ids,
        output_artifact_name: params.output_artifact_name,
        metrics_artifact_name: params.metrics_artifact_name,
        paper_cache_prefix: params.paper_cache_prefix,
        force_rebuild: params.force_rebuild,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build per-section retrieval candidates, run LLM rerank (client/internal), and write `writing_evidence_packet_section_###_v2.json` (fail-fast; no BM25 fallback; Evidence-first).',
    zodSchema: HepRunWritingBuildEvidencePacketSectionV2ToolSchema,
    handler: async params => {
      const { buildRunWritingEvidencePacketSectionV2 } = await import('../core/writing/evidenceSelection.js');
      return buildRunWritingEvidencePacketSectionV2({
        run_id: params.run_id,
        section_index: params.section_index,
        llm_mode: params.llm_mode,
        evidence_index_artifact_name: params.evidence_index_artifact_name,
        outline_artifact_name: params.outline_artifact_name,
        claims_table_artifact_name: params.claims_table_artifact_name,
        max_queries: params.max_queries,
        section_title: params.section_title,
        section_type: params.section_type,
        queries: params.queries,
        claim_ids: params.claim_ids,
        token_budget_plan_artifact_name: params.token_budget_plan_artifact_name,
        max_context_tokens: params.max_context_tokens,
        reserved_output_tokens: params.reserved_output_tokens,
        safety_margin_tokens: params.safety_margin_tokens,
        top_k_per_query: params.top_k_per_query,
        max_candidates: params.max_candidates,
        rerank_top_k: params.rerank_top_k,
        rerank_output_top_n: params.rerank_output_top_n,
        max_chunk_chars: params.max_chunk_chars,
        max_selected_chunks: params.max_selected_chunks,
        max_total_tokens: params.max_total_tokens,
        max_chunks_per_source: params.max_chunks_per_source,
        min_sources: params.min_sources,
        min_per_query: params.min_per_query,
        output_candidates_artifact_name: params.output_candidates_artifact_name,
        output_rerank_packet_artifact_name: params.output_rerank_packet_artifact_name,
        output_rerank_prompt_artifact_name: params.output_rerank_prompt_artifact_name,
        output_rerank_raw_artifact_name: params.output_rerank_raw_artifact_name,
        output_rerank_result_artifact_name: params.output_rerank_result_artifact_name,
        output_packet_artifact_name: params.output_packet_artifact_name,
      });
    },
  },
  {
    name: HEP_RUN_WRITING_SUBMIT_RERANK_RESULT_V1,
    tier: 'core',
    exposure: 'standard',
    description:
      'Submit client LLM rerank indices (for a previously generated rerank packet) and write `writing_rerank_result_section_###_v1.json` + `writing_evidence_packet_section_###_v2.json` (fail-fast; no BM25 fallback; Evidence-first).',
    zodSchema: HepRunWritingSubmitRerankResultV1ToolSchema,
    handler: async params => {
      const { submitRunWritingRerankResultV1 } = await import('../core/writing/evidenceSelection.js');
      return submitRunWritingRerankResultV1({
        run_id: params.run_id,
        section_index: params.section_index,
        rerank_packet_artifact_name: params.rerank_packet_artifact_name,
        ranked_indices: params.ranked_indices,
        token_budget_plan_artifact_name: params.token_budget_plan_artifact_name,
        max_context_tokens: params.max_context_tokens,
        reserved_output_tokens: params.reserved_output_tokens,
        safety_margin_tokens: params.safety_margin_tokens,
        output_rerank_raw_artifact_name: params.output_rerank_raw_artifact_name,
        output_rerank_result_artifact_name: params.output_rerank_result_artifact_name,
        output_packet_artifact_name: params.output_packet_artifact_name,
      });
    },
  },
  {
    name: HEP_INSPIRE_SEARCH_EXPORT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export an INSPIRE search (safe pagination) to run artifacts (jsonl/json). Network (INSPIRE) + Evidence-first output (URIs + summary).',
    zodSchema: HepInspireSearchExportToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const sizeProvided = Object.prototype.hasOwnProperty.call(raw, 'size');
      const maxResultsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_results');
      return hepInspireSearchExport({
        run_id: params.run_id,
        query: params.query,
        sort: params.sort,
        size: params.size,
        max_results: params.max_results,
        output_format: params.output_format,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
        budget_hints: {
          size_provided: sizeProvided,
          max_results_provided: maxResultsProvided,
        },
      });
    },
  },
  {
    name: HEP_INSPIRE_RESOLVE_IDENTIFIERS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Batch resolve identifiers (recid/arXiv/DOI) to INSPIRE recids and write mapping artifacts (network; Evidence-first URIs + summary).',
    zodSchema: HepInspireResolveIdentifiersToolSchema,
    handler: async params =>
      hepInspireResolveIdentifiers({
        run_id: params.run_id,
        identifiers: params.identifiers,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
      }),
  },

  // Tier 1: Core tools
  {
    name: INSPIRE_SEARCH,
    tier: 'core',
    exposure: 'standard',
    description: `Search INSPIRE-HEP literature database (network). Supports combining multiple conditions in one query.

Note: Some MCP clients prefix tool names (e.g. \`mcp__hep__inspire_search\`); always use the exact tool name shown by your client.

Author search: Use "a:lastname, firstname" or BAI format "a:Feng.Kun.Guo.1". Do NOT use quotes around author names.

Author disambiguation tip (IMPORTANT for common names):
- Prefer INSPIRE BAI when available: \`a:E.Witten.1\` (stable unique author identifier).
- If you only have a name, first call \`inspire_literature\` with \`mode=get_author\` to obtain \`bai\`, then search with \`a:<bai>\`.

Full-text search: Use "fulltext:" to search paper content (not just metadata).
- fulltext:"dark matter detection" - search for exact phrase in paper text
- fulltext:WIMP AND t:direct - combine full-text with title search

Common search operators:
- a: author (e.g., "a:guo, feng-kun" or "a:Feng.Kun.Guo.1")
- fa: first author (e.g., "fa:witten")
- t: title (e.g., "t:pentaquark")
- fulltext: full-text search (e.g., "fulltext:lattice QCD")
- topcite: citation count (e.g., "topcite:250+" for >=250 citations)
- authorcount: author count (e.g., "authorcount:1->10" for 1-10 authors)
- date: date range (e.g., "date:2020->2024")
- j: journal (e.g., "j:Phys.Rev.D")
- eprint: arXiv ID (e.g., "eprint:2301.12345")
- primarch: primary arXiv category (e.g., "primarch:hep-ph", "primarch:hep-th")
- cn: collaboration (e.g., "cn:LHCb")
- aff: affiliation (e.g., "aff:CERN")
- tc: document type (p=published, c=conference, r=review, t=thesis)

Review paper handling via \`review_mode\`:
- mixed (default): keep result order
- exclude: remove review papers
- deprioritize/separate: move review papers to the end

Example combined query: "a:Feng.Kun.Guo.1 topcite:250+ authorcount:1->10"`,
    zodSchema: InspireSearchToolSchema,
    handler: async params => {
      const query = preprocessQuery(params.query);
      const result = await api.search(query, {
        sort: params.sort,
        size: params.size,
        page: params.page,
      });

      const applyReviewMode = (r: typeof result) => {
        if (params.review_mode === 'mixed' || r.papers.length === 0) return r;
        // classifyPapers is lazy-loaded for cost reasons
        return getClassifyPapers().then(classifyPapersFn => {
          const classified = classifyPapersFn(r.papers) as Array<{ is_review?: boolean }>;
          const nonReviews = classified.filter(p => !p.is_review);
          const reviews = classified.filter(p => p.is_review);
          if (params.review_mode === 'exclude') {
            return { ...r, papers: nonReviews as typeof r.papers, total: nonReviews.length };
          }
          return { ...r, papers: [...nonReviews, ...reviews] as typeof r.papers };
        });
      };

      const final = await applyReviewMode(result);
      // NEW-CONN-01: attach discovery next_actions hints
      return withNextActions(final, discoveryNextActions(final.papers));
    },
  },
  {
    name: INSPIRE_SEARCH_NEXT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Follow an INSPIRE `next_url` returned by `inspire_search` with strict same-origin checks (network; avoids arbitrary URL fetch).',
    zodSchema: InspireSearchNextToolSchema,
    handler: async params => {
      const result = await api.searchByUrl(params.next_url, { max_page_size: 100 });

      if (params.review_mode === 'mixed' || result.papers.length === 0) {
        return result;
      }

      const classifyPapersFn = await getClassifyPapers();
      const classified = classifyPapersFn(result.papers) as Array<{ is_review?: boolean }>;
      const nonReviews = classified.filter(p => !p.is_review);
      const reviews = classified.filter(p => p.is_review);

      if (params.review_mode === 'exclude') {
        return { ...result, papers: nonReviews as typeof result.papers, total: nonReviews.length };
      }

      return { ...result, papers: [...nonReviews, ...reviews] as typeof result.papers };
    },
  },
  {
    name: INSPIRE_LITERATURE,
    tier: 'consolidated',
    exposure: 'standard',
    description: `Unified INSPIRE literature access tool (network).

Modes + required args:
- get_paper: { recid }
- get_references: { recid, size? }
- lookup_by_id: { identifier } // identifier can be a recid, DOI (10.x), or arXiv id; tool auto-routes
- get_citations: { recid, size?, sort? } // IMPORTANT: use recid (not identifier); use size (not options.limit)
- search_affiliation: { affiliation, size?, sort? }
- get_bibtex: { recids }
- get_author: { identifier } // identifier can be INSPIRE BAI (e.g. E.Witten.1), ORCID, or a name query; returns \`bai\` for disambiguation.

Tip: For ambiguous names, call \`get_author\` first, then use \`inspire_search\` with \`query=\"a:<bai>\"\`.`,
    zodSchema: InspireLiteratureToolSchema,
    handler: async params => {
      switch (params.mode) {
        case 'get_paper':
          return api.getPaper(params.recid!);
        case 'get_references':
          return api.getReferences(params.recid!, params.size);
        case 'lookup_by_id': {
          const identifier = params.identifier!;
          if (/^\d+$/.test(identifier)) return api.getPaper(identifier);
          if (identifier.startsWith('10.')) return api.getByDoi(identifier);
          return api.getByArxiv(identifier);
        }
        case 'get_citations':
          return api.getCitations(params.recid!, { sort: params.sort, size: params.size ?? 25 });
        case 'search_affiliation':
          return api.search(`aff:${params.affiliation!}`, { sort: params.sort, size: params.size ?? 25 });
        case 'get_bibtex':
          return api.getBibtex(params.recids!);
        case 'get_author':
          return api.getAuthor(params.identifier!);
        default:
          throw new Error(`Unknown inspire_literature mode: ${String((params as { mode?: unknown }).mode)}`);
      }
    },
  },
  {
    name: INSPIRE_RESOLVE_CITEKEY,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Resolve INSPIRE BibTeX citekey + BibTeX + canonical links for recid(s) (network). Returns {results:[{recid,citekey,bibtex,links:{inspire,doi?,arxiv?}}]}.',
    zodSchema: InspireResolveCitekeyToolSchema,
    handler: async params => {
      const rawRecids = [
        ...(Array.isArray(params.recids) ? params.recids : []),
        ...(typeof params.recid === 'string' ? [params.recid] : []),
      ]
        .map(r => String(r).trim())
        .filter(r => r.length > 0);

      const uniqueRecids = Array.from(new Set(rawRecids));

      const [papers, bulkBibtex] = await Promise.all([
        api.batchGetPapers(uniqueRecids),
        api.getBibtex(uniqueRecids),
      ]);
      const paperByRecid = new Map(papers.map(p => [p.recid, p]));

      const bibtexByCitekey = new Map<string, string>();
      {
        const cleaned = String(bulkBibtex ?? '')
          .replace(/^\uFEFF/, '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();
        const re = /^\s*@/gm;
        const starts: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(cleaned)) !== null) {
          starts.push(m.index);
        }
        for (let i = 0; i < starts.length; i += 1) {
          const start = starts[i]!;
          const end = i + 1 < starts.length ? starts[i + 1]! : cleaned.length;
          const block = cleaned.slice(start, end).trim();
          if (!block) continue;
          const key = extractKeyFromBibtex(block);
          if (!key) continue;
          if (!bibtexByCitekey.has(key)) {
            bibtexByCitekey.set(key, block);
          }
        }
      }

      const results: Array<{
        recid: string;
        citekey: string;
        bibtex: string;
        links: { inspire: string; doi?: string; arxiv?: string };
      }> = [];

      for (const recid of uniqueRecids) {
        const links: { inspire: string; doi?: string; arxiv?: string } = {
          inspire: `https://inspirehep.net/literature/${recid}`,
        };

        const paper = paperByRecid.get(recid);
        if (paper?.doi_url) links.doi = paper.doi_url;
        if (paper?.arxiv_url) links.arxiv = paper.arxiv_url;

        const expectedTexkey = typeof paper?.texkey === 'string' ? paper.texkey.trim() : '';

        const bibtexFromBulk = expectedTexkey ? bibtexByCitekey.get(expectedTexkey) : undefined;
        if (bibtexFromBulk) {
          const extracted = extractKeyFromBibtex(bibtexFromBulk);
          if (!extracted) {
            throw invalidParams(`Could not extract BibTeX entry key for citekey=${expectedTexkey}`, {
              recid,
              citekey: expectedTexkey,
              bibtex_preview: bibtexFromBulk.slice(0, 240),
            });
          }
          if (extracted !== expectedTexkey) {
            throw invalidParams(`BibTeX entry key mismatch for recid=${recid}`, {
              recid,
              expected_citekey: expectedTexkey,
              extracted_citekey: extracted,
              bibtex_preview: bibtexFromBulk.slice(0, 240),
            });
          }
          results.push({ recid, citekey: expectedTexkey, bibtex: bibtexFromBulk, links });
          continue;
        }

        // Fallback: fetch the specific record and extract key from returned BibTeX.
        const bibtex = String(await api.getBibtex([recid])).trim();
        const citekey = extractKeyFromBibtex(bibtex);
        if (!citekey) {
          throw invalidParams(`Could not extract BibTeX entry key for recid=${recid}`, {
            recid,
            bibtex_preview: bibtex.slice(0, 240),
          });
        }
        if (expectedTexkey && citekey !== expectedTexkey) {
          throw invalidParams(`INSPIRE texkey mismatch for recid=${recid}`, {
            recid,
            expected_citekey: expectedTexkey,
            extracted_citekey: citekey,
          });
        }

        results.push({ recid, citekey, bibtex, links });
      }

      return { results };
    },
  },

  // Tier 2: Consolidated tools
  {
    name: INSPIRE_PARSE_LATEX,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Parse LaTeX content and extract selected components into a run artifact (Evidence-first; writes `parse_latex_<hash>.json`; network).',
    zodSchema: InspireParseLatexToolSchema,
    handler: async params => {
      const { parseLatexContent } = await import('./research/parseLatexContent.js');
      const hash = hashParseLatexRequest({
        identifier: params.identifier,
        components: params.components,
        options: params.options,
      });
      const artifactName = `parse_latex_${hash}.json`;
      const generatedAt = new Date().toISOString();

      try {
        const result = await parseLatexContent({
          identifier: params.identifier,
          components: params.components,
          options: params.options,
        });

        const ref = writeRunJsonArtifact(params.run_id, artifactName, {
          version: 1,
          generated_at: generatedAt,
          run_id: params.run_id,
          tool: INSPIRE_PARSE_LATEX,
          request: {
            identifier: params.identifier,
            components: params.components,
            options: params.options ?? null,
          },
          result,
        });

        return {
          uri: ref.uri,
          summary: {
            artifact_name: ref.name,
            run_id: params.run_id,
            identifier: params.identifier,
            components: params.components,
            metadata: {
              arxiv_id: result.metadata.arxiv_id,
              source_file: result.metadata.source_file,
              title: result.metadata.title,
            },
            counts: result.summary.counts,
          },
        };
      } catch (err) {
        if (isNoLatexSourceError(err)) {
          const message = err instanceof Error ? err.message : String(err);
          throw notFound(message, {
            run_id: params.run_id,
            identifier: params.identifier,
            components: params.components,
          });
        }
        throw err;
      }
    },
  },
  {
    name: INSPIRE_RESEARCH_NAVIGATOR,
    tier: 'consolidated',
    exposure: 'standard',
    intent: 'paper_discovery',
    maturity: 'stable',
    description:
      'Unified research navigation tool (network). Modes: discover/field_survey/topic_analysis/network/experts/connections/trace_source/analyze. NOT FOR deep write pipeline; use inspire_deep_research(mode=write) for full writing orchestration.',
    zodSchema: ResearchNavigatorToolSchema,
    handler: async params => {
      const result = await (async () => {
        switch (params.mode) {
          case 'discover': {
            const { discoverPapers } = await import('./research/discoverPapers.js');
            return discoverPapers({
              mode: params.discover_mode!,
              topic: params.topic,
              seed_recids: params.seed_recids,
              limit: params.limit,
              options: params.discover_options,
            });
          }
          case 'field_survey': {
            const { performFieldSurvey } = await import('./research/fieldSurvey.js');
            return performFieldSurvey({
              topic: params.topic!,
              seed_recid: params.seed_recid,
              iterations: params.iterations,
              max_papers: params.limit,
              focus: params.focus,
              prefer_journal: params.prefer_journal,
            });
          }
          case 'topic_analysis': {
            const { analyzeTopicUnified } = await import('./research/topicAnalysis.js');
            return analyzeTopicUnified({
              topic: params.topic!,
              mode: params.topic_mode!,
              time_range: params.time_range,
              limit: params.limit,
              options: params.topic_options,
            });
          }
          case 'network': {
            const { analyzeNetwork } = await import('./research/networkAnalysis.js');
            return analyzeNetwork({
              mode: params.network_mode!,
              seed: params.seed!,
              limit: params.limit,
              options: params.network_options,
            });
          }
          case 'experts': {
            const { findExperts } = await import('./research/experts.js');
            const res = await findExperts({ topic: params.topic!, limit: params.limit ?? 10 });
            if (params.format === 'markdown') {
              return formatExpertsMarkdown(res.topic, res.experts);
            }
            return res;
          }
          case 'connections': {
            const { findConnections } = await import('./research/findConnections.js');
            const recids = params.seed_recids ?? (params.seed ? [params.seed] : []);
            return findConnections({
              recids,
              include_external: params.include_external,
              max_external_depth: params.max_external_depth,
            });
          }
          case 'trace_source': {
            const { traceOriginalSource } = await import('./research/traceSource.js');
            const recid = params.seed ?? params.seed_recids?.[0];
            return traceOriginalSource({
              recid: recid!,
              max_depth: params.max_depth,
              max_refs_per_level: params.max_refs_per_level,
              cross_validate: params.cross_validate,
            });
          }
          case 'analyze': {
            const { analyzePapers } = await import('./research/analyzePapers.js');
            const recids = params.recids ?? params.seed_recids ?? (params.seed ? [params.seed] : []);
            return analyzePapers({ recids, analysis_type: params.analysis_type });
          }
          default:
            throw new Error(`Unknown inspire_research_navigator mode: ${String((params as { mode?: unknown }).mode)}`);
        }
      })();
      // NEW-CONN-01: attach discovery next_actions hints
      const papers = result && typeof result === 'object' && 'papers' in result
        ? (result as Record<string, unknown>).papers
        : undefined;
      return withNextActions(result, discoveryNextActions(papers));
    },
  },
  {
    name: INSPIRE_CRITICAL_RESEARCH,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Unified critical research tool (network). Modes: evidence/conflicts/analysis/reviews/theoretical. NOT FOR broad paper discovery/navigation; use inspire_research_navigator for discovery workflows.',
    zodSchema: CriticalResearchToolSchema,
    handler: async params => {
      const { performCriticalResearch } = await import('./research/criticalResearch.js');
      const result = await performCriticalResearch(params);

      // H-13 L2: mode=evidence/analysis → write artifact + return URI + summary if run_id
      if ((params.mode === 'evidence' || params.mode === 'analysis') && params.run_id) {
        const artifactName = `critical_${params.mode}_result.json`;
        const ref = writeRunJsonArtifact(params.run_id, artifactName, { version: 1, ...result });
        const modeResult = result && typeof result === 'object'
          ? (result as unknown as Record<string, unknown>)[params.mode] as Record<string, unknown> | undefined
          : undefined;

        const summary: Record<string, unknown> = { mode: params.mode };
        if (params.mode === 'evidence' && modeResult) {
          summary.claim_count = modeResult.claim_count ?? modeResult.total_claims ?? 0;
          summary.grade_distribution = modeResult.grade_distribution ?? {};
        }
        if (params.mode === 'analysis' && modeResult) {
          summary.assumption_count = modeResult.assumption_count ?? 0;
          summary.open_question_count = modeResult.open_question_count ?? 0;
        }

        return { artifact_uri: ref.uri, summary };
      }

      return result;
    },
  },
  {
    name: INSPIRE_PAPER_SOURCE,
    tier: 'consolidated',
    exposure: 'standard',
    description: `Unified paper source access tool (network). Modes: urls/content/metadata/auto (downloads arXiv sources/PDFs and optionally extracts).

- 'urls': Only return download URLs without downloading (fast check)
- 'content': Actually download and extract paper source (LaTeX or PDF). Use this mode to download arXiv LaTeX source.
- 'metadata': Get arXiv metadata and source availability info
- 'auto': Get URLs first with availability check, but does NOT automatically download

To download arXiv LaTeX source, use mode='content' with options.prefer='latex' and options.extract=true.

Safety: if you set options.output_dir, it must be within HEP_DATA_DIR. Prefer a relative output_dir (e.g. "arxiv_sources/<arxiv_id>"); relative paths are resolved under HEP_DATA_DIR. Or set HEP_DATA_DIR to change the root.`,
    zodSchema: PaperSourceToolSchema,
    handler: async params => {
      const { accessPaperSource } = await import('./research/paperSource.js');
      return accessPaperSource(params);
    },
  },
  {
    name: INSPIRE_DEEP_RESEARCH,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'End-to-end deep research pipeline over a paper set. Modes: analyze/synthesize/write. write mode is Evidence-first via `run_id` (writes artifacts/URIs; network) and supports resume via `resume_from`. NOT FOR lightweight discovery-only requests; use inspire_research_navigator for discovery workflows.',
    zodSchema: DeepResearchToolSchema,
    handler: async (params, ctx) => {
      const { performDeepResearch } = await import('./research/deepResearch.js');
      const result = await performDeepResearch({
        ...params,
        _mcp: ctx.reportProgress ? { reportProgress: ctx.reportProgress } : undefined,
      });

      // H-13 L2: mode=analyze/synthesize → write artifact + return URI + summary
      if (params.mode === 'analyze' && params.run_id) {
        const ref = writeRunJsonArtifact(params.run_id, 'deep_analyze_result_v1.json', { version: 1, ...result });
        const analysis = result && typeof result === 'object' && 'analysis' in result
          ? (result as unknown as Record<string, unknown>).analysis as Record<string, unknown> | undefined
          : undefined;
        return {
          artifact_uri: ref.uri,
          summary: {
            paper_count: analysis?.paper_count ?? (Array.isArray(params.identifiers) ? params.identifiers.length : 0),
            equations_found: analysis?.equations_found ?? analysis?.total_equations ?? 0,
            key_findings: Array.isArray(analysis?.key_findings)
              ? (analysis.key_findings as unknown[]).slice(0, 3)
              : [],
          },
          next_actions: deepResearchAnalyzeNextActions(params.identifiers),
        };
      }

      if (params.mode === 'synthesize' && params.run_id) {
        const ref = writeRunJsonArtifact(params.run_id, 'deep_synthesize_result_v1.json', { version: 1, ...result });
        const review = result && typeof result === 'object' && 'review' in result
          ? (result as unknown as Record<string, unknown>).review as Record<string, unknown> | undefined
          : undefined;
        return {
          artifact_uri: ref.uri,
          summary: {
            theme_count: review?.theme_count ?? review?.total_themes ?? 0,
            paper_count: review?.paper_count ?? (Array.isArray(params.identifiers) ? params.identifiers.length : 0),
            open_questions: Array.isArray(review?.open_questions)
              ? (review.open_questions as unknown[]).slice(0, 5)
              : [],
          },
        };
      }

      // NEW-CONN-01: mode=analyze (no run_id) → suggest synthesize/write with run_id hint
      if (params.mode === 'analyze') {
        return withNextActions(result, deepResearchAnalyzeNextActions(params.identifiers));
      }
      return result;
    },
  },
  // Full-only whitelist tools
  {
    name: INSPIRE_FIND_CROSSOVER_TOPICS,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Discover emerging interdisciplinary research areas by analyzing papers spanning multiple arXiv categories (network).',
    zodSchema: FindCrossoverTopicsToolSchema,
    handler: async params => {
      const { findCrossoverTopics } = await import('./research/crossoverTopics.js');
      return findCrossoverTopics(params);
    },
  },
  {
    name: INSPIRE_ANALYZE_CITATION_STANCE,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Analyze how a paper cites another paper (stance detection; resolves citekeys via INSPIRE as needed; network).',
    zodSchema: AnalyzeCitationStanceToolSchema,
    handler: async params => {
      const { analyzeStanceFromLatex } = await import('./research/stance/index.js');
      return analyzeStanceFromLatex({
        latexContent: params.latex_content,
        targetRecid: params.target_recid,
        bibContent: params.bib_content,
        options: { maxContexts: params.max_contexts },
      });
    },
  },
  {
    name: INSPIRE_CLEANUP_DOWNLOADS,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Delete cached arXiv source download directories created by this server (marker-checked). Supports `dry_run`, `older_than_hours`, and `arxiv_id` filtering (local-only).',
    zodSchema: CleanupDownloadsToolSchema,
    handler: async params => {
      const { cleanupDownloads } = await import('./research/cleanupDownloads.js');
      return cleanupDownloads(params);
    },
  },
  {
    name: INSPIRE_VALIDATE_BIBLIOGRAPHY,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Usability-first bibliography audit for a paper (default: manual non-INSPIRE entries only). Optionally cross-validate against INSPIRE; warnings are non-blocking (network for INSPIRE mode).',
    zodSchema: ValidateBibliographyToolSchema,
    handler: async params => {
      const { validateBibliography } = await import('./research/validateBibliography.js');
      return validateBibliography(params);
    },
  },

  // Style corpus tools (RMP 起步; Evidence-first)
  {
    name: INSPIRE_STYLE_CORPUS_QUERY,
    tier: 'writing',
    exposure: 'standard',
    description: `Query a journal style corpus (default: RMP) for style evidence (local-only).

Evidence-first:
- Writes a compact query result artifact to disk
- Returns only {uri + summary} (read details via MCP resources)

Note: Requires a built local corpus index (run \`inspire_style_corpus_build_index\` first).`,
    zodSchema: StyleCorpusQueryToolSchema,
    handler: async params => {
      const { queryStyleCorpus } = await import('./writing/styleCorpusTools.js');
      return queryStyleCorpus(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_INIT_PROFILE,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description: 'Initialize a built-in style corpus profile on disk (local-only; Evidence-first)',
    zodSchema: StyleCorpusInitProfileToolSchema,
    handler: async params => {
      const { initStyleCorpusProfile } = await import('./writing/styleCorpusTools.js');
      return initStyleCorpusProfile(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_BUILD_MANIFEST,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description:
      'Build/extend a style corpus manifest from INSPIRE search results (incremental + deterministic; network).',
    zodSchema: StyleCorpusBuildManifestToolSchema,
    handler: async params => {
      const { buildStyleCorpusManifest } = await import('./writing/styleCorpusTools.js');
      return buildStyleCorpusManifest(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_DOWNLOAD,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description: 'Download style corpus papers from arXiv (LaTeX preferred, PDF fallback; checkpointable; network).',
    zodSchema: StyleCorpusDownloadToolSchema,
    handler: async params => {
      const { downloadStyleCorpus } = await import('./writing/styleCorpusTools.js');
      return downloadStyleCorpus(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_BUILD_EVIDENCE,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description:
      'Build Docling-like LaTeX evidence catalogs for a style corpus (local compute; optional INSPIRE citation mapping when enabled; network optional).',
    zodSchema: StyleCorpusBuildEvidenceToolSchema,
    handler: async params => {
      const { buildStyleCorpusEvidence } = await import('./writing/styleCorpusTools.js');
      return buildStyleCorpusEvidence(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_BUILD_INDEX,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description: 'Build hybrid retrieval index for a style corpus (local-only)',
    zodSchema: StyleCorpusBuildIndexToolSchema,
    handler: async params => {
      const { buildStyleCorpusIndex } = await import('./writing/styleCorpusTools.js');
      return buildStyleCorpusIndex(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_EXPORT_PACK,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description: 'Export a style corpus pack (zip + sha256 manifest) for transfer to another machine (local-only)',
    zodSchema: StyleCorpusExportPackToolSchema,
    handler: async params => {
      const { exportStyleCorpusPack } = await import('./writing/styleCorpusTools.js');
      return exportStyleCorpusPack(params);
    },
  },
  {
    name: INSPIRE_STYLE_CORPUS_IMPORT_PACK,
    tier: 'advanced',
    exposure: 'full',
    maturity: 'experimental',
    description: 'Import a style corpus pack (zip + sha256 manifest) into HEP_DATA_DIR/corpora (local-only)',
    zodSchema: StyleCorpusImportPackToolSchema,
    handler: async params => {
      const { importStyleCorpusPack } = await import('./writing/styleCorpusTools.js');
      return importStyleCorpusPack(params);
    },
  },
  // NOTE: PDG tool specs are imported from `@autoresearch/pdg-mcp/tooling` (built output).
  // Keep a lightweight normalization here so the tool list remains clear even if the PDG package
  // has not been rebuilt yet in a workspace setting.
  ...PDG_TOOL_SPECS.map(
    (spec): Omit<ToolSpec, 'riskLevel'> => ({
      name: spec.name,
      tier: 'consolidated',
      exposure: spec.exposure,
      description: (() => {
        const d = String(spec.description ?? '').trim();
        if (!d) return d;
        const needsLocal = !/\blocal-only\b/i.test(d);
        const needsDb = !/PDG_DB_PATH/.test(d);
        if (!needsLocal && !needsDb) return d;
        const suffix = [needsLocal ? 'local-only' : null, needsDb ? 'requires `PDG_DB_PATH`' : null]
          .filter(Boolean)
          .join('; ');
        const base = d.replace(/\.\s*$/, '');
        return `${base} (${suffix}).`;
      })(),
      zodSchema: spec.zodSchema,
      handler: spec.handler,
    })
  ),
];

// Inject riskLevel from the shared static map (H-11a)
export const TOOL_SPECS: ToolSpec[] = _RAW_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: (TOOL_RISK_LEVELS[spec.name] ?? 'read') as ToolRiskLevel,
}));

const TOOL_SPECS_BY_NAME = new Map<string, ToolSpec>(
  TOOL_SPECS.map(spec => [spec.name, spec])
);

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS_BY_NAME.get(name);
}

export function getToolSpecs(mode: ToolExposureMode): ToolSpec[] {
  return TOOL_SPECS.filter(spec => isToolExposed(spec, mode));
}

export function getTools(mode: ToolExposureMode = 'standard') {
  return getToolSpecs(mode).map(spec => {
    const baseDescription = spec.description.replace(/^(?:\[(?:Deprecated|Experimental|Advanced)\]\s*)+/, '');
    const prefixes: string[] = [];
    if (spec.maturity === 'deprecated') {
      prefixes.push('[Deprecated]');
    } else if (spec.maturity === 'experimental') {
      prefixes.push('[Experimental]');
    }
    if (isAdvancedToolSpec(spec)) {
      prefixes.push('[Advanced]');
    }

    const prefixText = prefixes.join(' ');
    const description = prefixText ? `${prefixText} ${baseDescription}` : baseDescription;

    return {
      name: spec.name,
      description,
      inputSchema: zodToMcpInputSchema(spec.zodSchema),
    };
  });
}
