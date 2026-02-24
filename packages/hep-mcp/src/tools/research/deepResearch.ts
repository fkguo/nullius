/**
 * Deep Research Tool (Consolidated)
 * Combines: deep_analyze, synthesize_review, writing tools
 *
 * Modes:
 * - 'analyze': Deep content analysis (equations, theorems, methodology)
 * - 'synthesize': Generate structured review from papers
 * - 'write': Generate deep research report with full writing pipeline
 *            (Uses Phase 11 handlers for ReferenceManager integration)
 */

import { deepAnalyze, type DeepAnalyzeResult, type DeepAnalyzeOptions } from './deepAnalyze.js';
import {
  synthesizeReview,
  type SynthesizeReviewResult,
  type SynthesizeOptions,
  type NarrativeStructure,
  type ReviewStyle,
} from './synthesizeReview.js';
import pLimit from 'p-limit';
import * as fs from 'fs';
import { zodToMcpInputSchema } from '../mcpSchema.js';
// Phase 11 Writing Tool Handlers (with ReferenceManager integration)
import {
  handleClaimsTable,
  handleVerifyCitations,
  handleCheckOriginality,
  getReferenceManager,
} from '../writing/writingToolHandlers.js';
import type {
  LLMCallMode,
  EnhancedClaimsTable,
  WritingPacket,
  SectionOutput,
} from '../writing/types.js';
import { isDepthConfig } from '../writing/types.js';
import { getWritingModeConfig, createLLMClient, DeepWriterAgent } from '../writing/llm/index.js';
import type { OutlineSection } from '../writing/outline/types.js';
import { buildWritingPacket } from '../writing/deepWriter/writingPacket.js';
import { escapeRegex } from '../writing/utils/index.js';
import type { VerifyCitationsResult } from '../writing/verifier/types.js';
import type { CheckOriginalityResult } from '../writing/originality/types.js';
import { CLIENT_INSTRUCTIONS_EN, CLIENT_INSTRUCTIONS_ZH, buildPromptFromPacket, SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ZH } from '../writing/prompts/sharedPrompt.js';
import { selectAssetsForInjection } from '../writing/prompts/assetInjection.js';
import { WORD_BUDGET_BY_LENGTH, calculatePerSectionBudget } from '../writing/outline/wordBudget.js';
import { invalidParams } from '@autoresearch/shared';
import { writeRunJsonArtifact } from '../../vnext/citations.js';
import { repairAndParseJsonDeterministically } from '../../vnext/structuredOutput.js';
import { ReviewerReportV2Schema } from '../../vnext/contracts/reviewerReport.js';
import { getRun, type RunArtifactRef, type RunManifest, type RunStep } from '../../vnext/runs.js';
import { getRunArtifactPath, getRunArtifactsDir, getRunManifestPath } from '../../vnext/paths.js';
import { buildRunWritingCritical } from '../../vnext/writing/critical.js';
import { CandidatePoolArtifactV1Schema, buildRunWritingCandidatePoolFromInspireNetwork } from '../../vnext/writing/candidatePool.js';
import { createRunWritingPaperSetCurationPacket } from '../../vnext/writing/papersetCurationPacket.js';
import { planPaperSetCuration, type PaperSetCuration, type PaperSetCurationRequest } from '../../vnext/writing/papersetPlanner.js';
import { submitRunWritingPaperSetCuration } from '../../vnext/writing/submitPapersetCuration.js';
import { createRunWritingOutlinePlanPacket } from '../../vnext/writing/outlinePlanPacket.js';
import { integrateWritingSections } from '../../vnext/writing/integrate.js';
import { OutlinePlanV2Schema, validateOutlinePlanV2OrThrow, planOutline, type OutlinePlan, type OutlinePlanRequest } from '../../vnext/writing/outlinePlanner.js';
import { ensureWritingQualityPolicyV1 } from '../../vnext/writing/qualityPolicy.js';
import { ReferenceManager } from '../writing/reference/referenceManager.js';
import { SectionOutputSubmissionSchema } from '../../vnext/writing/sectionOutputSchema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DeepMode = 'analyze' | 'synthesize' | 'write';
export type WriteResumeFrom = 'paperset' | 'claims' | 'critical' | 'outline' | 'sections' | 'verify' | 'originality' | 'review';

export interface DeepResearchParams {
  /** Paper identifiers */
  identifiers: string[];
  /** Research mode */
  mode: DeepMode;
  /** Output format */
  format?: 'json' | 'markdown';
  /** Mode-specific options */
  options?: DeepOptions;
  /** Optional run_id for evidence-first artifacts (write mode) */
  run_id?: string;
  /** Resume pipeline from a given step (write mode + run_id) */
  resume_from?: WriteResumeFrom;
  /** Internal MCP context (not part of tool schema) */
  _mcp?: {
    reportProgress?: (progress: number, total?: number, message?: string) => void | Promise<void>;
  };
}

export interface DeepOptions {
  // Analyze options
  extract_equations?: boolean;
  extract_theorems?: boolean;
  extract_methodology?: boolean;
  extract_conclusions?: boolean;
  include_inline_math?: boolean;
  max_section_length?: number;

  // Synthesize options
  review_type?: 'methodology' | 'timeline' | 'comparison' | 'overview';
  focus_topic?: string;
  style?: ReviewStyle;
  include_critical_analysis?: boolean;
  narrative_structure?: NarrativeStructure;
  include_equations?: boolean;
  include_bibliography?: boolean;
  max_papers_per_group?: number;

  // Write options (Phase 10)
  topic?: string;
  title?: string;
  target_length?: 'short' | 'medium' | 'long';
  quality_level?: 'standard' | 'publication';
  structure_hints?: string;
  user_outline?: string;
  outline_policy?: 'lock' | 'allow_minimal_edits';
  phase0_options?: { max_retries?: number };
  phase1_options?: { max_retries?: number; require_asset_coverage?: boolean };
  phase2_options?: { max_retries?: number };
  llm_mode?: LLMCallMode;
  max_section_retries?: number;
  auto_fix_originality?: boolean;
  auto_fix_citations?: boolean;
  /** Language for client_continuation instructions (auto-detected from topic/title if not specified) */
  language?: 'en' | 'zh';
}

export interface DeepResearchResult {
  mode: DeepMode;
  /** Deep analysis result (if mode='analyze') */
  analysis?: DeepAnalyzeResult;
  /** Synthesized review (if mode='synthesize') */
  review?: SynthesizeReviewResult;
  /** Evidence-first run output (if mode='write') */
  run?: {
    run_id: string;
    project_id: string;
    manifest_uri: string;
    artifacts: RunArtifactRef[];
    summary: Record<string, unknown>;
    next_actions?: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Client Continuation Instructions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect if text contains Chinese characters
 */
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/**
 * Auto-detect language from topic/title
 */
function detectLanguage(topic?: string, title?: string): 'en' | 'zh' {
  const text = `${topic || ''} ${title || ''}`;
  return containsChinese(text) ? 'zh' : 'en';
}

function parseConcurrencyLimit(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// vNext Run-based writing helpers (R2/W0)
// ─────────────────────────────────────────────────────────────────────────────

const RUN_WRITING_STEPS: Array<{ key: WriteResumeFrom; step: string }> = [
  { key: 'paperset', step: 'writing_paperset' },
  { key: 'claims', step: 'writing_claims' },
  { key: 'critical', step: 'writing_critical' },
  { key: 'outline', step: 'writing_outline' },
  { key: 'sections', step: 'writing_sections' },
  { key: 'verify', step: 'writing_verify' },
  { key: 'originality', step: 'writing_originality' },
  { key: 'review', step: 'writing_review' },
];

const WRITING_CLAIMS_ARTIFACT = 'writing_claims_table.json';
const WRITING_CANDIDATE_POOL_ARTIFACT = 'writing_candidate_pool_v1.json';
const WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT = 'writing_candidate_pool_expanded_v1.json';
const WRITING_PAPERSET_CURATION_PACKET_ARTIFACT = 'writing_paperset_curation_packet.json';
const WRITING_PAPERSET_ARTIFACT = 'writing_paperset_v1.json';
const WRITING_CRITICAL_CONFLICTS_ARTIFACT = 'writing_conflicts.json';
const WRITING_CRITICAL_STANCE_ARTIFACT = 'writing_stance.jsonl';
const WRITING_CRITICAL_EVIDENCE_GRADES_ARTIFACT = 'writing_evidence_grades.json';
const WRITING_CRITICAL_SUMMARY_ARTIFACT = 'writing_critical_summary.json';
const WRITING_OUTLINE_V2_ARTIFACT = 'writing_outline_v2.json';
const WRITING_OUTLINE_PLAN_PACKET_ARTIFACT = 'writing_outline_plan_packet.json';
const WRITING_OUTLINE_V2_PARSE_ERROR_ARTIFACT = 'writing_parse_error_outline_v2.json';
const WRITING_PACKETS_ARTIFACT = 'writing_packets_sections.json';
const WRITING_CLIENT_CONTINUATION_ARTIFACT = 'writing_client_continuation.json';
const WRITING_EVIDENCE_QUOTAS_ARTIFACT = 'writing_evidence_quotas.json';
const WRITING_WARNINGS_ARTIFACT = 'writing_warnings.json';
const WRITING_SUMMARY_ARTIFACT = 'writing_summary.json';
const WRITING_LLM_REQUEST_ARTIFACT = 'llm_request.json';
const WRITING_LLM_RESPONSE_ARTIFACT = 'llm_response.json';
const WRITING_REFERENCE_MAP_ARTIFACT = 'reference_map.json';
const WRITING_MASTER_BIB_ARTIFACT = 'writing_master.bib';
const WRITING_ASSET_INJECTION_DIAGNOSTICS_ARTIFACT = 'writing_asset_injection_diagnostics.json';
const WRITING_REVIEW_PROMPT_ARTIFACT = 'writing_reviewer_prompt.md';
const WRITING_REVIEW_CONTEXT_ARTIFACT = 'writing_reviewer_context.md';
const WRITING_REVIEW_REPORT_ARTIFACT = 'writing_reviewer_report.json';

type EvidenceQuotas = {
  min_claims: number;
  min_evidence_ids: number;
  min_equations: number;
  min_figures: number;
  min_tables: number;
};

const EVIDENCE_QUOTAS_BY_LENGTH: Record<'short' | 'medium' | 'long', Record<'introduction' | 'body' | 'summary', EvidenceQuotas>> = {
  short: {
    introduction: { min_claims: 2, min_evidence_ids: 2, min_equations: 0, min_figures: 0, min_tables: 0 },
    body: { min_claims: 3, min_evidence_ids: 3, min_equations: 1, min_figures: 1, min_tables: 0 },
    summary: { min_claims: 2, min_evidence_ids: 2, min_equations: 0, min_figures: 0, min_tables: 0 },
  },
  medium: {
    introduction: { min_claims: 3, min_evidence_ids: 3, min_equations: 0, min_figures: 0, min_tables: 0 },
    body: { min_claims: 5, min_evidence_ids: 5, min_equations: 2, min_figures: 1, min_tables: 0 },
    summary: { min_claims: 3, min_evidence_ids: 3, min_equations: 0, min_figures: 0, min_tables: 0 },
  },
  long: {
    introduction: { min_claims: 4, min_evidence_ids: 4, min_equations: 0, min_figures: 0, min_tables: 0 },
    body: { min_claims: 7, min_evidence_ids: 7, min_equations: 3, min_figures: 2, min_tables: 1 },
    summary: { min_claims: 4, min_evidence_ids: 4, min_equations: 0, min_figures: 0, min_tables: 0 },
  },
};

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function ensureMinFromPool(existing: string[], minCount: number, pool: string[]): { selected: string[]; shortage: number } {
  const selected = uniqueStrings(existing);
  const seen = new Set(selected);
  for (const id of pool) {
    if (selected.length >= minCount) break;
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
  }
  return { selected, shortage: Math.max(0, minCount - selected.length) };
}

function countOutlineAssignments(outline: OutlineSection[]): { totalClaims: number; totalAssets: number } {
  let totalClaims = 0;
  let totalAssets = 0;
  for (const s of outline) {
    totalClaims += (s.assigned_claims ?? []).length;
    totalAssets += (s.assigned_figures ?? []).length + (s.assigned_equations ?? []).length + (s.assigned_tables ?? []).length;
    if (s.subsections) {
      const sub = countOutlineAssignments(s.subsections);
      totalClaims += sub.totalClaims;
      totalAssets += sub.totalAssets;
    }
  }
  return { totalClaims, totalAssets };
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function makeRunArtifactRef(runId: string, artifactName: string, mimeType?: string): RunArtifactRef {
  return {
    name: artifactName,
    uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`,
    mimeType,
  };
}

function writeRunTextArtifact(params: {
  runId: string;
  artifactName: string;
  content: string;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, params.content, 'utf-8');
  return makeRunArtifactRef(params.runId, params.artifactName, params.mimeType);
}

function readRunJsonArtifact<T>(runId: string, artifactName: string): T {
  const artifactPath = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams(`Missing required run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as T;
}

function writeRunManifest(runId: string, manifest: RunManifest): void {
  fs.writeFileSync(getRunManifestPath(runId), JSON.stringify(manifest, null, 2), 'utf-8');
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

function ensureWritingSteps(runId: string): { manifest: RunManifest; stepIndexByKey: Record<WriteResumeFrom, number> } {
  const run = getRun(runId);
  const existing = new Map(run.steps.map((s, idx) => [s.step, idx]));
  const now = new Date().toISOString();

  let steps = [...run.steps];
  for (const { step } of RUN_WRITING_STEPS) {
    if (existing.has(step)) continue;
    steps.push({ step, status: 'pending' });
  }

  const manifest: RunManifest = {
    ...run,
    status: computeRunStatus({ ...run, steps }),
    updated_at: now,
    steps,
  };

  const stepIndexByKey = Object.fromEntries(
    RUN_WRITING_STEPS.map(({ key, step }) => {
      const idx = manifest.steps.findIndex(s => s.step === step);
      if (idx === -1) throw new Error(`Internal: failed to ensure step ${step}`);
      return [key, idx] as const;
    })
  ) as Record<WriteResumeFrom, number>;

  writeRunManifest(runId, manifest);
  return { manifest, stepIndexByKey };
}

function upsertRunStep(params: {
  runId: string;
  manifest: RunManifest;
  stepIndex: number;
  update: (prev: RunStep) => RunStep;
}): RunManifest {
  const now = new Date().toISOString();
  const nextSteps = params.manifest.steps.map((s, idx) => (idx === params.stepIndex ? params.update(s) : s));
  const next: RunManifest = {
    ...params.manifest,
    updated_at: now,
    steps: nextSteps,
  };
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Execution Helpers (Unified for all modes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result from executing a section with LLM
 * Optimized: master_bib removed (use top-level instead)
 */
interface SectionExecutionResult {
  section_output: SectionOutput;
  mode_used: LLMCallMode;
  bibtex_keys_used: string[];
  // master_bib removed - redundant with top-level master_bib
  llm_log?: {
    provider?: string;
    model?: string;
    attempts?: number;
    total_latency_ms?: number;
    success?: boolean;
    error?: string;
    verification_pass?: boolean;
    citation_issues_total?: number;
    originality_level?: string;
    originality_max_overlap?: number;
    request?: { prompt: string; system_prompt: string };
    response?: { content: string; usage?: unknown; latency_ms?: number };
  };
}

/**
 * Execute a section using the pre-built WritingPacket
 *
 * Key design principle: The packet is already built with context.topic/title,
 * so this function just executes it without rebuilding.
 */
async function executeSectionWithLLM(
  packet: WritingPacket,
  llmMode: LLMCallMode,
  refManager: ReturnType<typeof getReferenceManager>,
  refinement?: {
    max_section_retries?: number;
    auto_fix_originality?: boolean;
    auto_fix_citations?: boolean;
  }
): Promise<SectionExecutionResult> {
  if (llmMode !== 'internal') {
    throw invalidParams("Internal section execution requires llm_mode='internal' (passthrough removed; use client mode + run artifacts).", {
      llm_mode: llmMode,
        next_actions: [
          {
            tool: 'hep_run_writing_create_section_candidates_packet_v1',
            args: { run_id: '<run_id>', section_index: '<section_index>' },
            reason: 'M13 client mode is Evidence-first: generate N-best (N>=2) section candidates, then follow next_actions to judge+verify (no bypass).',
          },
        ],
      });
  }

  const config = getWritingModeConfig('internal');
  if (!config.llmConfig) {
    throw invalidParams(
      "llm_mode='internal' requires WRITING_LLM_PROVIDER + WRITING_LLM_API_KEY (and optional WRITING_LLM_MODEL); use llm_mode='client' otherwise.",
      { llm_mode: llmMode }
    );
  }

  let sectionOutput: SectionOutput;
  let llmLog: SectionExecutionResult['llm_log'];
  try {
    const agent = new DeepWriterAgent(config);
    const result = await agent.writeSection(packet, {
      max_retries: refinement?.max_section_retries,
      auto_fix_originality: refinement?.auto_fix_originality,
      auto_fix_citations: refinement?.auto_fix_citations,
    });
    sectionOutput = result.output;
    llmLog = {
      provider: result.audit.provider,
      model: result.audit.model,
      attempts: result.audit.attempts,
      total_latency_ms: result.audit.total_latency_ms,
      success: result.audit.success,
      error: result.audit.error,
      verification_pass: result.verify?.pass,
      citation_issues_total: Array.isArray(result.verify?.citationIssues) ? result.verify!.citationIssues.length : undefined,
      originality_level: result.verify?.originalityLevel,
      originality_max_overlap: result.verify?.originalityMaxOverlap,
      request: result.llm_request,
      response: {
        content: result.llm_response.content,
        usage: result.llm_response.usage,
        latency_ms: result.llm_response.latency_ms,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw invalidParams('Internal LLM section writing failed (fail-fast).', { error: msg });
  }

  // Resolve citation keys (inspire:recid -> bibtex key)
  const { processedOutput, bibtexKeysUsed } = processSectionCitations(
    sectionOutput,
    refManager
  );

  return {
    section_output: processedOutput,
    mode_used: 'internal',
    bibtex_keys_used: bibtexKeysUsed,
    // master_bib removed - use top-level master_bib instead
    llm_log: llmLog,
  };
}

/**
 * Process section content to resolve citation keys
 * Replaces inspire:recid with actual BibTeX keys
 */
function processSectionCitations(
  output: SectionOutput,
  refManager: ReturnType<typeof getReferenceManager>
): { processedOutput: SectionOutput; bibtexKeysUsed: string[] } {
  const bibtexKeysUsed: string[] = [];
  const paperIds = new Set<string>();

  // Extract paper IDs from attributions
  for (const attr of output.attributions) {
    for (const citation of attr.citations) {
      const recid = citation.replace('inspire:', '');
      paperIds.add(recid);
    }
  }

  // Extract recids from content
  const contentCiteMatches = output.content.matchAll(/\\cite\{inspire:(\d+)\}/g);
  for (const match of contentCiteMatches) {
    paperIds.add(match[1]);
  }

  // Resolve to bibtex keys
  for (const recid of paperIds) {
    const key = refManager.getKeyByRecid(recid);
    if (key) {
      bibtexKeysUsed.push(key);
    }
  }

  // Replace inspire:recid with bibtex keys in content
  let processedContent = output.content;
  for (const recid of paperIds) {
    const bibtexKey = refManager.getKeyByRecid(recid);
    if (bibtexKey) {
      const escapedRecid = escapeRegex(recid);
      processedContent = processedContent.replace(
        new RegExp(`\\\\cite\\{inspire:${escapedRecid}\\}`, 'g'),
        `\\cite{${bibtexKey}}`
      );
    }
  }

  // Update attributions to use bibtex keys
  const processedAttributions = output.attributions.map(attr => ({
    ...attr,
    citations: attr.citations.map(c => {
      const recid = c.replace('inspire:', '');
      return refManager.getKeyByRecid(recid) || c;
    }),
  }));

  return {
    processedOutput: {
      ...output,
      content: processedContent,
      attributions: processedAttributions,
    },
    bibtexKeysUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// vNext Run-based writing pipeline (R2/W0 + W1)
// ─────────────────────────────────────────────────────────────────────────────

type WritingPacketsArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  topic: string;
  title: string;
  language: 'en' | 'zh';
  target_length?: 'short' | 'medium' | 'long';
  quality_level?: 'standard' | 'publication';
  structure_hints?: string;
  llm_mode_requested: LLMCallMode;
  sections: Array<{
    index: number;
    section_number: string;
    section_title: string;
    prompt: string;
    packet: WritingPacket;
  }>;
};

type WritingSectionArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  mode_used: LLMCallMode;
  bibtex_keys_used: string[];
  section_output: SectionOutput;
};

type WritingVerificationArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  verification: VerifyCitationsResult & { bibtex_keys_verified: string[] };
};

type WritingOriginalityArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  originality: CheckOriginalityResult & { recommendation: string };
};

function getWritingStepIndexByKey(manifest: RunManifest): Record<WriteResumeFrom, number> {
  const idx = Object.fromEntries(
    RUN_WRITING_STEPS.map(({ key, step }) => [key, manifest.steps.findIndex(s => s.step === step)] as const)
  ) as Record<WriteResumeFrom, number>;
  for (const { key, step } of RUN_WRITING_STEPS) {
    if (idx[key] === -1) throw new Error(`Internal: missing expected run step: ${step}`);
  }
  return idx;
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function countDoneSectionArtifacts(runId: string, expected: number, kind: 'section' | 'verification' | 'originality'): number {
  let ok = 0;
  for (let i = 1; i <= expected; i++) {
    const name = kind === 'section'
      ? `writing_section_${pad3(i)}.json`
      : kind === 'verification'
        ? `writing_verification_${pad3(i)}.json`
        : `writing_originality_${pad3(i)}.json`;
    const p = getRunArtifactPath(runId, name);
    if (fs.existsSync(p)) ok += 1;
  }
  return ok;
}

async function performWriteToRun(params: {
  runId: string;
  identifiers: string[];
  topic: string;
  title: string;
  targetLength?: 'short' | 'medium' | 'long';
  quality?: {
    quality_level?: 'standard' | 'publication';
    structure_hints?: string;
    user_outline?: string;
    outline_policy?: 'lock' | 'allow_minimal_edits';
    phase0_options?: { max_retries?: number };
    phase1_options?: { max_retries?: number; require_asset_coverage?: boolean };
    phase2_options?: { max_retries?: number };
  };
  llmMode: LLMCallMode;
  refinement?: {
    max_section_retries?: number;
    auto_fix_originality?: boolean;
    auto_fix_citations?: boolean;
  };
  language: 'en' | 'zh';
  resumeFrom?: WriteResumeFrom;
  reportProgress?: (progress: number, total?: number, message?: string) => void | Promise<void>;
}): Promise<NonNullable<DeepResearchResult['run']>> {
  // Ensure run exists + initialize workflow steps.
  let { manifest } = ensureWritingSteps(params.runId);
  const stepIndexByKey = getWritingStepIndexByKey(manifest);

  const nowIso = () => new Date().toISOString();
  const commit = (next: RunManifest): RunManifest => {
    const now = nowIso();
    const updated: RunManifest = {
      ...next,
      status: computeRunStatus(next),
      updated_at: now,
    };
    writeRunManifest(params.runId, updated);
    return updated;
  };

  // Persistent ReferenceManager bound to run artifacts (for resume + client/internal parity).
  const artifactsDir = getRunArtifactsDir(params.runId);
  const refManager = new ReferenceManager(artifactsDir);
  await refManager.loadFromDisk();

  const explicitResume = params.resumeFrom !== undefined;
  const order = RUN_WRITING_STEPS.map(s => s.key);

  const requiredArtifactForStep = (key: WriteResumeFrom): string | null => {
    switch (key) {
      case 'paperset':
        return WRITING_PAPERSET_ARTIFACT;
      case 'claims':
        return WRITING_CLAIMS_ARTIFACT;
      case 'critical':
        return WRITING_CRITICAL_SUMMARY_ARTIFACT;
      case 'outline':
        return WRITING_OUTLINE_V2_ARTIFACT;
      case 'sections':
        return WRITING_PACKETS_ARTIFACT;
      case 'review':
        return WRITING_REVIEW_REPORT_ARTIFACT;
      case 'verify':
      case 'originality':
        return null;
    }
  };

  const autoResumeFrom = (() => {
    for (const key of order) {
      const step = manifest.steps[stepIndexByKey[key]];
      if (step.status !== 'done') return key;
      const req = requiredArtifactForStep(key);
      if (req && !fs.existsSync(getRunArtifactPath(params.runId, req))) return key;
    }
    return null;
  })();

  const startFrom = params.resumeFrom ?? autoResumeFrom;
  if (!startFrom) {
    // Nothing to do: return current state (URIs only).
    const run = getRun(params.runId);
    const packetsExist = fs.existsSync(getRunArtifactPath(params.runId, WRITING_PACKETS_ARTIFACT));
    const artifacts: RunArtifactRef[] = [];
    if (packetsExist) artifacts.push(makeRunArtifactRef(params.runId, WRITING_PACKETS_ARTIFACT, 'application/json'));
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_OUTLINE_V2_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_OUTLINE_V2_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_CONFLICTS_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_CONFLICTS_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_STANCE_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_STANCE_ARTIFACT, 'application/x-ndjson'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_EVIDENCE_GRADES_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_EVIDENCE_GRADES_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_PAPERSET_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_PAPERSET_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_EVIDENCE_QUOTAS_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_EVIDENCE_QUOTAS_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CLAIMS_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_CLAIMS_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_REFERENCE_MAP_ARTIFACT))) {
      artifacts.push(makeRunArtifactRef(params.runId, WRITING_REFERENCE_MAP_ARTIFACT, 'application/json'));
    }

    return {
      run_id: params.runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(params.runId)}/manifest`,
      artifacts,
      summary: {
        status: run.status,
        steps: Object.fromEntries(order.map(k => [k, run.steps[stepIndexByKey[k]]?.status])),
      },
    };
  }

  const startIdx = order.indexOf(startFrom);
  if (startIdx === -1) throw invalidParams(`Invalid resume_from: ${startFrom}`);

  const shouldRun = (key: WriteResumeFrom): boolean => {
    const idx = order.indexOf(key);
    if (idx < startIdx) return false;
    if (explicitResume) return true;
    const step = manifest.steps[stepIndexByKey[key]];
    const req = requiredArtifactForStep(key);
    if (step.status !== 'done') return true;
    if (req && !fs.existsSync(getRunArtifactPath(params.runId, req))) return true;
    return false;
  };

  const toolArtifacts: RunArtifactRef[] = [];
  const warnings: string[] = [];

  // M07: QualityGatePolicy must be written at the start of the write run (artifact SSOT).
  const desiredQualityLevel = params.quality?.quality_level ?? 'standard';
  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({
    run_id: params.runId,
    quality_level: desiredQualityLevel,
  });
  if (qualityPolicy.quality_level !== desiredQualityLevel) {
    throw invalidParams('writing_quality_policy_v1.json quality_level mismatch (fail-fast)', {
      run_id: params.runId,
      expected: desiredQualityLevel,
      actual: qualityPolicy.quality_level,
      quality_policy_uri: qualityPolicyRef.uri,
    });
  }
  toolArtifacts.push(qualityPolicyRef);

  // Helper: ensure prerequisites exist when resuming from later step.
  for (let i = 0; i < startIdx; i++) {
    const key = order[i]!;
    const req = requiredArtifactForStep(key);
    if (!req) continue;
    const p = getRunArtifactPath(params.runId, req);
    if (!fs.existsSync(p)) {
      throw invalidParams(`resume_from=${startFrom} requires existing artifact ${req}; rerun from earlier step`, {
        run_id: params.runId,
        resume_from: startFrom,
        missing_artifact: req,
      });
    }
  }

  const report = (progress: number, total: number, message: string) => {
    const fn = params.reportProgress;
    if (!fn) return;
    try {
      const maybe = fn(progress, total, message);
      if (maybe && typeof (maybe as Promise<void>).catch === 'function') (maybe as Promise<void>).catch(() => {});
    } catch {
      // ignore
    }
  };

  const totalPhases = 8;
  report(0, totalPhases, `started: write(run_id=${params.runId})`);

  // Load-or-run variables
  let claimsResult: Awaited<ReturnType<typeof handleClaimsTable>>;
  type OutlineResult = {
    outline: OutlineSection[];
    total_claims_assigned: number;
    total_assets_assigned: number;
    word_budget: { total_target: unknown; per_section: unknown };
    cross_ref_map?: unknown;
    structure_rationale?: string;
    outline_strategy: string;
    reference_count: number;
  };
  let outlineResult: OutlineResult;
  let packets: WritingPacketsArtifactV1;
  let selectedRecids: string[] = params.identifiers;

  // ── Step: paperset
  report(0, totalPhases, 'paperset');
  if (shouldRun('paperset')) {
    const idx = stepIndexByKey.paperset;
    manifest = commit(
      upsertRunStep({
        runId: params.runId,
        manifest,
        stepIndex: idx,
        update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
      })
    );

    const hasCandidatePool =
      fs.existsSync(getRunArtifactPath(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT)) &&
      fs.existsSync(getRunArtifactPath(params.runId, WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT));

    if (!hasCandidatePool) {
      const poolRes = await buildRunWritingCandidatePoolFromInspireNetwork({
        run_id: params.runId,
        seed_identifiers: params.identifiers,
        candidate_pool_artifact_name: WRITING_CANDIDATE_POOL_ARTIFACT,
        expanded_artifact_name: WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT,
      });
      toolArtifacts.push(...poolRes.artifacts);

      manifest = commit(
        upsertRunStep({
          runId: params.runId,
          manifest,
          stepIndex: idx,
          update: prev => ({
            ...prev,
            artifacts: mergeArtifactRefs(prev.artifacts, poolRes.artifacts),
          }),
        })
      );
    } else {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT, 'application/json'));
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT, 'application/json'));
    }

    const hasPaperset = fs.existsSync(getRunArtifactPath(params.runId, WRITING_PAPERSET_ARTIFACT));
    if (!hasPaperset) {
      const requestedLength = params.targetLength ?? 'medium';

      if (params.llmMode === 'client') {
        const packetRes = await createRunWritingPaperSetCurationPacket({
          run_id: params.runId,
          language: 'auto',
          target_length: requestedLength,
          title: params.title,
          topic: params.topic,
          structure_hints: params.quality?.structure_hints,
          seed_identifiers: params.identifiers,
          candidate_pool_artifact_name: WRITING_CANDIDATE_POOL_ARTIFACT,
          output_artifact_name: WRITING_PAPERSET_CURATION_PACKET_ARTIFACT,
        });
        toolArtifacts.push(...packetRes.artifacts);

        const runNow = getRun(params.runId);
        return {
          run_id: params.runId,
          project_id: runNow.project_id,
          manifest_uri: `hep://runs/${encodeURIComponent(params.runId)}/manifest`,
          artifacts: toolArtifacts,
          summary: {
            status: runNow.status,
            steps: Object.fromEntries(order.map(k => [k, runNow.steps[stepIndexByKey[k]]?.status])),
            waiting_for: 'paperset_curation_submission',
            prompt_packet_artifact: WRITING_PAPERSET_CURATION_PACKET_ARTIFACT,
          },
          next_actions: packetRes.next_actions,
        };
      }

      // internal/passthrough: generate paperset immediately.
      const poolRaw = readRunJsonArtifact<any>(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT);
      const poolParsed = CandidatePoolArtifactV1Schema.safeParse(poolRaw);
      if (!poolParsed.success) {
        throw invalidParams('Invalid candidate pool artifact (writing_candidate_pool_v1.json)', {
          run_id: params.runId,
          artifact_name: WRITING_CANDIDATE_POOL_ARTIFACT,
          issues: poolParsed.error.issues,
        });
      }
      const candidatePool = poolParsed.data.candidates;
      if (candidatePool.length === 0) {
        throw invalidParams('Candidate pool is empty; cannot generate paperset', { run_id: params.runId, artifact_name: WRITING_CANDIDATE_POOL_ARTIFACT });
      }

      const packetRes = await createRunWritingPaperSetCurationPacket({
        run_id: params.runId,
        language: 'auto',
        target_length: requestedLength,
        title: params.title,
        topic: params.topic,
        structure_hints: params.quality?.structure_hints,
        seed_identifiers: params.identifiers,
        candidate_pool_artifact_name: WRITING_CANDIDATE_POOL_ARTIFACT,
        output_artifact_name: WRITING_PAPERSET_CURATION_PACKET_ARTIFACT,
      });
      toolArtifacts.push(...packetRes.artifacts);

      const request: PaperSetCurationRequest = {
        run_id: params.runId,
        project_id: manifest.project_id,
        language: 'auto',
        target_length: requestedLength,
        title: params.title,
        topic: params.topic,
        structure_hints: params.quality?.structure_hints,
        seed_identifiers: params.identifiers,
        candidate_pool: candidatePool,
      };

      const generated = await planPaperSetCuration(request, params.llmMode);
      if (!generated || typeof generated !== 'object' || 'system_prompt' in generated) {
        throw invalidParams('Internal: expected PaperSetCuration from planPaperSetCuration(llm_mode!=client)', {
          run_id: params.runId,
          llm_mode: params.llmMode,
        });
      }

      const submitRes = await submitRunWritingPaperSetCuration({
        run_id: params.runId,
        paperset: generated as unknown as PaperSetCuration,
        paperset_artifact_name: WRITING_PAPERSET_ARTIFACT,
        prompt_packet_artifact_name: WRITING_PAPERSET_CURATION_PACKET_ARTIFACT,
      });
      toolArtifacts.push(...submitRes.artifacts);

      // Refresh manifest to avoid overwriting step state.
      manifest = getRun(params.runId);
    }

    // Mark paperset step as done (if paperset exists).
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_PAPERSET_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_PAPERSET_ARTIFACT, 'application/json'));
    }
  } else {
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CANDIDATE_POOL_EXPANDED_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CANDIDATE_POOL_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_PAPERSET_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_PAPERSET_ARTIFACT, 'application/json'));
    }
  }

  // Load selected recids from paperset (fail-fast; no silent drop of arXiv-only ids before M12).
  const papersetArtifact = readRunJsonArtifact<any>(params.runId, WRITING_PAPERSET_ARTIFACT);
  const included = papersetArtifact?.paperset?.included_papers;
  if (!Array.isArray(included)) {
    throw invalidParams('Invalid writing_paperset_v1.json: missing paperset.included_papers', { run_id: params.runId });
  }

  const includedIds = included
    .map((p: any) => (typeof p?.paper_id === 'string' ? p.paper_id.trim() : ''))
    .filter(Boolean);

  const nonInspire = includedIds.filter((id: string) => !id.startsWith('inspire:'));
  if (nonInspire.length > 0) {
    throw invalidParams('writing_paperset_v1.json includes non-INSPIRE paper_id (arXiv-only not supported before M12); fail-fast', {
      run_id: params.runId,
      paper_ids: nonInspire.slice(0, 50),
      next_actions: ['Remove arXiv-only items from paperset for now, or wait for M12 arXiv provider integration.'],
    });
  }

  selectedRecids = uniqueStrings(
    includedIds
      .map((id: string) => id.replace(/^inspire:/, '').trim())
      .filter((r: string) => /^\d+$/.test(r))
  );

  if (selectedRecids.length === 0) {
    throw invalidParams('No INSPIRE recids found in writing_paperset_v1.json; cannot proceed', { run_id: params.runId });
  }

  // ── Step: claims
  report(1, totalPhases, 'claims');
  if (shouldRun('claims')) {
    const idx = stepIndexByKey.claims;
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
    }));

    claimsResult = await handleClaimsTable(
      { recids: selectedRecids, topic: params.topic, use_disk_storage: false },
      { referenceManager: refManager }
    );
    warnings.push(...(claimsResult.warnings ?? []));

    // Persist reference mapping for resume / client workflows.
    await refManager.saveToDisk();
	    const refMapRef = makeRunArtifactRef(params.runId, WRITING_REFERENCE_MAP_ARTIFACT, 'application/json');

	    const claimsRef = writeRunJsonArtifact(params.runId, WRITING_CLAIMS_ARTIFACT, claimsResult);
	    const masterBibRef = writeRunTextArtifact({
	      runId: params.runId,
	      artifactName: WRITING_MASTER_BIB_ARTIFACT,
	      content: refManager.generateMasterBib(),
	      mimeType: 'text/x-bibtex',
	    });

	    toolArtifacts.push(claimsRef, refMapRef, masterBibRef);

	    manifest = commit(upsertRunStep({
	      runId: params.runId,
	      manifest,
	      stepIndex: idx,
	      update: prev => ({
	        ...prev,
	        status: 'done',
	        completed_at: nowIso(),
	        artifacts: mergeArtifactRefs(prev.artifacts, [claimsRef, refMapRef, masterBibRef]),
	      }),
	    }));
	  } else {
	    claimsResult = readRunJsonArtifact(params.runId, WRITING_CLAIMS_ARTIFACT) as Awaited<ReturnType<typeof handleClaimsTable>>;
	    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_REFERENCE_MAP_ARTIFACT))) {
	      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_REFERENCE_MAP_ARTIFACT, 'application/json'));
	    }
	    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_MASTER_BIB_ARTIFACT))) {
	      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_MASTER_BIB_ARTIFACT, 'text/x-bibtex'));
	    }
	    toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CLAIMS_ARTIFACT, 'application/json'));
	  }

  const claimsTable = claimsResult.claims_table as EnhancedClaimsTable;
  const corpusRecids = Array.isArray(claimsTable?.corpus_snapshot?.recids) && claimsTable.corpus_snapshot.recids.length > 0
    ? claimsTable.corpus_snapshot.recids.map(r => String(r))
    : selectedRecids;

  // ── Step: critical
  report(2, totalPhases, 'critical');
  if (shouldRun('critical')) {
    const idx = stepIndexByKey.critical;
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
    }));

    const criticalRes = await buildRunWritingCritical({
      run_id: params.runId,
      recids: corpusRecids,
      claims_artifact_name: WRITING_CLAIMS_ARTIFACT,
      conflicts_artifact_name: WRITING_CRITICAL_CONFLICTS_ARTIFACT,
      stance_artifact_name: WRITING_CRITICAL_STANCE_ARTIFACT,
      evidence_grades_artifact_name: WRITING_CRITICAL_EVIDENCE_GRADES_ARTIFACT,
      summary_artifact_name: WRITING_CRITICAL_SUMMARY_ARTIFACT,
      min_tension_sigma: 2,
      include_tables: true,
    });
    toolArtifacts.push(...criticalRes.artifacts);
    try {
      const summary = readRunJsonArtifact<any>(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT);
      const criticalWarnings = Array.isArray(summary?.warnings) ? summary.warnings.map((w: any) => `critical:${String(w)}`) : [];
      warnings.push(...criticalWarnings);
    } catch {
      // ignore
    }

    // Refresh manifest to avoid overwriting the critical step's artifacts/status.
    manifest = getRun(params.runId);
  } else {
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_CONFLICTS_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_CONFLICTS_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_STANCE_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_STANCE_ARTIFACT, 'application/x-ndjson'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_EVIDENCE_GRADES_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_EVIDENCE_GRADES_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT, 'application/json'));
    }
  }

  // ── Step: outline
  report(3, totalPhases, 'outline');

  const requestedLength = params.targetLength ?? 'medium';
  const outlineRequest: OutlinePlanRequest = {
    run_id: params.runId,
    project_id: manifest.project_id,
    language: params.language,
    target_length: requestedLength,
    title: params.title,
    topic: params.topic,
    structure_hints: params.quality?.structure_hints,
    user_outline: params.quality?.user_outline,
    claims_table: claimsTable,
  };

  const estimateSuggestedCitationCount = (target_length: 'short' | 'medium' | 'long', paperCount: number): number => {
    const ranges: Record<typeof target_length, { min: number; max: number; mid: number }> = {
      short: { min: 15, max: 25, mid: 20 },
      medium: { min: 30, max: 50, mid: 40 },
      long: { min: 50, max: 100, mid: 75 },
    };
    const r = ranges[target_length];
    if (!Number.isFinite(paperCount) || paperCount <= 0) return r.mid;
    return Math.max(0, Math.min(r.max, Math.max(Math.min(r.min, paperCount), Math.min(r.mid, paperCount))));
  };

	  const toOutlineSectionsFromPlan = (plan: OutlinePlan): OutlineSection[] => {
	    const eqIds = new Set((claimsTable.visual_assets?.formulas ?? []).map(e => String((e as any).evidence_id ?? (e as any).evidenceId ?? '')));
	    const figIds = new Set((claimsTable.visual_assets?.figures ?? []).map(e => String((e as any).evidence_id ?? (e as any).evidenceId ?? '')));
	    const tabIds = new Set((claimsTable.visual_assets?.tables ?? []).map(e => String((e as any).evidence_id ?? (e as any).evidenceId ?? '')));

	    const uniq = (values: string[]): string[] => uniqueStrings(values.map(String).filter(Boolean));

	    return plan.sections.map(sec => {
	      const assetIds: string[] = Array.isArray((sec as any).assigned_asset_ids)
	        ? (sec as any).assigned_asset_ids.map((id: unknown) => String(id)).filter(Boolean)
	        : [];
	      const primary: string[] = Array.isArray((sec as any).assigned_claim_ids)
	        ? (sec as any).assigned_claim_ids.map((id: unknown) => String(id)).filter(Boolean)
	        : [];
	      const secondary: string[] = Array.isArray((sec as any).secondary_claim_refs)
	        ? (sec as any).secondary_claim_refs.map((id: unknown) => String(id)).filter(Boolean)
	        : [];
	      return {
	        number: String(sec.number ?? ''),
	        title: String(sec.title ?? ''),
	        type: sec.type,
        assigned_claims: uniq([...primary, ...secondary]),
        assigned_figures: uniq(assetIds.filter(id => figIds.has(id))),
        assigned_equations: uniq(assetIds.filter(id => eqIds.has(id))),
        assigned_tables: uniq(assetIds.filter(id => tabIds.has(id))),
      };
    });
  };

  const toOutlineResultFromPlan = (plan: OutlinePlan, outline_strategy: string): OutlineResult => {
    const outline = toOutlineSectionsFromPlan(plan);
    const { totalClaims, totalAssets } = countOutlineAssignments(outline);
    const budgetRange = WORD_BUDGET_BY_LENGTH[requestedLength] ?? WORD_BUDGET_BY_LENGTH.medium;
    const word_budget = {
      total_target: budgetRange,
      per_section: calculatePerSectionBudget(outline, budgetRange),
    };
    return {
      outline,
      total_claims_assigned: totalClaims,
      total_assets_assigned: totalAssets,
      word_budget,
      cross_ref_map: plan.cross_ref_map,
      structure_rationale: plan.structure_rationale,
      outline_strategy,
      reference_count: refManager.size,
    };
  };

  if (shouldRun('outline')) {
    const idx = stepIndexByKey.outline;
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
    }));

    if (params.llmMode === 'client') {
      const packetRes = await createRunWritingOutlinePlanPacket({
        run_id: params.runId,
        language: outlineRequest.language,
        target_length: outlineRequest.target_length,
        title: outlineRequest.title,
        topic: outlineRequest.topic,
        structure_hints: outlineRequest.structure_hints,
        user_outline: outlineRequest.user_outline,
        claims_table_artifact_name: WRITING_CLAIMS_ARTIFACT,
        output_artifact_name: WRITING_OUTLINE_PLAN_PACKET_ARTIFACT,
      });
      toolArtifacts.push(...packetRes.artifacts);

      const runNow = getRun(params.runId);
      return {
        run_id: params.runId,
        project_id: runNow.project_id,
        manifest_uri: `hep://runs/${encodeURIComponent(params.runId)}/manifest`,
        artifacts: toolArtifacts,
        summary: {
          status: runNow.status,
          steps: Object.fromEntries(order.map(k => [k, runNow.steps[stepIndexByKey[k]]?.status])),
          waiting_for: 'outline_plan_submission',
          prompt_packet_artifact: WRITING_OUTLINE_PLAN_PACKET_ARTIFACT,
        },
        next_actions: packetRes.next_actions,
      };
    }

    const allClaims = claimsTable.claims ?? [];
    const paperCount = claimsTable.corpus_snapshot?.paper_count || claimsTable.corpus_snapshot?.recids?.length || 0;

    let plan: OutlinePlan;
    if (params.llmMode === 'internal') {
      const config = getWritingModeConfig('internal');
      if (!config.llmConfig) {
        throw invalidParams(
          "Outline planning internal mode requires WRITING_LLM_PROVIDER + WRITING_LLM_API_KEY (and optional WRITING_LLM_MODEL); use llm_mode='client' otherwise.",
          { llm_mode: params.llmMode }
        );
      }

      const packet = await planOutline(outlineRequest, 'client');
      if (!packet || typeof packet !== 'object' || !('system_prompt' in packet) || !('user_prompt' in packet)) {
        throw invalidParams('Internal: expected a PromptPacket from planOutline(llm_mode=client)', { run_id: params.runId });
      }

      const client = createLLMClient(config.llmConfig, config.timeout);
      const response = client.generateWithMetadata
        ? (await client.generateWithMetadata((packet as any).user_prompt, (packet as any).system_prompt)).content
        : await client.generate((packet as any).user_prompt, (packet as any).system_prompt);

      let repair: ReturnType<typeof repairAndParseJsonDeterministically>;
      try {
        repair = repairAndParseJsonDeterministically(response);
      } catch (err) {
        const parseErrRef = writeRunJsonArtifact(params.runId, WRITING_OUTLINE_V2_PARSE_ERROR_ARTIFACT, {
          version: 1,
          generated_at: nowIso(),
          run_id: params.runId,
          schema: 'outline_plan_v2@2',
          error_stage: 'json_parse',
          error_message: err instanceof Error ? err.message : String(err),
          llm_response: response,
          prompt_packet: packet,
        });
        toolArtifacts.push(parseErrRef);
        manifest = commit(upsertRunStep({
          runId: params.runId,
          manifest,
          stepIndex: idx,
          update: prev => ({
            ...prev,
            status: 'failed',
            completed_at: nowIso(),
            artifacts: mergeArtifactRefs(prev.artifacts, [parseErrRef]),
            notes: 'OutlinePlanV2 JSON parse failed (see writing_parse_error_outline_v2.json).',
          }),
        }));
        throw invalidParams('OutlinePlanV2 internal mode failed to parse LLM output (see parse error artifact)', {
          run_id: params.runId,
          parse_error_uri: parseErrRef.uri,
          parse_error_artifact: WRITING_OUTLINE_V2_PARSE_ERROR_ARTIFACT,
        });
      }

      const parsed = OutlinePlanV2Schema.safeParse(repair.parsed);
      if (!parsed.success) {
        const parseErrRef = writeRunJsonArtifact(params.runId, WRITING_OUTLINE_V2_PARSE_ERROR_ARTIFACT, {
          version: 1,
          generated_at: nowIso(),
          run_id: params.runId,
          schema: 'outline_plan_v2@2',
          error_stage: 'schema_parse',
          repair_steps: repair.steps,
          repaired_text: repair.repaired_text,
          parsed_json: repair.parsed,
          issues: parsed.error.issues,
          llm_response: response,
          prompt_packet: packet,
        });
        toolArtifacts.push(parseErrRef);
        manifest = commit(upsertRunStep({
          runId: params.runId,
          manifest,
          stepIndex: idx,
          update: prev => ({
            ...prev,
            status: 'failed',
            completed_at: nowIso(),
            artifacts: mergeArtifactRefs(prev.artifacts, [parseErrRef]),
            notes: 'OutlinePlanV2 schema validation failed (see writing_parse_error_outline_v2.json).',
          }),
        }));
        throw invalidParams('OutlinePlanV2 internal mode failed schema validation (see parse error artifact)', {
          run_id: params.runId,
          parse_error_uri: parseErrRef.uri,
          parse_error_artifact: WRITING_OUTLINE_V2_PARSE_ERROR_ARTIFACT,
        });
      }

      const rawPlan = parsed.data;
      const totalSuggestedWords = rawPlan.total_suggested_words ?? rawPlan.sections.reduce((sum, s) => sum + s.suggested_word_count, 0);
      const suggestedCitationCount =
        rawPlan.suggested_citation_count ?? estimateSuggestedCitationCount(requestedLength, paperCount);
      const normalizedPlan: OutlinePlan = {
        ...rawPlan,
        total_suggested_words: totalSuggestedWords,
        suggested_citation_count: suggestedCitationCount,
      };

      validateOutlinePlanV2OrThrow({
        plan: normalizedPlan,
        claims: allClaims as any,
        target_length: requestedLength,
      });

      plan = normalizedPlan;
    } else {
      throw invalidParams("Outline planning requires llm_mode='client' or llm_mode='internal' (passthrough removed).", {
        run_id: params.runId,
        llm_mode: params.llmMode,
        next_actions: [
          {
            tool: 'hep_run_writing_create_outline_candidates_packet_v1',
            args: { run_id: params.runId, language: 'auto', target_length: requestedLength, title: params.title },
            reason: 'M13 client mode: Generate N-best OutlinePlanV2 candidates (N>=2) and judge-select to write writing_outline_v2.json (no bypass).',
          },
        ],
      });
    }

    const outlineRequestMeta = {
      language: outlineRequest.language,
      target_length: outlineRequest.target_length,
      title: outlineRequest.title,
      topic: outlineRequest.topic,
      structure_hints: outlineRequest.structure_hints,
      user_outline: outlineRequest.user_outline,
      claims_artifact_name: WRITING_CLAIMS_ARTIFACT,
    };
    const outlineRef = writeRunJsonArtifact(params.runId, WRITING_OUTLINE_V2_ARTIFACT, {
      version: 2,
      generated_at: nowIso(),
      run_id: params.runId,
      project_id: manifest.project_id,
      request: outlineRequestMeta,
      outline_plan: plan,
    });
    toolArtifacts.push(outlineRef);
    outlineResult = toOutlineResultFromPlan(plan, 'outline_planner_internal');

    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({
        ...prev,
        status: 'done',
        completed_at: nowIso(),
        artifacts: mergeArtifactRefs(prev.artifacts, [outlineRef]),
      }),
    }));
  } else {
    // Load existing outline artifact (v2 only).
    const outlineV2Path = getRunArtifactPath(params.runId, WRITING_OUTLINE_V2_ARTIFACT);
    if (!fs.existsSync(outlineV2Path)) {
      throw invalidParams(`Missing required run artifact: ${WRITING_OUTLINE_V2_ARTIFACT}`, {
        run_id: params.runId,
        artifact_name: WRITING_OUTLINE_V2_ARTIFACT,
        next_actions: [
          {
            tool: 'hep_run_writing_create_outline_candidates_packet_v1',
            args: { run_id: params.runId, language: 'auto', target_length: requestedLength, title: params.title },
            reason: 'M13: Generate N-best OutlinePlanV2 candidates (N>=2) and judge-select to write writing_outline_v2.json (no bypass).',
          },
        ],
      });
    }

    const raw = readRunJsonArtifact(params.runId, WRITING_OUTLINE_V2_ARTIFACT) as any;
    const plan = (raw && typeof raw === 'object' ? (raw as any).outline_plan : undefined) as unknown;
    const parsed = OutlinePlanV2Schema.safeParse(plan);
    if (!parsed.success) {
      throw invalidParams(`Invalid ${WRITING_OUTLINE_V2_ARTIFACT}: outline_plan schema mismatch`, {
        run_id: params.runId,
        issues: parsed.error.issues,
      });
    }
    validateOutlinePlanV2OrThrow({
      plan: parsed.data,
      claims: claimsTable.claims ?? [],
      target_length: requestedLength,
    });
    outlineResult = toOutlineResultFromPlan(parsed.data, 'outline_plan_v2');
    toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_OUTLINE_V2_ARTIFACT, 'application/json'));
  }


  // ── Step: sections (packets + outputs)
  report(4, totalPhases, 'sections');
  const sections = outlineResult.outline as OutlineSection[];
  const sectionTotal = sections.length;

  const effectiveTargetLength = params.targetLength ?? 'medium';
  const claimById = new Map((claimsTable.claims ?? []).map(c => [c.claim_id, c] as const));
  const formulaById = new Map((claimsTable.visual_assets?.formulas ?? []).map(e => [e.evidence_id, e] as const));
  const figureById = new Map((claimsTable.visual_assets?.figures ?? []).map(e => [e.evidence_id, e] as const));
  const tableById = new Map((claimsTable.visual_assets?.tables ?? []).map(e => [e.evidence_id, e] as const));
  const allClaims = claimsTable.claims ?? [];
  const allClaimIds = allClaims.map(c => c.claim_id);
  const allFormulaIds = (claimsTable.visual_assets?.formulas ?? []).map(f => f.evidence_id);
  const allFigureIds = (claimsTable.visual_assets?.figures ?? []).map(f => f.evidence_id);
  const allTableIds = (claimsTable.visual_assets?.tables ?? []).map(t => t.evidence_id);

  const claimPoolForSection = (section: OutlineSection): string[] => {
    const title = String(section.title).toLowerCase();
    const preferred = allClaims.filter(c => {
      if (
        title.includes('method') ||
        title.includes('formula') ||
        title.includes('equation') ||
        title.includes('方法') ||
        title.includes('公式') ||
        title.includes('方程')
      ) {
        return c.category === 'methodology' || c.category === 'theoretical_prediction';
      }
      if (
        title.includes('experiment') ||
        title.includes('figure') ||
        title.includes('comparison') ||
        title.includes('实验') ||
        title.includes('图') ||
        title.includes('对比')
      ) {
        return c.category === 'experimental_result' || c.category === 'interpretation';
      }
      if (
        title.includes('conflict') ||
        title.includes('tension') ||
        title.includes('critical') ||
        title.includes('冲突') ||
        title.includes('张力') ||
        title.includes('批判')
      ) {
        return c.status === 'disputed' || c.status === 'emerging' || c.evidence_grade === 'hint';
      }
      return false;
    });
    return uniqueStrings([...preferred.map(c => c.claim_id), ...allClaimIds]);
  };

  const computeEvidenceIdStats = (packet: WritingPacket): { total: number; by_kind: Record<string, number> } => {
    const sets = {
      text: new Set<string>(),
      formula: new Set<string>(),
      figure: new Set<string>(),
      table: new Set<string>(),
    };

    for (const c of packet.assigned_claims ?? []) {
      const evidence = [
        ...(((c as any).supporting_evidence ?? []) as any[]),
        ...(((c as any).refuting_evidence ?? []) as any[]),
      ];
      for (const ev of evidence) {
        const id = ev?.evidence_id;
        const kind = ev?.kind;
        if (typeof id !== 'string') continue;
        if (kind === 'text') sets.text.add(id);
        else if (kind === 'formula') sets.formula.add(id);
        else if (kind === 'figure') sets.figure.add(id);
        else if (kind === 'table') sets.table.add(id);
      }
    }

    for (const e of packet.assigned_assets?.equations ?? []) sets.formula.add(e.evidence_id);
    for (const e of packet.assigned_assets?.figures ?? []) sets.figure.add(e.evidence_id);
    for (const e of packet.assigned_assets?.tables ?? []) sets.table.add(e.evidence_id);

    const union = new Set<string>();
    for (const s of Object.values(sets)) for (const id of s) union.add(id);

    return {
      total: union.size,
      by_kind: {
        text: sets.text.size,
        formula: sets.formula.size,
        figure: sets.figure.size,
        table: sets.table.size,
      },
    };
  };

  const buildPackets = (): { packets: WritingPacketsArtifactV1; quotas: any; asset_injection: any; quotaWarnings: string[] } => {
    const now = nowIso();
    const quotaWarnings: string[] = [];
    const quotaSections: any[] = [];
    const assetInjectionSections: any[] = [];

    const budgets = (outlineResult as any)?.word_budget?.per_section;
    const budgetBySectionNumber = new Map<string, { min_words: number; max_words: number }>(
      Array.isArray(budgets)
        ? budgets
          .map((b: any) => ({
            section_number: String(b?.section_number ?? ''),
            min_words: Number(b?.min_words ?? 0),
            max_words: Number(b?.max_words ?? 0),
          }))
          .filter((b: any) => b.section_number)
          .map((b: any) => [b.section_number, { min_words: b.min_words, max_words: b.max_words }] as const)
        : []
    );

    const truncateClaim = (text: string, maxLen: number) => {
      const s = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (s.length <= maxLen) return s;
      return s.slice(0, Math.max(0, maxLen - 3)) + '...';
    };

    const toc = sections.map((s: OutlineSection) => {
      const key_claims = (s.assigned_claims ?? []).slice(0, 3).map(id => {
        const c = claimById.get(id);
        return c?.claim_text ? truncateClaim(String(c.claim_text), 120) : String(id);
      });
      const key_assets = uniqueStrings([
        ...(s.assigned_equations ?? []),
        ...(s.assigned_figures ?? []),
        ...(s.assigned_tables ?? []),
      ]).slice(0, 6);

      return {
        section_number: s.number,
        title: s.title,
        type: s.type,
        key_claims,
        key_assets,
      };
    });

    const crossRefMap = (() => {
      const m = (outlineResult as any)?.cross_ref_map;
      if (m && typeof m === 'object' && Array.isArray((m as any).defines) && Array.isArray((m as any).uses)) {
        return m as any;
      }
      return {
        defines: sections.map(s => ({ section: s.number, concept: s.title })),
        uses: sections.slice(1).map((s, i) => ({ section: s.number, concept: sections[i].title, defined_in: sections[i].number })),
      };
    })();

    const writingPackets = sections.map((section: OutlineSection, i) => {
      const idx = i + 1;
      const quotas: EvidenceQuotas =
        EVIDENCE_QUOTAS_BY_LENGTH[effectiveTargetLength][section.type] ?? EVIDENCE_QUOTAS_BY_LENGTH[effectiveTargetLength].body;

      const claimPool = claimPoolForSection(section);
      const claimSel = ensureMinFromPool(section.assigned_claims ?? [], quotas.min_claims, claimPool);
      const eqSel = ensureMinFromPool(section.assigned_equations ?? [], quotas.min_equations, allFormulaIds);
      const figSel = ensureMinFromPool(section.assigned_figures ?? [], quotas.min_figures, allFigureIds);
      const tabSel = ensureMinFromPool(section.assigned_tables ?? [], quotas.min_tables, allTableIds);

      const claims = claimSel.selected.map(id => claimById.get(id)).filter(isDefined);
      const figures = figSel.selected.map(id => figureById.get(id)).filter(isDefined);
      const equations = eqSel.selected.map(id => formulaById.get(id)).filter(isDefined);
      const tables = tabSel.selected.map(id => tableById.get(id)).filter(isDefined);

      const packet = buildWritingPacket(
        { number: section.number, title: section.title, type: section.type },
        claims, figures, equations, tables,
        { topic: params.topic, title: params.title, language: params.language }
      );

      // Phase 0 word budget + global context (cross-section awareness)
      const sectionBudget = budgetBySectionNumber.get(section.number);
      if (sectionBudget && Number.isFinite(sectionBudget.min_words) && Number.isFinite(sectionBudget.max_words)) {
        packet.word_budget = { min_words: Math.max(0, Math.trunc(sectionBudget.min_words)), max_words: Math.max(0, Math.trunc(sectionBudget.max_words)) };
      }

      const this_section_defines = Array.isArray(crossRefMap?.defines)
        ? crossRefMap.defines.filter((d: any) => String(d?.section) === String(section.number)).map((d: any) => String(d?.concept)).filter(Boolean)
        : [];
      const this_section_may_reference = Array.isArray(crossRefMap?.uses)
        ? crossRefMap.uses.filter((u: any) => String(u?.section) === String(section.number)).map((u: any) => String(u?.concept)).filter(Boolean)
        : [];
      const later_sections_will_use = Array.isArray(crossRefMap?.uses)
        ? crossRefMap.uses.filter((u: any) => String(u?.defined_in) === String(section.number)).map((u: any) => String(u?.concept)).filter(Boolean)
        : [];

      packet.global_context = {
        paper_title: String(params.title ?? ''),
        paper_topic: String(params.topic ?? ''),
        toc,
        cross_ref_hints: { this_section_defines, this_section_may_reference, later_sections_will_use },
      };

      // Apply quotas to packet constraints/instructions for short→medium→long scaling.
      // Only modify if using hard constraints (DepthConfig); soft constraints don't need modification.
      if (isDepthConfig(packet.constraints)) {
        const nextConstraints = { ...packet.constraints };
        nextConstraints.min_equations = quotas.min_equations;
        nextConstraints.min_figures = quotas.min_figures;
        nextConstraints.min_tables = quotas.min_tables;
        if (effectiveTargetLength === 'short') {
          nextConstraints.min_paragraphs = Math.max(2, Math.floor(nextConstraints.min_paragraphs * 0.75));
        } else if (effectiveTargetLength === 'long') {
          nextConstraints.min_paragraphs = Math.max(nextConstraints.min_paragraphs + 1, Math.ceil(nextConstraints.min_paragraphs * 1.25));
        }
        packet.constraints = nextConstraints;
      }
      packet.instructions.requirements = [
        ...packet.instructions.requirements,
        `Evidence quotas: ≥${quotas.min_claims} claims, ≥${quotas.min_equations} equations, ≥${quotas.min_figures} figures, ≥${quotas.min_tables} tables.`,
      ];

      // Asset injection selection (top-K) must match what is injected into the prompt + verified post-hoc.
      const suggested_word_count = packet.word_budget && Number.isFinite(packet.word_budget.min_words) && Number.isFinite(packet.word_budget.max_words)
        ? Math.round((packet.word_budget.min_words + packet.word_budget.max_words) / 2)
        : undefined;
      const assetSelection = selectAssetsForInjection(packet.assigned_assets, { suggested_word_count });
      packet.assigned_assets = assetSelection.selected;
      assetInjectionSections.push({
        index: idx,
        section_number: section.number,
        section_title: section.title,
        diagnostics: assetSelection.diagnostics,
      });

      const evidenceStats = computeEvidenceIdStats(packet);
      if (claimSel.shortage > 0 || eqSel.shortage > 0 || figSel.shortage > 0 || tabSel.shortage > 0) {
        quotaWarnings.push(
          `evidence_quota_shortage: section=${section.number} missing claims=${claimSel.shortage} equations=${eqSel.shortage} figures=${figSel.shortage} tables=${tabSel.shortage}`
        );
      }
      if (evidenceStats.total < quotas.min_evidence_ids) {
        quotaWarnings.push(
          `evidence_id_quota_shortage: section=${section.number} required=${quotas.min_evidence_ids} observed=${evidenceStats.total}`
        );
      }

      quotaSections.push({
        index: idx,
        section_number: section.number,
        section_title: section.title,
        section_type: section.type,
        quotas,
        assigned: {
          claims: packet.assigned_claims.length,
          equations: packet.assigned_assets.equations.length,
          figures: packet.assigned_assets.figures.length,
          tables: packet.assigned_assets.tables.length,
          evidence_ids_total: evidenceStats.total,
          evidence_ids_by_kind: evidenceStats.by_kind,
        },
      });

      return {
        index: idx,
        section_number: section.number,
        section_title: section.title,
        prompt: buildPromptFromPacket(packet),
        packet,
      };
    });

    return {
      packets: {
        version: 1,
        generated_at: now,
        run_id: params.runId,
        topic: params.topic,
        title: params.title,
        language: params.language,
        target_length: effectiveTargetLength,
        quality_level: params.quality?.quality_level,
        structure_hints: params.quality?.structure_hints,
        llm_mode_requested: params.llmMode,
        sections: writingPackets,
      },
      quotas: {
        version: 1,
        generated_at: now,
        run_id: params.runId,
        target_length: effectiveTargetLength,
        sections: quotaSections,
        warnings: quotaWarnings,
      },
      asset_injection: {
        version: 1,
        generated_at: now,
        run_id: params.runId,
        target_length: effectiveTargetLength,
        sections: assetInjectionSections,
      },
      quotaWarnings,
    };
  };

  if (shouldRun('sections')) {
    const idx = stepIndexByKey.sections;
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
    }));

    // Packets (always)
    const built = buildPackets();
    packets = built.packets;
    warnings.push(...built.quotaWarnings);
    const packetsRef = writeRunJsonArtifact(params.runId, WRITING_PACKETS_ARTIFACT, packets);
    const quotasRef = writeRunJsonArtifact(params.runId, WRITING_EVIDENCE_QUOTAS_ARTIFACT, built.quotas);
    const assetInjectionRef = writeRunJsonArtifact(params.runId, WRITING_ASSET_INJECTION_DIAGNOSTICS_ARTIFACT, built.asset_injection);
    toolArtifacts.push(packetsRef, quotasRef, assetInjectionRef);

    const expectedOutputSchema = zodToMcpInputSchema(SectionOutputSubmissionSchema);

    // Client continuation artifact (lightweight, points to packets)
    const bibtexKeys = refManager.size > 0 ? refManager.getAllKeys().join(', ') : '(none)';
    const clientInstructions = params.language === 'zh' ? CLIENT_INSTRUCTIONS_ZH(bibtexKeys) : CLIENT_INSTRUCTIONS_EN(bibtexKeys);
    const clientContinuation = {
      version: 1 as const,
      generated_at: nowIso(),
      run_id: params.runId,
      action: 'GENERATE_DEEP_CONTENT' as const,
      language: params.language,
      system_prompt: params.language === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN,
      instructions: clientInstructions,
      writing_packets_uri: packetsRef.uri,
      expected_output_schema: expectedOutputSchema,
      formatted_prompts: packets.sections.map(s => ({
        section_index: s.index,
        section_number: s.section_number,
        section_title: s.section_title,
        prompt: s.prompt,
      })),
      next_tools: ['hep_run_writing_create_section_candidates_packet_v1'],
    };
    const continuationRef = writeRunJsonArtifact(params.runId, WRITING_CLIENT_CONTINUATION_ARTIFACT, clientContinuation);
    toolArtifacts.push(continuationRef);

    // Unified LLM request artifact (for client/internal/passthrough parity + debugging).
    const internalCfg = params.llmMode === 'internal' ? getWritingModeConfig('internal') : undefined;
    const llmRequestRef = writeRunJsonArtifact(params.runId, WRITING_LLM_REQUEST_ARTIFACT, {
      version: 1,
      generated_at: nowIso(),
      run_id: params.runId,
      llm_mode_requested: params.llmMode,
      refinement: params.refinement,
      language: params.language,
      writing_packets_uri: packetsRef.uri,
      system_prompt: params.language === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN,
      prompts: packets.sections.map(s => ({
        section_index: s.index,
        section_number: s.section_number,
        section_title: s.section_title,
        prompt: s.prompt,
      })),
      expected_output_schema: expectedOutputSchema,
      submit_tool: {
        name: 'hep_run_writing_create_section_candidates_packet_v1',
        args_template: { run_id: params.runId, section_index: '<section_index>' },
      },
      internal: params.llmMode === 'internal'
        ? {
          configured: Boolean(internalCfg?.llmConfig),
          provider: internalCfg?.llmConfig?.provider,
          model: internalCfg?.llmConfig?.model,
          base_url: internalCfg?.llmConfig?.baseUrl,
          temperature: internalCfg?.llmConfig?.temperature,
          max_tokens: internalCfg?.llmConfig?.maxTokens,
          timeout_ms: internalCfg?.timeout,
          max_retries: internalCfg?.maxRetries,
        }
        : undefined,
    });
    toolArtifacts.push(llmRequestRef);

    // Internal/passthrough: generate section outputs now. Client: stop here (waiting for submissions).
    const sectionRefs: RunArtifactRef[] = [];
    let llmResponseRef: RunArtifactRef | undefined;

    if (params.llmMode !== 'client') {
      const concurrencyLimit = parseConcurrencyLimit(process.env.CONCURRENCY_LIMIT);
      const sectionLimit = pLimit(concurrencyLimit);

      const results = await Promise.all(
        packets.sections.map((s) => sectionLimit(async () => {
          const artifactName = `writing_section_${pad3(s.index)}.json`;
          const artifactPath = getRunArtifactPath(params.runId, artifactName);

          if (!explicitResume && fs.existsSync(artifactPath)) {
            return {
              sectionRef: makeRunArtifactRef(params.runId, artifactName, 'application/json'),
              llm: params.llmMode === 'internal'
                ? { section_index: s.index, section_number: s.section_number, section_title: s.section_title, skipped: true }
                : undefined,
            };
          }

          const sectionResult = await executeSectionWithLLM(s.packet, params.llmMode, refManager, params.refinement);
          const payload: WritingSectionArtifactV1 = {
            version: 1,
            generated_at: nowIso(),
            run_id: params.runId,
            section_index: s.index,
            section_number: s.section_number,
            section_title: s.section_title,
            mode_used: sectionResult.mode_used,
            bibtex_keys_used: sectionResult.bibtex_keys_used,
            section_output: sectionResult.section_output,
          };

          const ref = writeRunJsonArtifact(params.runId, artifactName, payload);
          return {
            sectionRef: ref,
            llm: params.llmMode === 'internal'
              ? {
                section_index: s.index,
                section_number: s.section_number,
                section_title: s.section_title,
                mode_used: sectionResult.mode_used,
                ...(sectionResult.llm_log ?? {}),
              }
              : undefined,
          };
        }))
      );

      const llmEntries: Array<Record<string, unknown>> = [];
      for (const r of results) {
        sectionRefs.push(r.sectionRef);
        if (r.llm) llmEntries.push(r.llm);
      }

      if (params.llmMode === 'internal') {
        const responsePath = getRunArtifactPath(params.runId, WRITING_LLM_RESPONSE_ARTIFACT);
        const responseRef = explicitResume || !fs.existsSync(responsePath)
          ? writeRunJsonArtifact(params.runId, WRITING_LLM_RESPONSE_ARTIFACT, {
            version: 1,
            generated_at: nowIso(),
            run_id: params.runId,
            llm_mode_requested: params.llmMode,
            sections: llmEntries.sort((a, b) => Number(a.section_index) - Number(b.section_index)),
            note: 'API keys are never stored; 401/403 indicates missing/invalid key. Prompts/responses are for local auditing only.',
          })
          : makeRunArtifactRef(params.runId, WRITING_LLM_RESPONSE_ARTIFACT, 'application/json');
        toolArtifacts.push(responseRef);
        llmResponseRef = responseRef;
      }
    }

    const nextArtifacts = mergeArtifactRefs(
      manifest.steps[idx]?.artifacts,
      [packetsRef, quotasRef, assetInjectionRef, continuationRef, llmRequestRef, ...(llmResponseRef ? [llmResponseRef] : []), ...sectionRefs]
    );
    const sectionsDone = params.llmMode !== 'client' && sectionRefs.length === sectionTotal;

    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({
        ...prev,
        status: sectionsDone ? 'done' : 'in_progress',
        completed_at: sectionsDone ? nowIso() : undefined,
        artifacts: nextArtifacts,
        notes: params.llmMode === 'client'
          ? 'Client mode: writing packets ready; follow M13 N-best section pipeline via hep_run_writing_create_section_candidates_packet_v1'
          : prev.notes,
      }),
    }));
  } else {
    packets = readRunJsonArtifact(params.runId, WRITING_PACKETS_ARTIFACT) as WritingPacketsArtifactV1;
    toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_PACKETS_ARTIFACT, 'application/json'));
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_EVIDENCE_QUOTAS_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_EVIDENCE_QUOTAS_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_ASSET_INJECTION_DIAGNOSTICS_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_ASSET_INJECTION_DIAGNOSTICS_ARTIFACT, 'application/json'));
    }
    if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CLIENT_CONTINUATION_ARTIFACT))) {
      toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_CLIENT_CONTINUATION_ARTIFACT, 'application/json'));
    }
  }

  // If we cannot proceed beyond packets (client workflow), return next actions.
  const sectionsReady = countDoneSectionArtifacts(params.runId, sectionTotal, 'section');
  if (params.llmMode === 'client' && sectionsReady < sectionTotal && (shouldRun('verify') || shouldRun('originality') || shouldRun('review'))) {
    const run = getRun(params.runId);
    const summaryRef = writeRunJsonArtifact(params.runId, WRITING_SUMMARY_ARTIFACT, {
      version: 1,
      generated_at: nowIso(),
      run_id: params.runId,
      steps: Object.fromEntries(order.map(k => [k, manifest.steps[stepIndexByKey[k]]?.status])),
      sections: { total: sectionTotal, ready: sectionsReady },
      note: 'Waiting for client section submissions',
    });
    toolArtifacts.push(summaryRef);
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: stepIndexByKey.sections,
      update: prev => ({
        ...prev,
        artifacts: mergeArtifactRefs(prev.artifacts, [summaryRef]),
      }),
    }));

    return {
      run_id: params.runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(params.runId)}/manifest`,
      artifacts: toolArtifacts,
      summary: {
        topic: params.topic,
        title: params.title,
        llm_mode_requested: params.llmMode,
        steps: Object.fromEntries(order.map(k => [k, manifest.steps[stepIndexByKey[k]]?.status])),
        sections: { total: sectionTotal, ready: sectionsReady },
      },
      next_actions: packets.sections.slice(0, 1).map(s => ({
        tool: 'hep_run_writing_create_section_candidates_packet_v1',
        args: { run_id: params.runId, section_index: s.index },
        reason: 'M13: Create N-best section candidates packet (N>=2), then follow next_actions to stage candidates → judge → verifiers (fail-fast; no bypass).',
      })),
    };
  }

  // ── Step: verify
  report(5, totalPhases, 'verify');
  let verifyIssuesTotal = 0;
  if (shouldRun('verify')) {
    const idx = stepIndexByKey.verify;
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
    }));

    const verificationRefs: RunArtifactRef[] = [];
    for (const s of packets.sections) {
      const sectionArtifact = readRunJsonArtifact<WritingSectionArtifactV1>(params.runId, `writing_section_${pad3(s.index)}.json`);
      const verify = handleVerifyCitations(
        {
          section_output: sectionArtifact.section_output,
          claims_table: claimsTable,
          allowed_citations: s.packet.allowed_citations,
        },
        { referenceManager: refManager }
      ) as VerifyCitationsResult & { bibtex_keys_verified: string[] };
      verifyIssuesTotal += verify.issues.length;

      const payload: WritingVerificationArtifactV1 = {
        version: 1,
        generated_at: nowIso(),
        run_id: params.runId,
        section_index: s.index,
        section_number: s.section_number,
        section_title: s.section_title,
        verification: verify,
      };
      const artifactName = `writing_verification_${pad3(s.index)}.json`;
      const ref = writeRunJsonArtifact(params.runId, artifactName, payload);
      verificationRefs.push(ref);
    }

    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({
        ...prev,
        status: 'done',
        completed_at: nowIso(),
        artifacts: mergeArtifactRefs(prev.artifacts, verificationRefs),
      }),
    }));
  }

  // ── Step: originality
  report(6, totalPhases, 'originality');
  let originalityCriticalTotal = 0;
  if (shouldRun('originality')) {
    const idx = stepIndexByKey.originality;
    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({ ...prev, status: 'in_progress', started_at: nowIso(), completed_at: undefined }),
    }));

    const sourceEvidences = claimsTable.claims.flatMap(c => c.supporting_evidence);
    const originalityRefs: RunArtifactRef[] = [];

    for (const s of packets.sections) {
      const sectionArtifact = readRunJsonArtifact<WritingSectionArtifactV1>(params.runId, `writing_section_${pad3(s.index)}.json`);
      const content = String(sectionArtifact.section_output.content ?? '');

      const orig = content.trim().length === 0
        ? ({
          level: 'acceptable',
          is_acceptable: true,
          needs_review: false,
          max_overlap: 0,
          flagged_count: 0,
          recommendation: 'Section has no content to check.',
        } as unknown as CheckOriginalityResult & { recommendation: string })
        : (handleCheckOriginality({
          generated_text: content,
          source_evidences: sourceEvidences,
        }) as CheckOriginalityResult & { recommendation: string });

      if (orig.level === 'critical') originalityCriticalTotal += 1;

      const payload: WritingOriginalityArtifactV1 = {
        version: 1,
        generated_at: nowIso(),
        run_id: params.runId,
        section_index: s.index,
        section_number: s.section_number,
        section_title: s.section_title,
        originality: orig,
      };
      const artifactName = `writing_originality_${pad3(s.index)}.json`;
      const ref = writeRunJsonArtifact(params.runId, artifactName, payload);
      originalityRefs.push(ref);
    }

    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({
        ...prev,
        status: 'done',
        completed_at: nowIso(),
        artifacts: mergeArtifactRefs(prev.artifacts, originalityRefs),
      }),
    }));
  }

  // ── Phase 2: full-document integration (M12.3)
  let phase2Integration: Record<string, unknown> | undefined;
  const sectionsReadyNow = countDoneSectionArtifacts(params.runId, sectionTotal, 'section');
  const qualityLevel = params.quality?.quality_level ?? 'standard';
  if (sectionsReadyNow >= sectionTotal) {
    try {
      const phase2 = qualityLevel === 'standard'
        ? ({
          run_id: params.runId,
          fix_unused_materials: true,
          add_cross_references: true,
          unify_terminology: false,
          final_polish: false,
          max_retries: params.quality?.phase2_options?.max_retries,
        } as const)
        : ({
          run_id: params.runId,
          fix_unused_materials: true,
          add_cross_references: true,
          unify_terminology: true,
          final_polish: true,
          max_retries: params.quality?.phase2_options?.max_retries,
        } as const);

      const res = await integrateWritingSections(phase2);
      toolArtifacts.push(...res.artifacts);
      phase2Integration = {
        quality_level: qualityLevel,
        ...res.summary,
      } as Record<string, unknown>;

      // integrateWritingSections mutates the run manifest; refresh local view to avoid overwriting the new step.
      manifest = getRun(params.runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const phase2ErrorRef = writeRunJsonArtifact(params.runId, 'writing_phase2_integration_error_v1.json', {
        version: 1,
        generated_at: nowIso(),
        run_id: params.runId,
        quality_level: qualityLevel,
        error: msg,
      });
      toolArtifacts.push(phase2ErrorRef);

      const now = nowIso();
      const phase2StepIdx = manifest.steps.findIndex(s => s.step === 'writing_integrate');
      if (phase2StepIdx >= 0) {
        manifest = {
          ...manifest,
          updated_at: now,
          steps: manifest.steps.map((s, idx) =>
            idx === phase2StepIdx
              ? {
                ...s,
                status: 'failed',
                completed_at: now,
                notes: `Phase2 integration failed: ${msg}`,
                artifacts: mergeArtifactRefs(s.artifacts, [phase2ErrorRef]),
              }
              : s
          ),
        };
      } else {
        manifest = {
          ...manifest,
          updated_at: now,
          steps: [
            ...manifest.steps,
            {
              step: 'writing_integrate',
              status: 'failed',
              started_at: now,
              completed_at: now,
              artifacts: [phase2ErrorRef],
              notes: `Phase2 integration failed: ${msg}`,
            },
          ],
        };
      }

      manifest = commit(manifest);
      throw invalidParams('Phase2 integration failed (fail-fast)', {
        run_id: params.runId,
        phase2_error_uri: phase2ErrorRef.uri,
        phase2_error_artifact: 'writing_phase2_integration_error_v1.json',
        next_actions: [
          {
            tool: 'inspire_deep_research',
            args: {
              identifiers: params.identifiers,
              mode: 'write',
              run_id: params.runId,
              resume_from: 'review',
              options: {
                topic: params.topic,
                title: params.title,
                target_length: params.targetLength,
                quality_level: qualityLevel,
                structure_hints: params.quality?.structure_hints,
                user_outline: params.quality?.user_outline,
                outline_policy: params.quality?.outline_policy,
                phase0_options: params.quality?.phase0_options,
                phase1_options: params.quality?.phase1_options,
                phase2_options: params.quality?.phase2_options,
                llm_mode: params.llmMode,
                max_section_retries: params.refinement?.max_section_retries,
                auto_fix_originality: params.refinement?.auto_fix_originality,
                auto_fix_citations: params.refinement?.auto_fix_citations,
                language: params.language,
              },
            },
            reason: 'Retry Phase2 integration after addressing the error.',
          },
        ],
      });
    }
  }

  // ── Step: review (peer-reviewer role; client-submitted report)
  report(7, totalPhases, 'review');
  let reviewerSummary: Record<string, unknown> | undefined;
  if (shouldRun('review')) {
    const idx = stepIndexByKey.review;
    const reportPath = getRunArtifactPath(params.runId, WRITING_REVIEW_REPORT_ARTIFACT);

    if (!fs.existsSync(reportPath)) {
      const makeUri = (name: string) => `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(name)}`;
      const truncate = (text: string, maxChars: number) => {
        const s = String(text ?? '');
        if (s.length <= maxChars) return s;
        return s.slice(0, Math.max(0, maxChars - 3)) + '...';
      };

      const integratedExists = fs.existsSync(getRunArtifactPath(params.runId, 'writing_integrated.tex'));
      const criticalSummary = fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT))
        ? readRunJsonArtifact<any>(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT)
        : undefined;
      const conflictsTotal = Number(criticalSummary?.conflicts?.total ?? 0);
      const conflictsTop = Array.isArray(criticalSummary?.conflicts?.top) ? (criticalSummary.conflicts.top as any[]).slice(0, 5) : [];

      const glossary = Array.isArray((claimsTable as any)?.glossary) ? ((claimsTable as any).glossary as any[]) : [];
      const notation = Array.isArray((claimsTable as any)?.notation_table) ? ((claimsTable as any).notation_table as any[]) : [];

      const contextParts: string[] = [];
      contextParts.push('# Reviewer Context (compact)');
      contextParts.push('');
      contextParts.push(`Run: ${params.runId}`);
      contextParts.push(`Topic: ${params.topic}`);
      contextParts.push(`Title: ${params.title}`);
      contextParts.push(`quality_level: ${params.quality?.quality_level ?? 'standard'}`);
      contextParts.push(`target_length: ${params.targetLength ?? 'medium'}`);
      contextParts.push('');
      contextParts.push('## Key Artifacts (URIs)');
      contextParts.push(`- quality_policy: ${makeUri('writing_quality_policy_v1.json')}`);
      contextParts.push(`- claims_table: ${makeUri(WRITING_CLAIMS_ARTIFACT)}`);
      if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_OUTLINE_V2_ARTIFACT))) {
        contextParts.push(`- outline_v2: ${makeUri(WRITING_OUTLINE_V2_ARTIFACT)}`);
      }
      contextParts.push(`- packets: ${makeUri(WRITING_PACKETS_ARTIFACT)}`);
      if (integratedExists) contextParts.push(`- integrated_tex: ${makeUri('writing_integrated.tex')}`);
      if (fs.existsSync(getRunArtifactPath(params.runId, 'writing_integrate_diagnostics.json'))) {
        contextParts.push(`- integrate_diagnostics: ${makeUri('writing_integrate_diagnostics.json')}`);
      }
      if (fs.existsSync(getRunArtifactPath(params.runId, WRITING_CRITICAL_SUMMARY_ARTIFACT))) {
        contextParts.push(`- critical_summary: ${makeUri(WRITING_CRITICAL_SUMMARY_ARTIFACT)}`);
      }
      contextParts.push('');

      contextParts.push('## Section Gate Summaries (verification/originality/packet)');
      const sortedSections = packets.sections.slice().sort((a, b) => a.index - b.index);
      for (const s of sortedSections) {
        const verificationName = `writing_verification_${pad3(s.index)}.json`;
        const originalityName = `writing_originality_${pad3(s.index)}.json`;

        const verification = fs.existsSync(getRunArtifactPath(params.runId, verificationName))
          ? readRunJsonArtifact<any>(params.runId, verificationName)
          : null;
        const originality = fs.existsSync(getRunArtifactPath(params.runId, originalityName))
          ? readRunJsonArtifact<any>(params.runId, originalityName)
          : null;

        const issues = verification && Array.isArray(verification?.verification?.issues)
          ? verification.verification.issues.length
          : null;
        const origLevel = originality && typeof originality?.originality?.level === 'string'
          ? originality.originality.level
          : null;

        const claimsAssigned = Array.isArray((s as any)?.packet?.assigned_claims) ? (s as any).packet.assigned_claims.length : 0;
        const equationsAssigned = Array.isArray((s as any)?.packet?.assigned_assets?.equations) ? (s as any).packet.assigned_assets.equations.length : 0;
        const figuresAssigned = Array.isArray((s as any)?.packet?.assigned_assets?.figures) ? (s as any).packet.assigned_assets.figures.length : 0;
        const tablesAssigned = Array.isArray((s as any)?.packet?.assigned_assets?.tables) ? (s as any).packet.assigned_assets.tables.length : 0;
        const allowedCitations = Array.isArray((s as any)?.packet?.allowed_citations) ? (s as any).packet.allowed_citations.length : 0;

        contextParts.push([
          `- ${String(s.section_number)} ${String(s.section_title)}:`,
          `verification_issues=${issues === null ? 'MISSING' : String(issues)} (${makeUri(verificationName)}),`,
          `originality_level=${origLevel === null ? 'MISSING' : String(origLevel)} (${makeUri(originalityName)}),`,
          `packet_claims=${claimsAssigned} packet_assets=(eq=${equationsAssigned} fig=${figuresAssigned} tab=${tablesAssigned}) allowed_citations=${allowedCitations} (from ${makeUri(WRITING_PACKETS_ARTIFACT)})`,
        ].join(' '));
      }
      contextParts.push('');

      contextParts.push('## Reviewer Checklist (must be strict)');
      contextParts.push('- Correctness + internal consistency (logic, definitions, units, sign conventions)');
      contextParts.push('- Evidence/claims traceability and citation discipline');
      contextParts.push('- Figures/equations/tables: at least one adjacent substantive discussion; additional cross-paragraph/section mentions must include explicit pointers (Eq[...]/Fig[...]/Table[...] or \\eqref/\\ref)');
      contextParts.push('- Measurement vs inference: treat BOTH experiment and theory papers as possibly inference-heavy; judge reliability by methodology/assumptions/systematics, not by label');
      contextParts.push('- If you unify notation/sign/factor vs a source, you MUST require a prominent explicit note in text and list the note to insert');
      contextParts.push('');

      if (conflictsTotal > 0) {
        contextParts.push('## Conflicts Summary (from writing_critical)');
        contextParts.push(`Total conflicts: ${conflictsTotal}`);
        for (const c of conflictsTop) {
          const quantity = String((c as any)?.quantity ?? '');
          const sigma = Number((c as any)?.tension_sigma ?? 0);
          contextParts.push(`- ${quantity}: tension ~${sigma.toFixed(2)}σ`);
        }
        contextParts.push('');
      }

      if (notation.length > 0) {
        contextParts.push('## Notation Table (sample)');
        for (const n of notation.slice(0, 20)) {
          const symbol = String((n as any)?.symbol ?? '').trim();
          const meaning = String((n as any)?.meaning ?? '').trim();
          if (!symbol || !meaning) continue;
          contextParts.push(`- ${symbol}: ${truncate(meaning, 140)}`);
        }
        contextParts.push('');
      }

      if (glossary.length > 0) {
        contextParts.push('## Glossary (sample)');
        for (const g of glossary.slice(0, 20)) {
          const term = String((g as any)?.term ?? '').trim();
          const def = String((g as any)?.definition ?? '').trim();
          if (!term || !def) continue;
          contextParts.push(`- ${term}: ${truncate(def, 140)}`);
        }
        contextParts.push('');
      }

      contextParts.push('## Section Excerpts (truncated; full URIs included)');
      const maxSectionChars = 1200;
      const maxTotalChars = 20_000;
      let usedChars = contextParts.join('\n').length;

      for (const s of sortedSections) {
        const secName = `writing_section_${pad3(s.index)}.json`;
        const secPath = getRunArtifactPath(params.runId, secName);
        if (!fs.existsSync(secPath)) continue;
        const sec = readRunJsonArtifact<WritingSectionArtifactV1>(params.runId, secName);
        const content = typeof (sec as any)?.section_output?.content === 'string' ? String((sec as any).section_output.content) : '';
        const header = `### ${String(s.section_number)} ${String(s.section_title)}`.trim();
        const excerpt = truncate(content, maxSectionChars);
        const excerptSuffix = content.length > maxSectionChars ? '\n...(truncated: per-section excerpt cap)...' : '';
        const block = `${header}\nFull: ${makeUri(secName)}\n\n\`\`\`latex\n${excerpt}${excerptSuffix}\n\`\`\`\n`;
        if (usedChars + block.length > maxTotalChars) {
          contextParts.push('...(truncated: context budget reached)...');
          break;
        }
        contextParts.push(block);
        usedChars += block.length;
      }

      const prompt = [
        '# Task: Critical Peer Review (Reviewer Round)',
        '',
        'You are acting as a careful, critical reviewer for a high-energy physics review article.',
        '',
        'Inputs:',
        `- Reviewer context: ${makeUri(WRITING_REVIEW_CONTEXT_ARTIFACT)}`,
        integratedExists ? `- Full integrated TeX (may be long): ${makeUri('writing_integrated.tex')}` : `- Section outputs: ${makeUri('writing_section_001.json')} (and others)`,
        '',
        'Output requirement:',
        'Return ONLY valid JSON (no Markdown fences) that matches ReviewerReport v2 EXACTLY:',
        '',
        '{',
        '  "version": 2,',
        '  "severity": "none" | "minor" | "major",',
        '  "summary": "1-3 paragraphs reviewer summary",',
        '  "iteration_entry": "outline" | "sections" (REQUIRED if severity="major"),',
        '  "major_issues": [',
        '    { "title": "...", "description": "...", "suggested_fix": "...", "affected_sections": ["2","3"] }',
        '  ],',
        '  "minor_issues": [',
        '    { "title": "...", "description": "...", "suggested_fix": "...", "affected_sections": ["2.1"] }',
        '  ],',
        '  "notation_changes": [',
        '    { "symbol": "...", "reason": "...", "from": "...", "to": "...", "must_highlight_in_text": true, "note_to_insert": "Explicit note to add to the paper" }',
        '  ],',
        '  "asset_pointer_issues": [',
        '    { "asset": "Eq[...]/Fig[...]/Table[...]", "problem": "...", "fix": "..." }',
        '  ],',
        '  "follow_up_evidence_queries": [',
        '    { "section_number": "2.1", "query": "...", "purpose": "...", "expected_evidence_kinds": ["paper","equation"] }',
        '  ],',
        '  "structure_issues": [',
        '    { "type": "overlap" | "missing_prereq" | "bad_order" | "weak_transition", "affected_sections": ["2","3"], "suggestion": "..." }',
        '  ],',
        '  "grounding_risks": [',
        '    { "section_number": "3", "claim_like_text": "...", "why_risky": "...", "suggested_fix": "..." }',
        '  ]',
        '}',
        '',
        'IMPORTANT:',
        '- Include ALL arrays even if empty.',
        '- Do not add extra keys. The JSON must validate under a strict schema.',
        '',
        'Hard reviewer rules:',
        '- Be specific and actionable (each issue should include concrete suggested fixes).',
        '- If notation/sign/factor differs across sources, propose a unified convention AND require an explicit prominent note; never silently change conventions.',
        '- Do not assume "experiment=measurement" and "theory=inference"; treat both as inference chains with assumptions and judge reliability accordingly.',
      ].join('\n');

      const promptRef = writeRunTextArtifact({
        runId: params.runId,
        artifactName: WRITING_REVIEW_PROMPT_ARTIFACT,
        content: prompt + '\n',
        mimeType: 'text/markdown',
      });
      const contextRef = writeRunTextArtifact({
        runId: params.runId,
        artifactName: WRITING_REVIEW_CONTEXT_ARTIFACT,
        content: contextParts.join('\n') + '\n',
        mimeType: 'text/markdown',
      });
      toolArtifacts.push(promptRef, contextRef);

      manifest = commit(upsertRunStep({
        runId: params.runId,
        manifest,
        stepIndex: idx,
        update: prev => ({
          ...prev,
          status: 'in_progress',
          started_at: prev.started_at ?? nowIso(),
          completed_at: undefined,
          artifacts: mergeArtifactRefs(prev.artifacts, [promptRef, contextRef]),
          notes: 'Waiting for reviewer report via hep_run_writing_submit_review',
        }),
      }));

      const run = getRun(params.runId);
      const summaryRef = writeRunJsonArtifact(params.runId, WRITING_SUMMARY_ARTIFACT, {
        version: 1,
        generated_at: nowIso(),
        run_id: params.runId,
        topic: params.topic,
        title: params.title,
        llm_mode_requested: params.llmMode,
        steps: Object.fromEntries(order.map(k => [k, manifest.steps[stepIndexByKey[k]]?.status])),
        note: 'Waiting for reviewer report',
        review: {
          prompt_uri: promptRef.uri,
          context_uri: contextRef.uri,
        },
      });
      toolArtifacts.push(summaryRef);
      manifest = commit(upsertRunStep({
        runId: params.runId,
        manifest,
        stepIndex: idx,
        update: prev => ({
          ...prev,
          artifacts: mergeArtifactRefs(prev.artifacts, [summaryRef]),
        }),
      }));

      return {
        run_id: params.runId,
        project_id: run.project_id,
        manifest_uri: `hep://runs/${encodeURIComponent(params.runId)}/manifest`,
        artifacts: toolArtifacts,
        summary: {
          topic: params.topic,
          title: params.title,
          llm_mode_requested: params.llmMode,
          steps: Object.fromEntries(order.map(k => [k, manifest.steps[stepIndexByKey[k]]?.status])),
          review: {
            prompt_uri: promptRef.uri,
            context_uri: contextRef.uri,
          },
        },
        next_actions: [
          {
            tool: 'hep_run_writing_submit_review',
            args: {
              run_id: params.runId,
              reviewer_report: {
                version: 2,
                severity: 'minor',
                summary: '(fill reviewer summary)',
                major_issues: [],
                minor_issues: [],
                notation_changes: [],
                asset_pointer_issues: [],
                follow_up_evidence_queries: [],
                structure_issues: [],
                grounding_risks: [],
              },
            },
            reason: 'Run the reviewer prompt with an LLM, then submit the resulting JSON reviewer_report to the run',
          },
        ],
      };
    }

    const parseErrorName = 'writing_parse_error_reviewer_report_v2.json';
    const reviewerPayload = (() => {
      try {
        return readRunJsonArtifact<any>(params.runId, WRITING_REVIEW_REPORT_ARTIFACT);
      } catch (err) {
        const ref = writeRunJsonArtifact(params.runId, parseErrorName, {
          version: 1,
          generated_at: nowIso(),
          run_id: params.runId,
          artifact_name: WRITING_REVIEW_REPORT_ARTIFACT,
          error: err instanceof Error ? err.message : String(err),
        });
        toolArtifacts.push(ref);
        throw invalidParams('Failed to read writing_reviewer_report.json (fail-fast)', {
          run_id: params.runId,
          reviewer_report_artifact: WRITING_REVIEW_REPORT_ARTIFACT,
          parse_error_uri: ref.uri,
          parse_error_artifact: ref.name,
          next_actions: [
            {
              tool: 'hep_run_writing_submit_review',
              args: {
                run_id: params.runId,
                reviewer_report: '<re-run reviewer prompt, produce ReviewerReport v2 JSON, then re-submit>',
              },
              reason: 'Fix/replace the malformed reviewer report artifact by re-submitting a valid ReviewerReport v2.',
            },
          ],
        });
      }
    })();

    const reviewerReportRaw = (reviewerPayload && typeof reviewerPayload === 'object') ? (reviewerPayload as any).reviewer_report : undefined;
    const parsedReport = ReviewerReportV2Schema.safeParse(reviewerReportRaw);
    if (!parsedReport.success) {
      const ref = writeRunJsonArtifact(params.runId, parseErrorName, {
        version: 1,
        generated_at: nowIso(),
        run_id: params.runId,
        artifact_name: WRITING_REVIEW_REPORT_ARTIFACT,
        issues: parsedReport.error.issues,
        received_reviewer_report: reviewerReportRaw,
      });
      toolArtifacts.push(ref);
      throw invalidParams('reviewer_report does not match ReviewerReport v2 schema (fail-fast)', {
        run_id: params.runId,
        reviewer_report_artifact: WRITING_REVIEW_REPORT_ARTIFACT,
        parse_error_uri: ref.uri,
        parse_error_artifact: ref.name,
        next_actions: [
          {
            tool: 'hep_run_read_artifact_chunk',
            args: { run_id: params.runId, artifact_name: WRITING_REVIEW_PROMPT_ARTIFACT, offset: 0, length: 4096 },
            reason: 'Read reviewer prompt (ReviewerReport v2 JSON contract).',
          },
          {
            tool: 'hep_run_read_artifact_chunk',
            args: { run_id: params.runId, artifact_name: WRITING_REVIEW_CONTEXT_ARTIFACT, offset: 0, length: 4096 },
            reason: 'Read reviewer context; then regenerate ReviewerReport v2 JSON with an LLM.',
          },
          {
            tool: 'hep_run_writing_submit_review',
            args: {
              run_id: params.runId,
              reviewer_report: {
                version: 2,
                severity: 'minor',
                summary: '(fill reviewer summary)',
                major_issues: [],
                minor_issues: [],
                notation_changes: [],
                asset_pointer_issues: [],
                follow_up_evidence_queries: [],
                structure_issues: [],
                grounding_risks: [],
              },
            },
            reason: 'Submit a valid ReviewerReport v2 JSON.',
          },
        ],
      });
    }

    toolArtifacts.push(makeRunArtifactRef(params.runId, WRITING_REVIEW_REPORT_ARTIFACT, 'application/json'));
    reviewerSummary = (reviewerPayload && typeof reviewerPayload === 'object' && (reviewerPayload as any).derived && typeof (reviewerPayload as any).derived === 'object')
      ? (reviewerPayload as any).derived
      : { available: true };

    manifest = commit(upsertRunStep({
      runId: params.runId,
      manifest,
      stepIndex: idx,
      update: prev => ({
        ...prev,
        status: 'done',
        completed_at: prev.completed_at ?? nowIso(),
        artifacts: mergeArtifactRefs(prev.artifacts, [makeRunArtifactRef(params.runId, WRITING_REVIEW_REPORT_ARTIFACT, 'application/json')]),
        notes: prev.notes || 'Reviewer report present',
      }),
    }));
  }

  // ── Final: warnings + summary (evidence-first)
  const warningsRef = writeRunJsonArtifact(params.runId, WRITING_WARNINGS_ARTIFACT, {
    version: 1,
    generated_at: nowIso(),
    run_id: params.runId,
    warnings,
  });
  const summaryRef = writeRunJsonArtifact(params.runId, WRITING_SUMMARY_ARTIFACT, {
    version: 1,
    generated_at: nowIso(),
    run_id: params.runId,
    topic: params.topic,
    title: params.title,
    llm_mode_requested: params.llmMode,
    steps: Object.fromEntries(order.map(k => [k, manifest.steps[stepIndexByKey[k]]?.status])),
    sections: {
      total: sectionTotal,
      ready: countDoneSectionArtifacts(params.runId, sectionTotal, 'section'),
      verification_ready: countDoneSectionArtifacts(params.runId, sectionTotal, 'verification'),
      originality_ready: countDoneSectionArtifacts(params.runId, sectionTotal, 'originality'),
    },
    verification_issues_total: verifyIssuesTotal,
    originality_critical_total: originalityCriticalTotal,
    phase2_integration: phase2Integration,
    reviewer: reviewerSummary,
  });
  toolArtifacts.push(warningsRef, summaryRef);

  // Attach warnings/summary to the last step for discoverability.
  const lastKey: WriteResumeFrom = shouldRun('review')
    ? 'review'
    : shouldRun('originality')
      ? 'originality'
      : shouldRun('verify')
        ? 'verify'
        : shouldRun('sections')
          ? 'sections'
          : shouldRun('outline')
            ? 'outline'
            : shouldRun('critical')
              ? 'critical'
              : 'claims';
  const lastIdx = stepIndexByKey[lastKey];
  manifest = commit(upsertRunStep({
    runId: params.runId,
    manifest,
    stepIndex: lastIdx,
    update: prev => ({
      ...prev,
      artifacts: mergeArtifactRefs(prev.artifacts, [warningsRef, summaryRef]),
    }),
  }));

  const run = getRun(params.runId);
  report(8, totalPhases, 'completed');

  return {
    run_id: params.runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(params.runId)}/manifest`,
    artifacts: toolArtifacts,
    summary: {
      topic: params.topic,
      title: params.title,
      llm_mode_requested: params.llmMode,
      steps: Object.fromEntries(order.map(k => [k, manifest.steps[stepIndexByKey[k]]?.status])),
      sections: {
        total: sectionTotal,
        ready: countDoneSectionArtifacts(params.runId, sectionTotal, 'section'),
        verification_ready: countDoneSectionArtifacts(params.runId, sectionTotal, 'verification'),
        originality_ready: countDoneSectionArtifacts(params.runId, sectionTotal, 'originality'),
      },
      verification_issues_total: verifyIssuesTotal,
      originality_critical_total: originalityCriticalTotal,
      warnings_total: warnings.length,
      phase2_integration: phase2Integration,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified deep research tool
 */
export async function performDeepResearch(
  params: DeepResearchParams
): Promise<DeepResearchResult> {
  const { identifiers, mode, format = 'json', options = {}, run_id, resume_from } = params;

  if (!identifiers?.length) {
    throw new Error('identifiers array is required');
  }

  const reportProgress = params._mcp?.reportProgress;

  const result: DeepResearchResult = { mode };

  switch (mode) {
    case 'analyze': {
      const analyzeOptions: DeepAnalyzeOptions = {
        extract_equations: options.extract_equations,
        extract_theorems: options.extract_theorems,
        extract_methodology: options.extract_methodology,
        extract_conclusions: options.extract_conclusions,
        include_inline_math: options.include_inline_math,
        max_section_length: options.max_section_length,
      };
      result.analysis = await deepAnalyze({ identifiers, options: analyzeOptions });
      break;
    }

    case 'synthesize': {
      const synthOptions: SynthesizeOptions = {
        include_equations: options.include_equations,
        include_bibliography: options.include_bibliography,
        max_papers_per_group: options.max_papers_per_group,
      };
      result.review = await synthesizeReview({
        identifiers,
        review_type: options.review_type || 'overview',
        focus_topic: options.focus_topic,
        format,
        style: options.style,
        include_critical_analysis: options.include_critical_analysis,
        narrative_structure: options.narrative_structure,
        options: synthOptions,
      });
      break;
    }

	    case 'write': {
	      const topic = options.topic || 'Research Topic';
	      const title = options.title || topic;
	      const qualityLevel = options.quality_level || 'standard';
	      const llmMode = options.llm_mode || 'client';  // Default: client mode (host LLM processes)
	      const maxSectionRetries =
          Number.isInteger(options.phase1_options?.max_retries)
            ? options.phase1_options!.max_retries
            : Number.isInteger(options.max_section_retries)
              ? options.max_section_retries
              : 3;
	      const autoFixOriginality = options.auto_fix_originality ?? true;
	      const autoFixCitations = options.auto_fix_citations ?? true;
	      const language = options.language || detectLanguage(topic, title);

        if (!run_id || !String(run_id).trim()) {
          throw invalidParams("write mode requires run_id (Evidence-first: use hep_project_create + hep_run_create first).", {
            mode,
            llm_mode: llmMode,
            next_actions: [
              { tool: 'hep_project_create', args: { name: title, description: topic }, reason: 'Create a project for this writing run.' },
              { tool: 'hep_run_create', args: { project_id: '<project_id from hep_project_create>' }, reason: 'Create a run to store evidence-first artifacts.' },
              {
                tool: 'inspire_deep_research',
                args: { identifiers, mode: 'write', run_id: '<run_id from hep_run_create>', options },
                reason: 'Re-run write mode with run_id.',
              },
            ],
          });
        }

        if (llmMode !== 'client' && llmMode !== 'internal') {
          throw invalidParams("Invalid llm_mode for write: only 'client' or 'internal' are allowed (passthrough removed).", {
            mode,
            llm_mode: llmMode,
          });
        }

        result.run = await performWriteToRun({
          runId: run_id,
          identifiers,
          topic,
          title,
          targetLength: options.target_length,
          quality: {
            quality_level: qualityLevel,
            structure_hints: options.structure_hints,
            user_outline: options.user_outline,
            outline_policy: options.outline_policy,
            phase0_options: options.phase0_options,
            phase1_options: options.phase1_options,
            phase2_options: options.phase2_options,
          },
          llmMode,
          refinement: {
            max_section_retries: maxSectionRetries,
            auto_fix_originality: autoFixOriginality,
            auto_fix_citations: autoFixCitations,
          },
          language,
          resumeFrom: resume_from,
          reportProgress,
        });
        break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  return result;
}
