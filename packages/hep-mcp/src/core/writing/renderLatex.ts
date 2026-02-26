import * as fs from 'fs';
import {
  HEP_RENDER_LATEX,
  HEP_RUN_BUILD_CITATION_MAPPING,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

import { verifyCitations } from '../../tools/writing/verifier/citationVerifier.js';
import type { SentenceAttribution, SentenceType } from '../../tools/writing/types.js';

import type { ReportDraft, SectionDraft, SentenceDraft } from './draftSchemas.js';

type CitekeyMappingLike = {
  status?: 'matched' | 'not_found' | 'error' | string;
  recid?: string;
  [k: string]: unknown;
};

type CitekeyToInspireMappings = Record<string, CitekeyMappingLike>;

function readJsonFile(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, 'utf-8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecidToken(token: string): string {
  const t = token.trim();
  const m = t.match(/^(?:inspire:)?(\d+)$/);
  if (!m) throw invalidParams(`Invalid recid token: ${token}`);
  return m[1];
}

function normalizeAllowedCitationsInput(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map(v => String(v).trim()).filter(Boolean);
  }
  if (isRecord(input) && Array.isArray(input.allowed_citations)) {
    return input.allowed_citations.map(v => String(v).trim()).filter(Boolean);
  }
  throw invalidParams('allowed_citations must be an array of strings or an artifact object with allowed_citations[]');
}

function normalizeCiteMappingInput(input: unknown): CitekeyToInspireMappings {
  if (!input) return {};
  if (isRecord(input) && isRecord(input.mappings)) {
    return input.mappings as CitekeyToInspireMappings;
  }
  if (isRecord(input)) {
    return input as CitekeyToInspireMappings;
  }
  throw invalidParams('cite_mapping must be a mapping record or an artifact object with mappings{}');
}

function buildRecidToCitekeys(mappings: CitekeyToInspireMappings): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [citekey, mapping] of Object.entries(mappings)) {
    const status = mapping?.status;
    const recid = mapping?.recid;
    if (status !== 'matched') continue;
    if (typeof recid !== 'string' || recid.trim().length === 0) continue;
    if (!/^\d+$/.test(recid.trim())) continue;
    const key = recid.trim();
    const list = out.get(key) ?? [];
    list.push(citekey);
    out.set(key, list);
  }
  for (const [recid, keys] of out.entries()) {
    keys.sort((a, b) => a.localeCompare(b));
    out.set(recid, keys);
  }
  return out;
}

function selectCitationKey(recid: string, recidToCitekeys: Map<string, string[]>): string {
  const keys = recidToCitekeys.get(recid);
  if (Array.isArray(keys) && keys.length > 0) return keys[0];
  // Fallback keeps LaTeX key stable even if bibliography mapping is incomplete.
  return `inspire:${recid}`;
}

function expandAllowedCitations(allowed: string[], recidToCitekeys: Map<string, string[]>): string[] {
  const out = new Set<string>();
  for (const raw of allowed) {
    const token = String(raw).trim();
    if (!token) continue;
    out.add(token);

    const m = token.match(/^(?:inspire:)?(\d+)$/);
    if (!m) continue;

    const recid = m[1];
    out.add(recid);
    out.add(`inspire:${recid}`);
    for (const citekey of recidToCitekeys.get(recid) ?? []) {
      out.add(citekey);
    }
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function sentenceTypeOrDefault(value: unknown): SentenceType {
  const t = String(value ?? '').trim();
  switch (t) {
    case 'fact':
    case 'definition':
    case 'comparison':
    case 'interpretation':
    case 'transition':
    case 'limitation':
    case 'future_work':
      return t;
    default:
      return 'fact';
  }
}

function renderSentence(params: {
  sentence: SentenceDraft;
  sentence_index: number;
  recidToCitekeys: Map<string, string[]>;
}): { rendered: string; attribution: SentenceAttribution } {
  const s = params.sentence;
  const sentenceText = (s.sentence_latex ?? s.sentence).trim();

  const recids = (s.recids ?? []).map(normalizeRecidToken);
  const citeTokens = Array.from(new Set(recids.map(r => selectCitationKey(r, params.recidToCitekeys))))
    .sort((a, b) => a.localeCompare(b));

  const rendered = citeTokens.length > 0
    ? `${sentenceText} \\cite{${citeTokens.join(',')}}`
    : sentenceText;

  const attribution: SentenceAttribution = {
    sentence: s.sentence,
    sentence_index: params.sentence_index,
    claim_ids: s.claim_ids ?? [],
    evidence_ids: s.evidence_ids ?? [],
    citations: citeTokens,
    type: sentenceTypeOrDefault(s.type),
    is_grounded: s.is_grounded ?? true,
    sentence_latex: s.sentence_latex,
  };

  return { rendered, attribution };
}

function renderSectionDraft(params: {
  draft: SectionDraft;
  recidToCitekeys: Map<string, string[]>;
  sentence_index_start: number;
}): {
  latex: string;
  attributions: SentenceAttribution[];
  sentence_index_next: number;
} {
  const attributions: SentenceAttribution[] = [];
  let sentenceIndex = params.sentence_index_start;

  const paraLatex: string[] = [];
  for (const paragraph of params.draft.paragraphs) {
    const renderedSentences: string[] = [];
    for (const sentence of paragraph.sentences) {
      const { rendered, attribution } = renderSentence({
        sentence,
        sentence_index: sentenceIndex,
        recidToCitekeys: params.recidToCitekeys,
      });
      renderedSentences.push(rendered);
      attributions.push(attribution);
      sentenceIndex += 1;
    }
    paraLatex.push(renderedSentences.join(' '));
  }

  const body = paraLatex.join('\n\n');
  const header = params.draft.title ? `\\section{${params.draft.title}}\n\n` : '';
  return {
    latex: `${header}${body}`.trim(),
    attributions,
    sentence_index_next: sentenceIndex,
  };
}

function isReportDraft(draft: SectionDraft | ReportDraft): draft is ReportDraft {
  return (draft as ReportDraft).sections !== undefined;
}

function renderDraft(params: {
  draft: SectionDraft | ReportDraft;
  recidToCitekeys: Map<string, string[]>;
}): { latex: string; attributions: SentenceAttribution[] } {
  if (!isReportDraft(params.draft)) {
    const rendered = renderSectionDraft({
      draft: params.draft,
      recidToCitekeys: params.recidToCitekeys,
      sentence_index_start: 0,
    });
    return { latex: rendered.latex, attributions: rendered.attributions };
  }

  const attributions: SentenceAttribution[] = [];
  let sentenceIndex = 0;
  const parts: string[] = [];

  for (const section of params.draft.sections) {
    const rendered = renderSectionDraft({
      draft: section,
      recidToCitekeys: params.recidToCitekeys,
      sentence_index_start: sentenceIndex,
    });
    parts.push(rendered.latex);
    attributions.push(...rendered.attributions);
    sentenceIndex = rendered.sentence_index_next;
  }

  const header = params.draft.title ? `\\section*{${params.draft.title}}\n\n` : '';
  return { latex: `${header}${parts.join('\n\n')}`.trim(), attributions };
}

function writeRunTextArtifact(runId: string, artifactName: string, content: string, mimeType: string): RunArtifactRef {
  const artifactPath = getRunArtifactPath(runId, artifactName);
  fs.writeFileSync(artifactPath, content, 'utf-8');
  return {
    name: artifactName,
    uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`,
    mimeType,
  };
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function renderLatexForRun(params: {
  run_id: string;
  draft: SectionDraft | ReportDraft;
  allowed_citations?: unknown;
  cite_mapping?: unknown;
  latex_artifact_name: string;
  section_output_artifact_name: string;
  verification_artifact_name: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: {
    sentences: number;
    total_citations: number;
    verifier_pass: boolean;
  };
}> {
  const run = getRun(params.run_id);

  const stepName = 'render_latex';
  const startedAt = new Date().toISOString();

  const manifestStart = await updateRunManifestAtomic({
    run_id: params.run_id,
    tool: { name: HEP_RENDER_LATEX, args: { run_id: params.run_id } },
    update: current => {
      const startStep: RunStep = { step: stepName, status: 'in_progress', started_at: startedAt };
      const next: RunManifest = {
        ...current,
        updated_at: startedAt,
        steps: [...current.steps, startStep],
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
  const stepIndex = manifestStart.steps.length - 1;

  const artifacts: RunArtifactRef[] = [];

  try {
    const allowed = (() => {
      if (params.allowed_citations !== undefined) return normalizeAllowedCitationsInput(params.allowed_citations);

      const p = getRunArtifactPath(params.run_id, 'allowed_citations_v1.json');
      if (!fs.existsSync(p)) {
        throw invalidParams(
          'Citation allowlist not found. Run hep_run_build_citation_mapping to generate allowed_citations_v1.json, or pass allowed_citations directly.',
          {
            run_id: params.run_id,
            artifact_name: 'allowed_citations_v1.json',
            next_actions: [
              {
                tool: HEP_RUN_BUILD_CITATION_MAPPING,
                args: {
                  run_id: params.run_id,
                  identifier: '<arXiv/DOI/recid>',
                  allowed_citations_primary: ['<inspire_recid>'],
                  include_mapped_references: true,
                },
                reason: 'Build allowlist + citekey mapping artifacts for citation verification.',
              },
            ],
          }
        );
      }
      return normalizeAllowedCitationsInput(readJsonFile(p));
    })();

    const citeMappings = (() => {
      if (params.cite_mapping !== undefined) return normalizeCiteMappingInput(params.cite_mapping);

      const p = getRunArtifactPath(params.run_id, 'citekey_to_inspire_v1.json');
      if (!fs.existsSync(p)) return {};
      return normalizeCiteMappingInput(readJsonFile(p));
    })();

    const recidToCitekeys = buildRecidToCitekeys(citeMappings);
    const expandedAllowed = expandAllowedCitations(allowed, recidToCitekeys);

    const rendered = renderDraft({ draft: params.draft, recidToCitekeys });

    const sectionOutput = {
      version: 1,
      content: rendered.latex,
      attributions: rendered.attributions,
    };

    const verificationRaw = verifyCitations({
      section_output: sectionOutput,
      claims_table: {},
      allowed_citations: expandedAllowed,
    });
    const verification = { version: 1, ...verificationRaw };

    const latexRef = writeRunTextArtifact(
      params.run_id,
      params.latex_artifact_name,
      rendered.latex,
      'text/x-tex'
    );
    artifacts.push(latexRef);

    const sectionOutputRef = writeRunJsonArtifact(params.run_id, params.section_output_artifact_name, sectionOutput);
    artifacts.push(sectionOutputRef);

    const verificationRef = writeRunJsonArtifact(params.run_id, params.verification_artifact_name, verification);
    artifacts.push(verificationRef);

    if (!verification.pass) {
      const completedAt = new Date().toISOString();
      await updateRunManifestAtomic({
        run_id: params.run_id,
        tool: { name: HEP_RENDER_LATEX, args: { run_id: params.run_id } },
        update: current => {
          const idx = current.steps[stepIndex]?.step === stepName && current.steps[stepIndex]?.started_at === startedAt
            ? stepIndex
            : current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
          if (idx < 0) {
            throw invalidParams('Internal: unable to locate run step for completion (fail-fast)', { run_id: params.run_id, step: stepName, started_at: startedAt });
          }
          const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, artifacts);
          const step: RunStep = {
            ...current.steps[idx]!,
            status: 'failed',
            started_at: current.steps[idx]!.started_at ?? startedAt,
            completed_at: completedAt,
            artifacts: merged,
            notes: 'citation verification failed',
          };
          const next: RunManifest = {
            ...current,
            updated_at: completedAt,
            steps: current.steps.map((s, i) => (i === idx ? step : s)),
          };
          return { ...next, status: computeRunStatus(next) };
        },
      });

      const unauthorizedIssue = verification.issues.find(issue => issue.type === 'unauthorized_citation');
      if (unauthorizedIssue?.citation) {
        throw invalidParams(`Citation '${unauthorizedIssue.citation}' not in allowlist. Run hep_run_build_citation_mapping to rebuild.`, {
          verification_uri: verificationRef.uri,
          issues: verification.issues,
          statistics: verification.statistics,
          next_actions: [
            {
              tool: HEP_RUN_BUILD_CITATION_MAPPING,
              args: {
                run_id: params.run_id,
                identifier: '<arXiv/DOI/recid>',
                allowed_citations_primary: ['<inspire_recid>'],
                include_mapped_references: true,
              },
              reason: 'Rebuild allowlist + citekey mapping artifacts, then rerun citation verification.',
            },
          ],
        });
      }

      throw invalidParams('Citation verification failed (missing/unauthorized/orphan citations)', {
        verification_uri: verificationRef.uri,
        issues: verification.issues,
        statistics: verification.statistics,
      });
    }

    const completedAt = new Date().toISOString();
    await updateRunManifestAtomic({
      run_id: params.run_id,
      tool: { name: HEP_RENDER_LATEX, args: { run_id: params.run_id } },
      update: current => {
        const idx = current.steps[stepIndex]?.step === stepName && current.steps[stepIndex]?.started_at === startedAt
          ? stepIndex
          : current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
        if (idx < 0) {
          throw invalidParams('Internal: unable to locate run step for completion (fail-fast)', { run_id: params.run_id, step: stepName, started_at: startedAt });
        }
        const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, artifacts);
        const step: RunStep = {
          ...current.steps[idx]!,
          status: 'done',
          started_at: current.steps[idx]!.started_at ?? startedAt,
          completed_at: completedAt,
          artifacts: merged,
        };
        const next: RunManifest = {
          ...current,
          updated_at: completedAt,
          steps: current.steps.map((s, i) => (i === idx ? step : s)),
        };
        return { ...next, status: computeRunStatus(next) };
      },
    });

    return {
      run_id: params.run_id,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(params.run_id)}/manifest`,
      artifacts,
      summary: {
        sentences: rendered.attributions.length,
        total_citations: verification.statistics.total_citations,
        verifier_pass: verification.pass,
      },
    };
  } catch (err) {
    // Best-effort: persist failure state (if not already updated).
    try {
      const completedAt = new Date().toISOString();
      await updateRunManifestAtomic({
        run_id: params.run_id,
        tool: { name: HEP_RENDER_LATEX, args: { run_id: params.run_id } },
        update: current => {
          const idx = current.steps[stepIndex]?.step === stepName && current.steps[stepIndex]?.started_at === startedAt
            ? stepIndex
            : current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
          if (idx < 0) return current;
          const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, artifacts);
          const step: RunStep = {
            ...current.steps[idx]!,
            status: 'failed',
            started_at: current.steps[idx]!.started_at ?? startedAt,
            completed_at: completedAt,
            artifacts: merged,
            notes: err instanceof Error ? err.message : String(err),
          };
          const next: RunManifest = {
            ...current,
            updated_at: completedAt,
            steps: current.steps.map((s, i) => (i === idx ? step : s)),
          };
          return { ...next, status: computeRunStatus(next) };
        },
      });
    } catch {
      // Ignore manifest update errors to preserve the original error.
    }
    throw err;
  }
}
