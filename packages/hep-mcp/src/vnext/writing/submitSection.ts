import * as fs from 'fs';
import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath, getRunArtifactsDir } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

import { SectionOutputSubmissionSchema } from './sectionOutputSchema.js';
import { readStagedContent } from './staging.js';
import { inferWritingRoundFromArtifacts, writeClientLlmResponseArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';
import { ensureWritingQualityPolicyV1 } from './qualityPolicy.js';
import { requireValidWritingOutlineV2OrThrow } from './outlineContractGate.js';
import { verifyDeterministicSectionStructure } from './sectionStructureVerifier.js';
import { buildSectionQualityEvalPromptPacket, type SectionQualityEvalV1 } from './sectionQualityEvaluator.js';
import { runWritingTokenGateV1 } from './tokenGate.js';

import { ReferenceManager } from '../../tools/writing/reference/referenceManager.js';
import { handleCheckOriginality, handleVerifyCitations } from '../../tools/writing/writingToolHandlers.js';
import { escapeRegex } from '../../tools/writing/utils/index.js';
import { verifyAssetCoverage } from '../../tools/writing/verifier/assetCoverageChecker.js';
import { verifyWordCount } from '../../tools/writing/verifier/wordCountChecker.js';
import { verifyCrossRefReadiness } from '../../tools/writing/verifier/crossRefReadinessChecker.js';
import { detectLanguage, checkLanguageConsistency } from '../../tools/writing/verifier/languageChecker.js';
import { checkCitationCount } from './globalChecks.js';

type WritingPacketsArtifactV1 = {
  version?: number;
  run_id?: string;
  language?: 'en' | 'zh';
  target_length?: 'short' | 'medium' | 'long';
  sections?: Array<{
    index?: number;
    section_number?: string;
    section_title?: string;
    packet?: Record<string, unknown>;
  }>;
};

type WritingOutlineV2ArtifactLike = {
  request?: {
    target_length?: unknown;
  };
  outline_plan?: {
    language?: unknown;
    sections?: unknown;
  };
};

type SectionWritePacketArtifactV1Like = {
  packet_hints?: unknown;
};

type WritingSectionArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  mode_used: 'client' | 'internal';
  bibtex_keys_used: string[];
  section_output: Record<string, unknown>;
};

type WritingVerificationArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  verification: unknown;
};

type WritingOriginalityArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  originality: unknown;
};

type RetryAdvice = {
  retry_needed: boolean;
  retry_feedback: string[];
  retry_prompt: string;
};

type WritingQualityArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  quality: Record<string, unknown>;
};

type WritingRetryAdviceArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  retry_advice: RetryAdvice;
  sources?: Record<string, unknown>;
};

type WritingQualityEvalArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  quality_eval: SectionQualityEvalV1;
};

const WRITING_PACKETS_ARTIFACT = 'writing_packets_sections.json';
const WRITING_CLAIMS_ARTIFACT = 'writing_claims_table.json';

const WRITING_STEP_NAMES = ['writing_claims', 'writing_outline', 'writing_sections', 'writing_verify', 'writing_originality'] as const;

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

function readRunJsonArtifact<T>(runId: string, artifactName: string): T {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) {
    throw invalidParams(`Missing required run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (err) {
    const parseErrRef = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      artifact_name: artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams(`Malformed JSON in run artifact: ${artifactName} (fail-fast)`, {
      run_id: runId,
      artifact_name: artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        {
          tool: 'hep_run_read_artifact_chunk',
          args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 1024 },
          reason: 'Inspect the corrupted artifact and re-generate it.',
        },
      ],
    });
  }
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

function ensureWritingSteps(manifest: RunManifest): { manifest: RunManifest; idx: Record<(typeof WRITING_STEP_NAMES)[number], number> } {
  const steps = [...manifest.steps];
  for (const stepName of WRITING_STEP_NAMES) {
    if (steps.some(s => s.step === stepName)) continue;
    steps.push({ step: stepName, status: 'pending' });
  }

  const next: RunManifest = {
    ...manifest,
    updated_at: nowIso(),
    steps,
  };

  const idx = Object.fromEntries(
    WRITING_STEP_NAMES.map(name => [name, next.steps.findIndex(s => s.step === name)] as const)
  ) as Record<(typeof WRITING_STEP_NAMES)[number], number>;

  for (const name of WRITING_STEP_NAMES) {
    if (idx[name] === -1) throw new Error(`Internal: failed to ensure step ${name}`);
  }

  return { manifest: next, idx };
}

function updateStep(manifest: RunManifest, stepIndex: number, update: (prev: RunStep) => RunStep): RunManifest {
  return {
    ...manifest,
    updated_at: nowIso(),
    steps: manifest.steps.map((s, idx) => (idx === stepIndex ? update(s) : s)),
  };
}

function normalizeSectionOutput(input: Record<string, unknown>, fallback: { section_number: string; title: string }): Record<string, unknown> {
  const section_number = typeof input.section_number === 'string' && input.section_number.trim() ? input.section_number : fallback.section_number;
  const title = typeof input.title === 'string' && input.title.trim() ? input.title : fallback.title;
  const content = typeof input.content === 'string' ? input.content : '';
  const attributions = Array.isArray(input.attributions) ? input.attributions : [];
  const figures_used = Array.isArray(input.figures_used) ? input.figures_used : [];
  const equations_used = Array.isArray(input.equations_used) ? input.equations_used : [];
  const tables_used = Array.isArray(input.tables_used) ? input.tables_used : [];

  return {
    ...input,
    section_number,
    title,
    content,
    attributions,
    figures_used,
    equations_used,
    tables_used,
  };
}

function processSectionCitations(params: {
  sectionOutput: Record<string, unknown>;
  refManager: ReferenceManager;
}): { processed: Record<string, unknown>; bibtexKeysUsed: string[] } {
  const output = params.sectionOutput;
  const bibtexKeysUsed = new Set<string>();
  const recids = new Set<string>();

  const attributions = Array.isArray(output.attributions) ? output.attributions : [];
  for (const attr of attributions as Array<{ citations?: unknown }>) {
    const citations = Array.isArray(attr.citations) ? attr.citations : [];
    for (const c of citations) {
      const token = String(c).trim();
      if (!token) continue;
      const stripped = token.startsWith('inspire:') ? token.slice('inspire:'.length) : token;
      if (/^\d+$/.test(stripped)) recids.add(stripped);
    }
  }

  const contentRaw = typeof output.content === 'string' ? output.content : '';
  for (const match of contentRaw.matchAll(/\\cite\{(?:inspire:)?(\d+)\}/g)) {
    recids.add(match[1]);
  }

  for (const recid of recids) {
    const key = params.refManager.getKeyByRecid(recid);
    if (key) bibtexKeysUsed.add(key);
  }

  let processedContent = contentRaw;
  for (const recid of recids) {
    const key = params.refManager.getKeyByRecid(recid);
    if (!key) continue;
    const escaped = escapeRegex(recid);
    processedContent = processedContent
      .replace(new RegExp(`\\\\cite\\{inspire:${escaped}\\}`, 'g'), `\\cite{${key}}`)
      .replace(new RegExp(`\\\\cite\\{${escaped}\\}`, 'g'), `\\cite{${key}}`);
  }

  const processedAttributions = attributions.map((a: any) => {
    const citations = Array.isArray(a?.citations) ? a.citations : [];
    const next = citations.map((c: any) => {
      const token = String(c).trim();
      if (!token) return token;
      const stripped = token.startsWith('inspire:') ? token.slice('inspire:'.length) : token;
      if (/^\d+$/.test(stripped)) {
        return params.refManager.getKeyByRecid(stripped) || token;
      }
      return token;
    });
    return { ...a, citations: next };
  });

  return {
    processed: {
      ...output,
      content: processedContent,
      attributions: processedAttributions,
    },
    bibtexKeysUsed: Array.from(bibtexKeysUsed),
  };
}

function extractAllCitations(content: string): string[] {
  const cites: string[] = [];
  // Support \cite, \citep, \citet, \citealt, etc.
  const pattern = /\\cite[a-zA-Z*]*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const keys = match[1].split(',').map(k => k.trim()).filter(Boolean);
    cites.push(...keys);
  }
  return cites;
}

function deriveAttributionsFromLatexCites(params: {
  content: string;
}): {
  attributions: Array<{
    sentence: string;
    sentence_index: number;
    claim_ids: string[];
    evidence_ids: string[];
    citations: string[];
    type: 'fact';
    is_grounded: true;
    derivation: { method: 'latex_cite_paragraph_v1'; paragraph_index: number };
  }>;
  citations_total: number;
  paragraphs_with_citations: number;
} {
  const paragraphs = String(params.content ?? '').split(/\n\s*\n/g).map(p => p.trim()).filter(Boolean);
  const out: Array<{
    sentence: string;
    sentence_index: number;
    claim_ids: string[];
    evidence_ids: string[];
    citations: string[];
    type: 'fact';
    is_grounded: true;
    derivation: { method: 'latex_cite_paragraph_v1'; paragraph_index: number };
  }> = [];

  let citationsTotal = 0;
  let paragraphsWithCitations = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const cites = Array.from(new Set(extractAllCitations(paragraphs[i] ?? ''))).filter(Boolean);
    if (cites.length === 0) continue;
    paragraphsWithCitations += 1;
    citationsTotal += cites.length;
    out.push({
      sentence: '',
      sentence_index: i,
      claim_ids: [],
      evidence_ids: [],
      citations: cites,
      type: 'fact',
      is_grounded: true,
      derivation: { method: 'latex_cite_paragraph_v1', paragraph_index: i },
    });
  }

  return { attributions: out, citations_total: citationsTotal, paragraphs_with_citations: paragraphsWithCitations };
}

function countExisting(runId: string, total: number, kind: 'section' | 'verification' | 'originality'): number {
  let ok = 0;
  for (let i = 1; i <= total; i++) {
    const name = kind === 'section'
      ? `writing_section_${pad3(i)}.json`
      : kind === 'verification'
        ? `writing_verification_${pad3(i)}.json`
        : `writing_originality_${pad3(i)}.json`;
    if (fs.existsSync(getRunArtifactPath(runId, name))) ok += 1;
  }
  return ok;
}

function buildRetryPrompt(packet: Record<string, unknown>, feedback: string[]): string {
  const section = typeof packet?.section === 'object' && packet.section ? (packet.section as any) : undefined;
  const sectionTitle = typeof section?.title === 'string' ? section.title : '';
  const sectionNumber = typeof section?.number === 'string' ? section.number : '';

  return [
    `## CORRECTION REQUIRED`,
    sectionNumber || sectionTitle ? `Section: ${sectionNumber} ${sectionTitle}`.trim() : undefined,
    `You MUST revise the section to satisfy the following checks:`,
    ...feedback.map(f => `- ${f}`),
  ].filter(Boolean).join('\n');
}

function computeRetryAdvice(params: {
  packet: Record<string, unknown>;
  citationIssues: string[];
  originalityIssues: string[];
  postHocFeedback: string[];
}): RetryAdvice {
  const feedback = [
    ...params.postHocFeedback,
    ...params.citationIssues,
    ...params.originalityIssues,
  ].map(s => String(s).trim()).filter(Boolean);

  return {
    retry_needed: feedback.length > 0,
    retry_feedback: feedback,
    retry_prompt: buildRetryPrompt(params.packet, feedback),
  };
}

export async function submitRunWritingSection(params: {
  run_id: string;
  section_index: number;
  section_output_uri: string;
  quality_eval?: SectionQualityEvalV1;
  client_model?: string | null;
  temperature?: number | null;
  seed?: number | string | null;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}> {
  const runId = params.run_id;
  const sectionIndex = params.section_index;

  if (!Number.isFinite(sectionIndex) || sectionIndex < 1 || Math.trunc(sectionIndex) !== sectionIndex) {
    throw invalidParams('section_index must be a positive integer', { section_index: sectionIndex });
  }

  const rawOutputUri = typeof params.section_output_uri === 'string' ? params.section_output_uri : '';
  if (!rawOutputUri.trim()) {
    throw invalidParams('section_output_uri must be a non-empty string (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_candidates_packet_v1',
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'M13: Generate N-best section candidates (N>=2) and follow next_actions to judge+verify (no bypass).',
        },
      ],
    });
  }

  const rawData = await readStagedContent(runId, rawOutputUri, 'section_output');
  const parsed = SectionOutputSubmissionSchema.safeParse(rawData);
  if (!parsed.success) {
    const parseErrRef = writeRunJsonArtifact(runId, `writing_parse_error_section_output_section_${pad3(sectionIndex)}_v1.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      section_index: sectionIndex,
      section_output_uri: rawOutputUri,
      issues: parsed.error.issues,
    });
    const round = inferWritingRoundFromArtifacts(runId);
    const journalRef = writeWritingJournalMarkdown({
      run_id: runId,
      step: 'writing_sections',
      round,
      status: 'failed',
      title: 'SectionOutputSubmission schema mismatch',
      inputs: { section_output_uri: rawOutputUri },
      outputs: { parse_error_uri: parseErrRef.uri },
      error: { message: 'Staged content does not match SectionOutputSubmissionSchema', data: { issues: parsed.error.issues } },
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_candidates_packet_v1',
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'M13: Regenerate N-best section candidates (fail-fast; no single-sample submit) and retry the judge+verifier pipeline.',
        },
      ],
      artifact_name: `writing_journal_writing_sections_section_${pad3(sectionIndex)}_round_${pad2(round)}.md`,
    });
    throw invalidParams('Staged content does not match SectionOutputSubmissionSchema (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      section_output_uri: rawOutputUri,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      journal_uri: journalRef.uri,
      journal_artifact: journalRef.name,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_candidates_packet_v1',
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'M13: Regenerate N-best section candidates and retry (fail-fast; no bypass).',
        },
      ],
    });
  }

  const sectionOutput = parsed.data as Record<string, unknown>;
  const round = inferWritingRoundFromArtifacts(runId);
  const llmRequestName = `llm_request_writing_sections_section_${pad3(sectionIndex)}_round_01.json`;
  const llmRequestFallbackName = `writing_section_write_packet_section_${pad3(sectionIndex)}_v1.json`;
  const promptPacketUri = (() => {
    if (fs.existsSync(getRunArtifactPath(runId, llmRequestName))) {
      return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(llmRequestName)}`;
    }
    if (fs.existsSync(getRunArtifactPath(runId, llmRequestFallbackName))) {
      return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(llmRequestFallbackName)}`;
    }
    return undefined;
  })();
  const llmResponseArtifactName = `llm_response_writing_sections_section_${pad3(sectionIndex)}_round_${pad2(round)}.json`;
  const llmResponseRef = writeClientLlmResponseArtifact({
    run_id: runId,
    artifact_name: llmResponseArtifactName,
    step: 'writing_sections',
    round,
    prompt_packet_uri: promptPacketUri,
    client_raw_output_uri: rawOutputUri,
    parsed: sectionOutput,
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? undefined,
  });

  // Ensure run exists.
  getRun(runId);

  // M07: QualityGatePolicy (artifact SSOT). Ensure it exists for traceability.
  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });

  // M07: Outline contract gate (hard). writing_outline_v2.json must exist and validate (incl. claim_dependency_graph).
  requireValidWritingOutlineV2OrThrow({ run_id: runId });

  const writingContext = (() => {
    const packetsPath = getRunArtifactPath(runId, WRITING_PACKETS_ARTIFACT);
    if (fs.existsSync(packetsPath)) {
      const packets = readRunJsonArtifact<WritingPacketsArtifactV1>(runId, WRITING_PACKETS_ARTIFACT);
      const sections = Array.isArray(packets.sections) ? packets.sections : [];
      if (sections.length === 0) {
        throw invalidParams(`Invalid ${WRITING_PACKETS_ARTIFACT}: missing sections[]`, { run_id: runId });
      }

      const targetLanguage: 'en' | 'zh' | undefined = packets.language === 'en' || packets.language === 'zh' ? packets.language : undefined;
      const targetLengthRaw = String(packets.target_length ?? '').trim();
      if (targetLengthRaw !== 'short' && targetLengthRaw !== 'medium' && targetLengthRaw !== 'long') {
        throw invalidParams(`Invalid ${WRITING_PACKETS_ARTIFACT}: missing/invalid target_length (fail-fast)`, {
          run_id: runId,
          target_length: packets.target_length,
          next_actions: [
            {
              tool: 'hep_run_writing_create_outline_candidates_packet_v1',
              args: { run_id: runId, target_length: '<short|medium|long>', title: '<paper title>' },
              reason: 'M13: Regenerate writing_outline_v2.json via N-best outline candidates + judge so request.target_length is available (no bypass).',
            },
          ],
        });
      }
      const targetLength = targetLengthRaw as 'short' | 'medium' | 'long';

      const sectionMeta = sections.find(s => Number(s.index) === sectionIndex);
      if (!sectionMeta) {
        throw invalidParams('section_index not found in writing_packets_sections.json', { run_id: runId, section_index: sectionIndex });
      }

      const section_number = String(sectionMeta.section_number ?? sectionIndex);
      const section_title = String(sectionMeta.section_title ?? `Section ${sectionIndex}`);
      const allowedCitationsFromPacket = Array.isArray(sectionMeta.packet?.allowed_citations)
        ? sectionMeta.packet!.allowed_citations!.map(x => String(x).trim()).filter(Boolean)
        : [];
      const packet = (sectionMeta.packet && typeof sectionMeta.packet === 'object') ? (sectionMeta.packet as Record<string, unknown>) : {};

      return { sections, targetLanguage, targetLength, section_number, section_title, allowedCitationsFromPacket, packet };
    }

    const outlineArtifactName = 'writing_outline_v2.json';
    const outlinePath = getRunArtifactPath(runId, outlineArtifactName);
    if (!fs.existsSync(outlinePath)) {
      throw invalidParams(`Missing ${WRITING_PACKETS_ARTIFACT}; writing_outline_v2.json is also missing`, {
        run_id: runId,
        next_actions: [
          {
            tool: 'hep_run_writing_create_outline_candidates_packet_v1',
            args: { run_id: runId, target_length: '<short|medium|long>', title: '<paper title>' },
            reason: 'M13: Generate writing_outline_v2.json via N-best outline candidates + judge (required before section submission).',
          },
        ],
      });
    }

    const outline = readRunJsonArtifact<WritingOutlineV2ArtifactLike>(runId, outlineArtifactName);
    const plan = outline?.outline_plan as any;
    const rawSections = Array.isArray(plan?.sections) ? plan.sections : null;
    if (!rawSections || rawSections.length === 0) {
      throw invalidParams('Invalid writing_outline_v2.json: missing outline_plan.sections[]', { run_id: runId, artifact_name: outlineArtifactName });
    }

    if (sectionIndex > rawSections.length) {
      throw invalidParams('section_index out of range for outline_plan.sections[]', {
        run_id: runId,
        section_index: sectionIndex,
        sections_total: rawSections.length,
      });
    }

    const targetLanguage: 'en' | 'zh' | undefined = plan?.language === 'en' || plan?.language === 'zh' ? plan.language : undefined;

    const targetLengthRaw = String(outline?.request?.target_length ?? '').trim();
    if (targetLengthRaw !== 'short' && targetLengthRaw !== 'medium' && targetLengthRaw !== 'long') {
      throw invalidParams('Invalid writing_outline_v2.json: request.target_length is missing/invalid (fail-fast)', {
        run_id: runId,
        outline_artifact_name: outlineArtifactName,
        request_target_length: outline?.request?.target_length,
        next_actions: [
          {
            tool: 'hep_run_writing_create_outline_candidates_packet_v1',
            args: { run_id: runId, target_length: '<short|medium|long>', title: '<paper title>' },
            reason: 'M13: Regenerate writing_outline_v2.json via N-best outline candidates + judge ensuring request.target_length is set (no bypass).',
          },
        ],
      });
    }
    const targetLength = targetLengthRaw as 'short' | 'medium' | 'long';

    const sections = rawSections.map((s: any, i: number) => ({
      index: i + 1,
      section_number: String(s?.number ?? i + 1),
      section_title: String(s?.title ?? `Section ${i + 1}`),
      packet: undefined,
    }));

    const sectionMeta = sections[sectionIndex - 1]!;
    const section_number = sectionMeta.section_number;
    const section_title = sectionMeta.section_title;

    const packetFromHints = (() => {
      const packetArtifactName = `writing_section_write_packet_section_${pad3(sectionIndex)}_v1.json`;
      const p = getRunArtifactPath(runId, packetArtifactName);
      if (!fs.existsSync(p)) return null;
      const artifact = readRunJsonArtifact<SectionWritePacketArtifactV1Like>(runId, packetArtifactName);
      const hints = artifact?.packet_hints;
      if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return null;
      return { section: { number: section_number, title: section_title }, ...(hints as Record<string, unknown>) };
    })();

    const packet = packetFromHints ?? { section: { number: section_number, title: section_title } };

    return { sections, targetLanguage, targetLength, section_number, section_title, allowedCitationsFromPacket: [], packet };
  })();

  const { sections, targetLanguage, targetLength, section_number, section_title, packet } = writingContext;

  // Persistent reference map (for citation key normalization).
  const artifactsDir = getRunArtifactsDir(runId);
  const refManager = new ReferenceManager(artifactsDir);
  await refManager.loadFromDisk();

  const normalized = normalizeSectionOutput(sectionOutput, { section_number, title: section_title });
  const contentRaw = typeof normalized.content === 'string' ? normalized.content : '';
  if (contentRaw.trim().length === 0) {
    throw invalidParams('section_output.content must be a non-empty string (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_candidates_packet_v1',
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'M13: Regenerate N-best section candidates ensuring content is non-empty, then re-judge and re-verify (fail-fast; no bypass).',
        },
      ],
    });
  }

  const attributionsDerivation = (() => {
    const existing = Array.isArray(normalized.attributions) ? normalized.attributions : [];
    if (existing.length > 0) return null;

    const allCites = extractAllCitations(contentRaw);
    if (contentRaw.trim().length > 0 && allCites.length === 0) {
      throw invalidParams('section_output is missing attributions and contains no \\cite{} commands; cannot derive attributions (fail-fast)', {
        run_id: runId,
        section_index: sectionIndex,
        next_actions: [
          {
            tool: 'hep_run_writing_create_section_candidates_packet_v1',
            args: { run_id: runId, section_index: sectionIndex },
            reason: 'M13: Regenerate N-best section candidates with proper \\cite{} usage (and optionally explicit attributions), then re-judge.',
          },
        ],
      });
    }
    if (allCites.length === 0) return null;
    return deriveAttributionsFromLatexCites({ content: contentRaw });
  })();

  const derivationRef = attributionsDerivation
    ? writeRunJsonArtifact(runId, `writing_attributions_derivation_section_${pad3(sectionIndex)}_v1.json`, {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        section_index: sectionIndex,
        method: 'latex_cite_paragraph_v1',
        citations_total: attributionsDerivation.citations_total,
        paragraphs_with_citations: attributionsDerivation.paragraphs_with_citations,
      })
    : null;

  const normalizedWithAttributions = attributionsDerivation
    ? { ...normalized, attributions: attributionsDerivation.attributions as any }
    : normalized;

  const { processed, bibtexKeysUsed } = processSectionCitations({ sectionOutput: normalizedWithAttributions, refManager });

  // Write section output artifact.
  const sectionArtifactName = `writing_section_${pad3(sectionIndex)}.json`;
  const sectionPayload: WritingSectionArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    section_index: sectionIndex,
    section_number,
    section_title,
    mode_used: 'client',
    bibtex_keys_used: bibtexKeysUsed,
    section_output: processed,
  };
  const sectionRef = writeRunJsonArtifact(runId, sectionArtifactName, sectionPayload);

  // M04: Prefer per-section allowlist from EvidencePacketV2 when present (hard gate).
  // Note: citations in section_output are normalized to BibTeX keys; include both paper_ids and derived BibTeX keys in the allowlist.
  const evidencePacketArtifactName = `writing_evidence_packet_section_${pad3(sectionIndex)}_v2.json`;
  const allowedCitations: string[] = (() => {
    const p = getRunArtifactPath(runId, evidencePacketArtifactName);
    if (!fs.existsSync(p)) {
      throw invalidParams('Missing required evidence packet for section (fail-fast)', {
        run_id: runId,
        section_index: sectionIndex,
        artifact_name: evidencePacketArtifactName,
        next_actions: [
          {
            tool: 'hep_run_writing_build_evidence_packet_section_v2',
            args: { run_id: runId, section_index: sectionIndex },
            reason: 'Build an EvidencePacketV2 (allowlist) for this section before verifying citations.',
          },
        ],
      });
    }

    const parsed = readRunJsonArtifact<any>(runId, evidencePacketArtifactName);
    const paperIds = Array.isArray(parsed?.allowed?.paper_ids)
      ? parsed.allowed.paper_ids.map((x: any) => String(x).trim()).filter(Boolean)
      : null;
    if (!paperIds || paperIds.length === 0) {
      throw invalidParams('Invalid evidence packet artifact: allowed.paper_ids[] is required and must be non-empty', {
        run_id: runId,
        artifact_name: evidencePacketArtifactName,
      });
    }

    const tokens = new Set<string>();
    for (const pid of paperIds) {
      tokens.add(pid);
      const stripped = pid.startsWith('inspire:') ? pid.slice('inspire:'.length) : pid;
      if (!/^\d+$/.test(stripped)) continue;
      const key = refManager.getKeyByRecid(stripped);
      if (key) tokens.add(key);
    }

    return Array.from(tokens).sort((a, b) => a.localeCompare(b));
  })();

  const claimsPath = getRunArtifactPath(runId, WRITING_CLAIMS_ARTIFACT);

  // Claims table (for verifier + originality source evidences).
  if (!fs.existsSync(claimsPath)) {
    const recids = allowedCitations
      .map(c => String(c).trim())
      .filter(c => c.startsWith('inspire:'))
      .map(c => c.slice('inspire:'.length))
      .filter(r => /^\d+$/.test(r));

    throw invalidParams(`Missing required run artifact: ${WRITING_CLAIMS_ARTIFACT}`, {
      run_id: runId,
      artifact_name: WRITING_CLAIMS_ARTIFACT,
      next_actions: [
        {
          tool: 'hep_run_build_writing_critical',
          args: { run_id: runId, recids: recids.length > 0 ? recids : ['<inspire_recid>'] },
          reason: 'Build writing-critical artifacts (including writing_claims_table.json) for this run before verifying section citations/originality.',
        },
      ],
    });
  }

  const claimsResult = readRunJsonArtifact<any>(runId, WRITING_CLAIMS_ARTIFACT) as { claims_table?: any };
  const claimsTable = claimsResult?.claims_table;
  if (!claimsTable) {
    const recids = allowedCitations
      .map(c => String(c).trim())
      .filter(c => c.startsWith('inspire:'))
      .map(c => c.slice('inspire:'.length))
      .filter(r => /^\d+$/.test(r));

    throw invalidParams(`Invalid ${WRITING_CLAIMS_ARTIFACT}: missing claims_table`, {
      run_id: runId,
      artifact_name: WRITING_CLAIMS_ARTIFACT,
      next_actions: [
        {
          tool: 'hep_run_build_writing_critical',
          args: { run_id: runId, recids: recids.length > 0 ? recids : ['<inspire_recid>'] },
          reason: 'Rebuild writing-critical artifacts (including writing_claims_table.json) for this run before verifying section citations/originality.',
        },
      ],
    });
  }

  const verification = handleVerifyCitations(
    {
      section_output: processed,
      claims_table: claimsTable,
      allowed_citations: allowedCitations,
    },
    { referenceManager: refManager }
  );
  const verificationArtifactName = `writing_verification_${pad3(sectionIndex)}.json`;
  const verificationPayload: WritingVerificationArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    section_index: sectionIndex,
    section_number,
    section_title,
    verification,
  };
  const verificationRef = writeRunJsonArtifact(runId, verificationArtifactName, verificationPayload);

  const content = typeof processed.content === 'string' ? processed.content : '';
  const sourceEvidences = Array.isArray(claimsTable?.claims) ? claimsTable.claims.flatMap((c: any) => Array.isArray(c?.supporting_evidence) ? c.supporting_evidence : []) : [];
  if (content.trim().length === 0) {
    throw invalidParams('Processed section content is empty after normalization (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
    });
  }

  const originality = handleCheckOriginality({ generated_text: content, source_evidences: sourceEvidences });

  const originalityArtifactName = `writing_originality_${pad3(sectionIndex)}.json`;
  const originalityPayload: WritingOriginalityArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    section_index: sectionIndex,
    section_number,
    section_title,
    originality,
  };
  const originalityRef = writeRunJsonArtifact(runId, originalityArtifactName, originalityPayload);

  // Phase 1 post-hoc checks + retry advice (client workflow).
  const postHocFeedback: string[] = [];
  const contentForChecks = typeof processed.content === 'string' ? processed.content : '';

  const detectedLanguage = detectLanguage(contentForChecks);
  if (targetLanguage && contentForChecks.trim().length >= 40) {
    const mismatch = detectedLanguage === 'mixed' || detectedLanguage !== targetLanguage;
    if (mismatch) {
      const expectedLabel = targetLanguage === 'zh' ? 'Chinese' : 'English';
      const detectedLabel = detectedLanguage === 'zh' ? 'Chinese' : detectedLanguage === 'en' ? 'English' : 'mixed';
      postHocFeedback.push(`Language consistency: expected ${expectedLabel}, detected ${detectedLabel}. Rewrite this section in ${expectedLabel}.`);
    }
  }

  const assignedAssets = (packet as any)?.assigned_assets;
  const assetCoverage = assignedAssets && typeof assignedAssets === 'object'
    ? verifyAssetCoverage({ content: contentForChecks }, assignedAssets as any)
    : null;
  if (assetCoverage && !assetCoverage.pass) postHocFeedback.push(...assetCoverage.feedback);

  const wordBudget = (packet as any)?.word_budget;
  const wordCount = wordBudget && typeof wordBudget === 'object'
    ? verifyWordCount(contentForChecks, wordBudget as any)
    : null;
  if (wordCount && !wordCount.pass) postHocFeedback.push(...wordCount.feedback);

  const crossRefHints = (packet as any)?.global_context?.cross_ref_hints?.this_section_defines;
  const crossRef = Array.isArray(crossRefHints)
    ? verifyCrossRefReadiness({ content: contentForChecks }, { this_section_defines: crossRefHints.map((x: any) => String(x)) })
    : null;
  if (crossRef && !crossRef.pass) postHocFeedback.push(...crossRef.feedback);

  const deterministicStructure = verifyDeterministicSectionStructure({
    content: contentForChecks,
    min_paragraphs: qualityPolicy.deterministic_gates.min_paragraphs,
    max_single_sentence_paragraphs: qualityPolicy.deterministic_gates.max_single_sentence_paragraphs,
    require_no_unclosed_environments: qualityPolicy.deterministic_gates.require_no_unclosed_environments,
  });
  if (!deterministicStructure.pass) postHocFeedback.push(...deterministicStructure.feedback);

  const verificationIssuesRaw: any[] = Array.isArray((verification as any)?.issues) ? (verification as any).issues : [];
  const citationErrorIssues = verificationIssuesRaw
    .filter((i: any) => String(i?.severity ?? 'error') === 'error')
    .map((i: any) => String(i?.message ?? '').trim())
    .filter(Boolean);
  const citationWarningIssues = verificationIssuesRaw
    .filter((i: any) => String(i?.severity ?? '') === 'warning')
    .map((i: any) => String(i?.message ?? '').trim())
    .filter(Boolean);

  // Publication mode treats citation warnings as blocking (fail-fast).
  const citationIssues = qualityPolicy.quality_level === 'publication'
    ? [...citationErrorIssues, ...citationWarningIssues]
    : citationErrorIssues;
  const originalityIssues = (originality as any)?.level && (originality as any)?.level !== 'acceptable'
    ? [String((originality as any)?.recommendation ?? `Originality ${String((originality as any)?.level)}: revise to reduce overlap.`)]
    : [];

  const submittedSections = sections
    .map((s: any) => ({
      index: Number(s?.index),
      section_number: String(s?.section_number ?? s?.index ?? ''),
    }))
    .filter((s: { index: number; section_number: string }) => Number.isFinite(s.index) && s.index >= 1 && s.section_number.trim().length > 0)
    .map((meta: { index: number; section_number: string }) => {
      const artifactName = `writing_section_${pad3(meta.index)}.json`;
      const path = getRunArtifactPath(runId, artifactName);
      if (!fs.existsSync(path)) return null;
      const payload = readRunJsonArtifact<WritingSectionArtifactV1>(runId, artifactName);
      const output = payload.section_output;
      const content = typeof output?.content === 'string' ? output.content : '';
      return { section_number: meta.section_number, content };
    })
    .filter((s: { section_number: string; content: string } | null): s is { section_number: string; content: string } => Boolean(s));

  const languageConsistency = submittedSections.length > 0
    ? checkLanguageConsistency(submittedSections.map((s: { section_number: string; content: string }) => ({ number: s.section_number, content: s.content })))
    : null;

  const citationCount = checkCitationCount({
    target_length: targetLength,
    sections: submittedSections.map((s: { section_number: string; content: string }) => ({ content: s.content })),
  });

  if (qualityPolicy.quality_level === 'publication' && citationCount && citationCount.pass === false) {
    postHocFeedback.push(
      `Citation coverage: too few citations for target_length=${targetLength} (have ${citationCount.unique_citations}, need >= ${citationCount.min_required}). Add citations within the EvidencePacketV2 allowlist.`
    );
  }

  const outlineUri = `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_outline_v2.json')}`;
  const evidencePacketUri = `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(evidencePacketArtifactName)}`;

  let qualityEval: SectionQualityEvalV1 | null = null;
  let qualityEvalRef: RunArtifactRef | null = null;
  let qualityEvalPromptRef: RunArtifactRef | null = null;
  let qualityEvalTokenGateArtifacts: RunArtifactRef[] = [];
  let qualityEvalGatePass: boolean | null = null;

  if (qualityPolicy.llm_evaluator_gate.required) {
    if (params.quality_eval !== undefined) {
      qualityEval = params.quality_eval;

      const evalArtifactName = `writing_quality_eval_section_${pad3(sectionIndex)}_v1.json`;
      const evalPayload: WritingQualityEvalArtifactV1 = {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        section_index: sectionIndex,
        section_number,
        section_title,
        quality_eval: qualityEval,
      };
      qualityEvalRef = writeRunJsonArtifact(runId, evalArtifactName, evalPayload);

      const blocking: string[] = [];
      if (!qualityEval.overall.pass) {
        blocking.push(`LLM evaluator: overall.pass=false (${qualityEval.overall.summary}).`);
      }
      if (qualityEval.overall.score < qualityPolicy.llm_evaluator_gate.min_overall_score) {
        blocking.push(`LLM evaluator: overall.score=${qualityEval.overall.score} < ${qualityPolicy.llm_evaluator_gate.min_overall_score}.`);
      }
      if (qualityEval.scores.structure < qualityPolicy.llm_evaluator_gate.min_structure_score) {
        blocking.push(`LLM evaluator: structure=${qualityEval.scores.structure} < ${qualityPolicy.llm_evaluator_gate.min_structure_score}.`);
      }
      if (qualityEval.scores.groundedness < qualityPolicy.llm_evaluator_gate.min_groundedness_score) {
        blocking.push(`LLM evaluator: groundedness=${qualityEval.scores.groundedness} < ${qualityPolicy.llm_evaluator_gate.min_groundedness_score}.`);
      }
      if (qualityEval.scores.relevance < qualityPolicy.llm_evaluator_gate.min_relevance_score) {
        blocking.push(`LLM evaluator: relevance=${qualityEval.scores.relevance} < ${qualityPolicy.llm_evaluator_gate.min_relevance_score}.`);
      }

      const issueLines = qualityEval.issues
        .filter(i => i.severity === 'error')
        .map(i => `[${i.dimension}] ${i.message}`.trim())
        .filter(Boolean);
      blocking.push(...issueLines);

      qualityEvalGatePass = blocking.length === 0;
      if (!qualityEvalGatePass) {
        postHocFeedback.push(...blocking);
        postHocFeedback.push(...(qualityEval.retry_feedback ?? []));
      }
    } else {
      const promptPacket = buildSectionQualityEvalPromptPacket({
        section_number,
        section_title,
        section_output_uri: sectionRef.uri,
        outline_uri: outlineUri,
        evidence_packet_uri: evidencePacketUri,
        quality_policy_uri: qualityPolicyRef.uri,
        language: targetLanguage,
      });

      const promptArtifactName = `writing_quality_eval_prompt_section_${pad3(sectionIndex)}_v1.json`;
      qualityEvalPromptRef = writeRunJsonArtifact(runId, promptArtifactName, {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        section_index: sectionIndex,
        section_number,
        section_title,
        prompt_packet: promptPacket,
      });

      const tokenGate = await runWritingTokenGateV1({
        run_id: runId,
        step: 'custom',
        prompt_packet: promptPacket,
        evidence_packet_uri: evidencePacketUri,
        section_index: sectionIndex,
        output_pass_artifact_name: `token_gate_pass_section_quality_eval_section_${pad3(sectionIndex)}_v1.json`,
        output_overflow_artifact_name: `writing_token_overflow_section_quality_eval_section_${pad3(sectionIndex)}_v1.json`,
      });
      qualityEvalTokenGateArtifacts = [...tokenGate.artifacts];
    }
  }

  const retry_advice = computeRetryAdvice({ packet, citationIssues, originalityIssues, postHocFeedback });
  const retryAdviceArtifactName = `writing_retry_advice_${pad3(sectionIndex)}.json`;
  const retryAdviceRef = retry_advice.retry_needed
    ? writeRunJsonArtifact(runId, retryAdviceArtifactName, {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        section_index: sectionIndex,
        section_number,
        section_title,
        retry_advice,
        sources: {
          citation_errors: citationErrorIssues.length,
          citation_warnings: citationWarningIssues.length,
          originality_level: (originality as any)?.level,
        },
      } satisfies WritingRetryAdviceArtifactV1)
    : null;

  const qualityArtifactName = `writing_quality_${pad3(sectionIndex)}.json`;
  const qualityPayload: WritingQualityArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    section_index: sectionIndex,
    section_number,
    section_title,
    quality: {
      asset_coverage: assetCoverage ?? undefined,
      word_count: wordCount ?? undefined,
      cross_ref_readiness: crossRef ?? undefined,
      language_check: {
        expected_language: targetLanguage,
        detected_language: detectedLanguage,
        consistency: languageConsistency ?? undefined,
      },
      citation_count: citationCount,
      deterministic_structure: deterministicStructure,
      citation_issues: {
        errors: citationErrorIssues.length,
        warnings: citationWarningIssues.length,
        ...(qualityPolicy.quality_level === 'publication' ? { warnings_blocking: true } : {}),
      },
      llm_evaluator_gate: qualityPolicy.llm_evaluator_gate.required
        ? qualityEval
          ? {
            required: true,
            pass: Boolean(qualityEvalGatePass),
            overall: qualityEval.overall,
            scores: qualityEval.scores,
            issues_total: qualityEval.issues.length,
            quality_eval_uri: qualityEvalRef?.uri,
          }
          : {
            required: true,
            pass: false,
            missing_quality_eval: true,
            prompt_uri: qualityEvalPromptRef?.uri,
          }
        : { required: false, pass: true },
      retry_advice_uri: retryAdviceRef?.uri,
      retry_advice,
    },
  };
  const qualityRef = writeRunJsonArtifact(runId, qualityArtifactName, qualityPayload);

  // Update manifest steps + overall status.
  const artifacts: RunArtifactRef[] = [
    qualityPolicyRef,
    llmResponseRef,
    sectionRef,
    verificationRef,
    originalityRef,
    qualityRef,
    ...(derivationRef ? [derivationRef] : []),
    ...(qualityEvalRef ? [qualityEvalRef] : []),
    ...(qualityEvalPromptRef ? [qualityEvalPromptRef] : []),
    ...qualityEvalTokenGateArtifacts,
    ...(retryAdviceRef ? [retryAdviceRef] : []),
  ];

  const total = sections.length;
  const sectionsReady = countExisting(runId, total, 'section');
  const verReady = countExisting(runId, total, 'verification');
  const origReady = countExisting(runId, total, 'originality');

  const touchedAt = nowIso();
  const missingQualityEval = qualityPolicy.llm_evaluator_gate.required && !qualityEval;
  const llmEvalFailed = qualityEvalGatePass === false;
  const sectionVerifyFailed = missingQualityEval || llmEvalFailed || retry_advice.retry_needed;
  const sectionOriginalityFailed = originalityIssues.length > 0;

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: sectionVerifyFailed ? 'writing_verify' : 'writing_sections',
    round,
    pointers: {
      outline_uri: outlineUri,
      evidence_packet_uri: evidencePacketUri,
      quality_policy_uri: qualityPolicyRef.uri,
      last_section_uri: sectionRef.uri,
      last_verification_uri: verificationRef.uri,
      last_originality_uri: originalityRef.uri,
      last_quality_uri: qualityRef.uri,
      section_output_uri: rawOutputUri,
      llm_response_uri: llmResponseRef.uri,
      ...(qualityEvalRef ? { quality_eval_uri: qualityEvalRef.uri } : {}),
      ...(qualityEvalPromptRef ? { quality_eval_prompt_uri: qualityEvalPromptRef.uri } : {}),
      ...(retryAdviceRef ? { retry_advice_uri: retryAdviceRef.uri } : {}),
    },
  });

  const roundKey = String(round).padStart(2, '0');
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_sections',
    round,
    status: sectionVerifyFailed ? 'failed' : 'success',
    title: sectionVerifyFailed
      ? missingQualityEval
        ? 'Section submission blocked: missing quality_eval'
        : 'Section submission rejected: retry required'
      : 'Section submission accepted',
    inputs: {
      outline_uri: outlineUri,
      evidence_packet_uri: evidencePacketUri,
      quality_policy_uri: qualityPolicyRef.uri,
      section_output_uri: rawOutputUri,
      ...(qualityEvalPromptRef ? { quality_eval_prompt_uri: qualityEvalPromptRef.uri } : {}),
    },
    outputs: {
      section_uri: sectionRef.uri,
      verification_uri: verificationRef.uri,
      originality_uri: originalityRef.uri,
      quality_uri: qualityRef.uri,
      llm_response_uri: llmResponseRef.uri,
      checkpoint_uri: checkpointRef.uri,
      ...(retryAdviceRef ? { retry_advice_uri: retryAdviceRef.uri } : {}),
    },
    decisions: [
      `section_number=${section_number}`,
      `bibtex_keys_used=${bibtexKeysUsed.length}`,
      `citation_errors=${citationErrorIssues.length}`,
      `citation_warnings=${citationWarningIssues.length}`,
      `originality_level=${String((originality as any)?.level ?? 'unknown')}`,
      `quality_eval_required=${qualityPolicy.llm_evaluator_gate.required}`,
      ...(qualityEvalGatePass !== null ? [`quality_eval_gate_pass=${String(qualityEvalGatePass)}`] : []),
      `retry_needed=${String(retry_advice.retry_needed)}`,
    ],
    next_actions: missingQualityEval
      ? [
        {
          tool: 'hep_run_writing_submit_section_judge_decision_v1',
          args: {
            run_id: runId,
            section_index: sectionIndex,
            judge_decision_uri: '<reuse judge_decision_uri from M13 judge stage>',
            quality_eval: '<paste SectionQualityEvalV1 JSON here>',
          },
          reason: 'Run the quality_eval prompt_packet with an LLM, then re-submit the M13 judge decision with quality_eval (fail-fast).',
        },
      ]
      : retry_advice.retry_needed
        ? [
          {
            tool: 'hep_run_writing_create_section_candidates_packet_v1',
            args: {
              run_id: runId,
              section_index: sectionIndex,
            },
            reason: 'M13: Regenerate N-best section candidates applying retry_advice, then re-judge and re-verify (fail-fast; no single-sample resubmit).',
          },
        ]
        : undefined,
    artifact_name: `writing_journal_writing_sections_section_${pad3(sectionIndex)}_round_${roundKey}.md`,
  });
  artifacts.push(checkpointRef, journalRef);
  const manifest = await updateRunManifestAtomic({
    run_id: runId,
    tool: {
      name: 'hep_run_writing_submit_section_judge_decision_v1',
      args: { run_id: runId, section_index: sectionIndex, section_output_uri: rawOutputUri },
    },
    update: current => {
      const ensured = ensureWritingSteps(current);
      let next = ensured.manifest;
      const idx = ensured.idx;
      const stepSections = idx.writing_sections;
      const stepVerify = idx.writing_verify;
      const stepOrig = idx.writing_originality;

      next = updateStep(next, stepSections, (prev) => {
        const status = sectionsReady >= total ? 'done' : 'in_progress';
        return {
          ...prev,
          status,
          started_at: prev.started_at ?? touchedAt,
          completed_at: status === 'done' ? touchedAt : undefined,
          artifacts: mergeArtifactRefs(prev.artifacts, [
            sectionRef,
            llmResponseRef,
            checkpointRef,
            journalRef,
            ...(derivationRef ? [derivationRef] : []),
          ]),
        };
      });

      next = updateStep(next, stepVerify, (prev) => {
        const base = verReady >= total ? 'done' : 'in_progress';
        const status: RunStep['status'] = sectionVerifyFailed ? 'failed' : base;
        return {
          ...prev,
          status,
          started_at: prev.started_at ?? touchedAt,
          completed_at: status === 'done' || status === 'failed' ? touchedAt : undefined,
          artifacts: mergeArtifactRefs(prev.artifacts, [
            qualityPolicyRef,
            llmResponseRef,
            verificationRef,
            qualityRef,
            checkpointRef,
            journalRef,
            ...(qualityEvalRef ? [qualityEvalRef] : []),
            ...(qualityEvalPromptRef ? [qualityEvalPromptRef] : []),
            ...qualityEvalTokenGateArtifacts,
            ...(retryAdviceRef ? [retryAdviceRef] : []),
          ]),
          notes: status === 'failed'
            ? missingQualityEval
              ? 'LLM evaluator gate pending: missing quality_eval'
              : 'Section verification failed (retry required)'
            : prev.notes,
        };
      });

      next = updateStep(next, stepOrig, (prev) => {
        const base = origReady >= total ? 'done' : 'in_progress';
        const status: RunStep['status'] = sectionOriginalityFailed ? 'failed' : base;
        return {
          ...prev,
          status,
          started_at: prev.started_at ?? touchedAt,
          completed_at: status === 'done' || status === 'failed' ? touchedAt : undefined,
          artifacts: mergeArtifactRefs(prev.artifacts, [
            originalityRef,
            llmResponseRef,
            checkpointRef,
            journalRef,
          ]),
          notes: status === 'failed' ? 'Section originality failed (retry required)' : prev.notes,
        };
      });

      const finalized: RunManifest = {
        ...next,
        status: computeRunStatus(next),
        updated_at: touchedAt,
      };
      return finalized;
    },
  });

  if (missingQualityEval) {
    throw invalidParams('Missing required quality_eval (LLM evaluator gate) (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      section_number,
      section_title,
      quality_eval_prompt_uri: qualityEvalPromptRef?.uri,
      quality_eval_prompt_artifact: qualityEvalPromptRef?.name,
      checkpoint_uri: checkpointRef.uri,
      checkpoint_artifact: checkpointRef.name,
      journal_uri: journalRef.uri,
      journal_artifact: journalRef.name,
      next_actions: [
        {
          tool: 'hep_run_writing_submit_section_judge_decision_v1',
          args: {
            run_id: runId,
            section_index: sectionIndex,
            judge_decision_uri: '<reuse judge_decision_uri from M13 judge stage>',
            quality_eval: '<paste SectionQualityEvalV1 JSON here>',
          },
          reason: 'Run the quality_eval prompt_packet with an LLM, then re-submit the M13 judge decision with quality_eval (fail-fast).',
        },
      ],
    });
  }

  if (retry_advice.retry_needed) {
    throw invalidParams('Section submission rejected: retry required (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      section_number,
      section_title,
      retry_advice_uri: retryAdviceRef?.uri,
      retry_advice_artifact: retryAdviceRef?.name,
      checkpoint_uri: checkpointRef.uri,
      checkpoint_artifact: checkpointRef.name,
      journal_uri: journalRef.uri,
      journal_artifact: journalRef.name,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_candidates_packet_v1',
          args: {
            run_id: runId,
            section_index: sectionIndex,
          },
          reason: 'M13: Regenerate N-best section candidates applying retry_advice, then re-judge and re-verify (fail-fast; no single-sample resubmit).',
        },
      ],
    });
  }

  return {
    run_id: runId,
    project_id: manifest.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts,
    summary: {
      section_index: sectionIndex,
      section_number,
      section_title,
      sections: { total, ready: sectionsReady },
      verification: { ready: verReady, issues: Array.isArray((verification as any)?.issues) ? (verification as any).issues.length : undefined },
      originality: { ready: origReady, level: (originality as any)?.level },
      quality_level: qualityPolicy.quality_level,
      language: {
        expected: targetLanguage,
        detected: detectedLanguage,
        global_is_consistent: languageConsistency?.is_consistent ?? undefined,
      },
      citations: {
        total: citationCount.total_citations,
        unique: citationCount.unique_citations,
        min_required: citationCount.min_required,
        pass: citationCount.pass,
        advisory: citationCount.advisory,
      },
      gates: {
        deterministic_structure: deterministicStructure.diagnostics,
        llm_evaluator: qualityEval
          ? {
            pass: Boolean(qualityEvalGatePass),
            overall_score: qualityEval.overall.score,
            scores: qualityEval.scores,
            issues_total: qualityEval.issues.length,
          }
          : undefined,
      },
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
  };
}
