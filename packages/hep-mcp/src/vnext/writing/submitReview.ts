import * as fs from 'fs';

import {
  HEP_RUN_WRITING_SUBMIT_REVIEW,
  HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1,
  HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1,
  HEP_RUN_BUILD_WRITING_EVIDENCE,
  INSPIRE_SEARCH,
  invalidParams,
} from '@autoresearch/shared';
import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { ReviewerReportV2Schema, type ReviewerReportV2 } from '../contracts/reviewerReport.js';
import { writeClientLlmResponseArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';
import { readStagedContent, stageRunContent } from './staging.js';

function nowIso(): string {
  return new Date().toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
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

function ensureReviewStep(manifest: RunManifest): { manifest: RunManifest; stepIndex: number } {
  const steps = [...manifest.steps];
  let idx = steps.findIndex(s => s.step === 'writing_review');
  if (idx === -1) {
    steps.push({ step: 'writing_review', status: 'pending' });
    idx = steps.length - 1;
  }
  return {
    manifest: { ...manifest, updated_at: nowIso(), steps },
    stepIndex: idx,
  };
}

function summarizeReviewerReport(report: any): {
  severity: 'none' | 'minor' | 'major';
  iteration_entry: 'outline' | 'sections' | null;
  major_issues: number;
  minor_issues: number;
  follow_up_evidence_queries: number;
  structure_issues: number;
  grounding_risks: number;
} {
  const severity = report.severity;
  const iteration_entry =
    report.iteration_entry === 'outline' || report.iteration_entry === 'sections' ? report.iteration_entry : null;

  const major_issues = report.major_issues.length;
  const minor_issues = report.minor_issues.length;
  const follow_up_evidence_queries = report.follow_up_evidence_queries.length;
  const structure_issues = report.structure_issues.length;
  const grounding_risks = report.grounding_risks.length;

  return { severity, iteration_entry, major_issues, minor_issues, follow_up_evidence_queries, structure_issues, grounding_risks };
}

function recommendResumeFrom(summary: ReturnType<typeof summarizeReviewerReport>): 'outline' | 'sections' | 'review' {
  if (summary.severity === 'major') return summary.iteration_entry === 'outline' ? 'outline' : 'sections';
  return 'review';
}

// NEW-CONN-02: Resume-from → writing tool mapping
const RESUME_TOOL_MAP: Record<string, string> = {
  outline: HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
  sections: HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1,
  review: HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1,
};

/**
 * NEW-CONN-02: Build next_actions hints from review results.
 * Hint-only — does not alter execution flow.
 */
export function buildReviewNextActions(params: {
  run_id: string;
  report: ReviewerReportV2;
  resume_from: string;
  round?: number;
  reviewer_report_uri?: string;
  manifest_uri?: string;
}): Array<{ tool: string; args: Record<string, unknown>; reason: string }> {
  const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];
  const { run_id, report, resume_from } = params;

  // follow_up_evidence_queries → inspire_search + rebuild evidence
  const queries = report.follow_up_evidence_queries ?? [];
  const capped = queries.slice(0, 5);
  for (const q of capped) {
    actions.push({
      tool: INSPIRE_SEARCH,
      args: { query: q.query, size: 10 },
      reason: q.purpose.slice(0, 200),
    });
  }
  if (capped.length > 0) {
    actions.push({
      tool: HEP_RUN_BUILD_WRITING_EVIDENCE,
      args: { run_id },
      reason: 'Rebuild evidence after follow-up search',
    });
  }

  // recommended_resume_from → corresponding writing tool
  const resumeTool = RESUME_TOOL_MAP[resume_from];
  if (resumeTool) {
    // revision_plan tool takes reviewer_report_uri + manifest_uri + round (not run_id)
    const resumeArgs: Record<string, unknown> =
      resume_from === 'review' && params.reviewer_report_uri && params.manifest_uri
        ? {
            reviewer_report_uri: params.reviewer_report_uri,
            manifest_uri: params.manifest_uri,
            ...(params.round !== undefined ? { round: params.round } : {}),
          }
        : { run_id };
    actions.push({
      tool: resumeTool,
      args: resumeArgs,
      reason: `Resume writing from ${resume_from} stage`,
    });
  }

  return actions;
}

function writeParseErrorAndThrow(params: { run_id: string; round: number; raw_report: unknown; raw_uri?: string; issues: unknown }): never {
  const roundKey = pad2(params.round);
  const next_actions = [
    {
      tool: HEP_RUN_WRITING_SUBMIT_REVIEW,
      args: { run_id: params.run_id, round: params.round, reviewer_report: '<valid ReviewerReport v2 JSON>' },
      reason: 'Re-submit a valid ReviewerReport v2 payload.',
    },
  ] as const;
  const payload = {
    version: 1,
    generated_at: nowIso(),
    run_id: params.run_id,
    round: params.round,
    issues: params.issues,
    received_reviewer_report: params.raw_report,
    raw_uri: params.raw_uri ?? null,
  };
  const roundRef = writeRunJsonArtifact(params.run_id, `writing_parse_error_reviewer_report_v2_round_${roundKey}.json`, payload);
  const latestRef = writeRunJsonArtifact(params.run_id, 'writing_parse_error_reviewer_report_v2.json', payload);
  const journalRef = writeWritingJournalMarkdown({
    run_id: params.run_id,
    step: 'writing_review',
    round: params.round,
    status: 'failed',
    title: 'ReviewerReportV2 schema mismatch',
    inputs: { reviewer_report_raw_uri: params.raw_uri ?? latestRef.uri },
    outputs: { parse_error_uri: latestRef.uri },
    error: {
      message: 'reviewer_report does not match ReviewerReport v2 schema',
      data: { issues: params.issues },
    },
    next_actions: [...next_actions],
  });
  throw invalidParams('reviewer_report does not match ReviewerReport v2 schema (fail-fast)', {
    run_id: params.run_id,
    round: params.round,
    parse_error_uri: latestRef.uri,
    parse_error_artifact: latestRef.name,
    parse_error_round_uri: roundRef.uri,
    parse_error_round_artifact: roundRef.name,
    journal_uri: journalRef.uri,
    journal_artifact: journalRef.name,
    next_actions: [
      {
        tool: HEP_RUN_WRITING_SUBMIT_REVIEW,
        args: { run_id: params.run_id, round: params.round, reviewer_report: '<valid ReviewerReport v2 JSON>' },
        reason: 'Re-submit a valid ReviewerReport v2 payload.',
      },
    ],
  });
}

export async function submitRunWritingReview(params: {
  run_id: string;
  round?: number;
  reviewer_report?: ReviewerReportV2;
  reviewer_report_uri?: string;
  client_model?: string | null;
  temperature?: number | null;
  seed?: number | string | null;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const roundRaw = params.round ?? 1;
  const round = Number(roundRaw);
  if (!Number.isFinite(round) || Math.trunc(round) !== round || round < 1) {
    throw invalidParams('round must be a positive integer', { round: params.round });
  }
  const roundKey = pad2(round);

  // Load the report (inline or staged). Always stage to preserve client raw output for reproducibility.
  let rawReport: unknown;
  let rawUri: string | undefined;
  let stagedRef: RunArtifactRef | null = null;
  if (params.reviewer_report_uri) {
    rawUri = params.reviewer_report_uri;
    rawReport = await readStagedContent(runId, rawUri, 'reviewer_report');
  } else if (params.reviewer_report) {
    let content: string;
    try {
      content = JSON.stringify(params.reviewer_report, null, 2);
    } catch (err) {
      throw invalidParams('reviewer_report must be JSON-serializable (fail-fast)', {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const staged = await stageRunContent({
      run_id: runId,
      content_type: 'reviewer_report',
      content,
      artifact_suffix: `reviewer_report_${Date.now()}`,
    });
    rawUri = staged.staging_uri;
    stagedRef = { name: staged.artifact_name, uri: staged.staging_uri, mimeType: 'application/json' };
    rawReport = await readStagedContent(runId, rawUri, 'reviewer_report');
  } else {
    throw invalidParams('Exactly one of reviewer_report or reviewer_report_uri must be provided', { run_id: runId });
  }

  const parsed = ReviewerReportV2Schema.safeParse(rawReport);
  if (!parsed.success) {
    writeParseErrorAndThrow({ run_id: runId, round, raw_report: rawReport, raw_uri: rawUri, issues: parsed.error.issues });
  }
  const report = parsed.data;

  const startedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_WRITING_SUBMIT_REVIEW, args: { run_id: runId, round } },
    update: current => {
      const ensured = ensureReviewStep(current);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;
      return {
        ...manifest,
        status: 'running',
        updated_at: startedAt,
        steps: manifest.steps.map((s, idx) =>
          idx === stepIndex ? { ...s, status: 'in_progress', started_at: startedAt, completed_at: undefined } : s
        ),
      };
    },
  });
  const reportSummary = summarizeReviewerReport(report);
  const resume_from = recommendResumeFrom(reportSummary);

  const payload = {
    version: 2,
    generated_at: nowIso(),
    run_id: runId,
    round,
    reviewer_report: report,
    derived: {
      severity: reportSummary.severity,
      iteration_entry: reportSummary.iteration_entry,
      recommended_resume_from: resume_from,
    },
  };

  const artifacts: RunArtifactRef[] = [];
  const reportRoundName = `writing_reviewer_report_round_${roundKey}.json`;
  const reportLatestName = 'writing_reviewer_report.json';
  const reportRoundRef = writeRunJsonArtifact(runId, reportRoundName, payload);
  const reportLatestRef = writeRunJsonArtifact(runId, reportLatestName, payload);
  artifacts.push(reportRoundRef, reportLatestRef);
  if (stagedRef) artifacts.push(stagedRef);

  const reviewerPromptNameCandidates = [
    `writing_reviewer_prompt_round_${roundKey}.md`,
    'writing_reviewer_prompt.md',
  ];
  const reviewerContextNameCandidates = [
    `writing_reviewer_context_round_${roundKey}.md`,
    'writing_reviewer_context.md',
  ];

  const reviewerPromptName = reviewerPromptNameCandidates.find(name => fs.existsSync(getRunArtifactPath(runId, name)));
  const reviewerPromptUri = reviewerPromptName
    ? `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(reviewerPromptName)}`
    : undefined;

  // Optional: if review prompt/context exist, expose them as references on this step.
  for (const name of [
    ...reviewerPromptNameCandidates,
    ...reviewerContextNameCandidates,
  ]) {
    if (!fs.existsSync(getRunArtifactPath(runId, name))) continue;
    artifacts.push({
      name,
      uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(name)}`,
      mimeType: 'text/markdown',
    });
  }

  const llmResponseRef = writeClientLlmResponseArtifact({
    run_id: runId,
    artifact_name: `llm_response_writing_review_round_${roundKey}.json`,
    step: 'writing_review',
    round,
    prompt_packet_uri: reviewerPromptUri,
    client_raw_output_uri: rawUri,
    parsed: report,
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? undefined,
  });
  artifacts.push(llmResponseRef);

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_review',
    round,
    pointers: {
      reviewer_report_uri: reportLatestRef.uri,
      ...(rawUri ? { reviewer_report_raw_uri: rawUri } : {}),
      ...(reviewerPromptUri ? { reviewer_prompt_uri: reviewerPromptUri } : {}),
      llm_response_uri: llmResponseRef.uri,
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_review',
    round,
    status: 'success',
    title: `Reviewer report received (severity=${reportSummary.severity})`,
    inputs: {
      ...(reviewerPromptUri ? { reviewer_prompt_uri: reviewerPromptUri } : {}),
      ...(rawUri ? { reviewer_report_raw_uri: rawUri } : {}),
    },
    outputs: {
      reviewer_report_uri: reportLatestRef.uri,
      llm_response_uri: llmResponseRef.uri,
      checkpoint_uri: checkpointRef.uri,
    },
    decisions: [`recommended_resume_from=${resume_from}`],
  });
  artifacts.push(checkpointRef, journalRef);

  const completedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_WRITING_SUBMIT_REVIEW, args: { run_id: runId, round } },
    update: current => {
      const ensured = ensureReviewStep(current);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;
      const merged = mergeArtifactRefs(manifest.steps[stepIndex]?.artifacts, artifacts);
      const updatedStep: RunStep = {
        ...manifest.steps[stepIndex]!,
        status: 'done',
        started_at: manifest.steps[stepIndex]!.started_at ?? startedAt,
        completed_at: completedAt,
        artifacts: merged,
        notes: `Reviewer report received (round=${round}, severity=${reportSummary.severity})`,
      };
      const next: RunManifest = {
        ...manifest,
        updated_at: completedAt,
        steps: manifest.steps.map((s, idx) => (idx === stepIndex ? updatedStep : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts,
    summary: {
      round,
      reviewer: {
        severity: reportSummary.severity,
        major_issues: reportSummary.major_issues,
        minor_issues: reportSummary.minor_issues,
      },
      recommended_resume_from: resume_from,
      ...(reviewerPromptUri ? { reviewer_prompt_uri: reviewerPromptUri } : {}),
      ...(rawUri ? { reviewer_report_raw_uri: rawUri } : {}),
      reviewer_report_uri: reportLatestRef.uri,
      llm_response_uri: llmResponseRef.uri,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
    // NEW-CONN-02: hint-only next actions
    next_actions: buildReviewNextActions({
      run_id: runId,
      report,
      resume_from,
      round,
      reviewer_report_uri: reportLatestRef.uri,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    }),
  };
}
