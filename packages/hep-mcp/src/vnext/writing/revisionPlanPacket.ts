import * as fs from 'fs';

import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { assertSafePathSegment, getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { writePromptPacketArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';

import { makePromptPacketFromZod } from '../contracts/promptPacket.js';
import { ReviewerReportV2Schema, type ReviewerReportV2 } from '../contracts/reviewerReport.js';
import { RevisionPlanV1Schema } from '../contracts/revisionPlan.js';
import { WritingQualityPolicyV1Schema } from './qualityPolicy.js';

type RevisionPlanPacketArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: {
    reviewer_report_uri: string;
    manifest_uri: string;
    quality_policy_uri: string;
    round: number;
  };
  prompt_packet: Record<string, unknown>;
};

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

function ensureReviseStep(manifest: RunManifest): { manifest: RunManifest; stepIndex: number } {
  const steps = [...manifest.steps];
  let idx = steps.findIndex(s => s.step === 'writing_revise');
  if (idx === -1) {
    steps.push({ step: 'writing_revise', status: 'pending' });
    idx = steps.length - 1;
  }
  return { manifest: { ...manifest, updated_at: nowIso(), steps }, stepIndex: idx };
}

function parseRunArtifactUri(uri: string): { runId: string; artifactName: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams('Invalid run artifact URI', { uri });
  }

  if (url.protocol !== 'hep:') throw invalidParams('Invalid run artifact URI protocol', { uri, protocol: url.protocol });
  if (url.host !== 'runs') throw invalidParams('Invalid run artifact URI host', { uri, host: url.host });

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch (err) {
    throw invalidParams('Invalid run artifact URI encoding', { uri, error: err instanceof Error ? err.message : String(err) });
  }
  if (segments.length !== 3 || segments[1] !== 'artifact') {
    throw invalidParams('Invalid run artifact URI path (expected hep://runs/<run_id>/artifact/<artifact_name>)', { uri });
  }

  const runId = segments[0]!;
  const artifactName = segments[2]!;
  assertSafePathSegment(runId, 'run_id');
  assertSafePathSegment(artifactName, 'artifact_name');
  return { runId, artifactName };
}

function parseRunManifestUri(uri: string): { runId: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams('Invalid run manifest URI', { uri });
  }

  if (url.protocol !== 'hep:') throw invalidParams('Invalid run manifest URI protocol', { uri, protocol: url.protocol });
  if (url.host !== 'runs') throw invalidParams('Invalid run manifest URI host', { uri, host: url.host });

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch (err) {
    throw invalidParams('Invalid run manifest URI encoding', { uri, error: err instanceof Error ? err.message : String(err) });
  }

  if (segments.length !== 2 || segments[1] !== 'manifest') {
    throw invalidParams('Invalid run manifest URI path (expected hep://runs/<run_id>/manifest)', { uri });
  }

  const runId = segments[0]!;
  assertSafePathSegment(runId, 'run_id');
  return { runId };
}

function readRunArtifactJsonOrThrow<T>(runId: string, uri: string): T {
  const parsed = parseRunArtifactUri(uri);
  if (parsed.runId !== runId) {
    throw invalidParams('Cross-run artifact reference is not allowed', { run_id: runId, uri });
  }

  const artifactPath = getRunArtifactPath(runId, parsed.artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Run artifact not found', { run_id: runId, uri, artifact_name: parsed.artifactName });
  }

  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as T;
  } catch (err) {
    const parseErrRef = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${parsed.artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      uri,
      artifact_name: parsed.artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Malformed JSON in run artifact (fail-fast)', {
      run_id: runId,
      uri,
      artifact_name: parsed.artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        { tool: 'hep_run_read_artifact_chunk', args: { run_id: runId, artifact_name: parsed.artifactName, offset: 0, length: 1024 }, reason: 'Inspect the corrupted artifact and re-generate it.' },
      ],
    });
  }
}

function extractReviewerReportOrThrow(runId: string, reviewerReportUri: string): ReviewerReportV2 {
  const parseErrorName = 'writing_parse_error_reviewer_report_v2.json';
  let rawPayload: unknown;
  try {
    rawPayload = readRunArtifactJsonOrThrow<unknown>(runId, reviewerReportUri);
  } catch (err) {
    const ref = writeRunJsonArtifact(runId, parseErrorName, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      reviewer_report_uri: reviewerReportUri,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Failed to read reviewer report artifact (fail-fast)', {
      run_id: runId,
      reviewer_report_uri: reviewerReportUri,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: [
        {
          tool: 'hep_run_writing_submit_review',
          args: { run_id: runId, reviewer_report: '<submit a valid ReviewerReport v2 JSON first>' },
          reason: 'Revision planning requires a valid ReviewerReport v2 artifact.',
        },
      ],
    });
  }

  const payload = rawPayload && typeof rawPayload === 'object' ? (rawPayload as Record<string, unknown>) : null;
  const reportRaw = payload?.reviewer_report;
  const parsed = ReviewerReportV2Schema.safeParse(reportRaw);
  if (!parsed.success) {
    const ref = writeRunJsonArtifact(runId, parseErrorName, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      reviewer_report_uri: reviewerReportUri,
      issues: parsed.error.issues,
      received_reviewer_report: reportRaw,
    });
    throw invalidParams('reviewer_report does not match ReviewerReport v2 schema (fail-fast)', {
      run_id: runId,
      reviewer_report_uri: reviewerReportUri,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: [
        {
          tool: 'hep_run_writing_submit_review',
          args: { run_id: runId, reviewer_report: '<re-run reviewer prompt and re-submit ReviewerReport v2 JSON>' },
          reason: 'Revision planning requires a valid ReviewerReport v2 artifact.',
        },
      ],
    });
  }
  return parsed.data;
}

function ensureQualityPolicyOrThrow(runId: string, qualityPolicyUri: string): void {
  const raw = readRunArtifactJsonOrThrow<unknown>(runId, qualityPolicyUri);
  const parsed = WritingQualityPolicyV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw invalidParams('quality_policy_uri does not match WritingQualityPolicyV1Schema (fail-fast)', {
      run_id: runId,
      quality_policy_uri: qualityPolicyUri,
      issues: parsed.error.issues,
    });
  }
}

export async function createRunWritingRevisionPlanPacketV1(params: {
  reviewer_report_uri: string;
  manifest_uri: string;
  quality_policy_uri?: string;
  round?: number;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const parsedManifest = parseRunManifestUri(params.manifest_uri);
  const runId = parsedManifest.runId;
  const run = getRun(runId);

  const round = (() => {
    if (params.round === undefined) return 1;
    const n = typeof params.round === 'number' ? params.round : Number(params.round);
    if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 1) {
      throw invalidParams('round must be a positive integer', { round: params.round });
    }
    return n;
  })();

  const reviewerParsed = parseRunArtifactUri(params.reviewer_report_uri);
  if (reviewerParsed.runId !== runId) {
    throw invalidParams('Cross-run reviewer_report_uri is not allowed', {
      run_id: runId,
      reviewer_report_uri: params.reviewer_report_uri,
      manifest_uri: params.manifest_uri,
    });
  }

  const qualityPolicyUri = params.quality_policy_uri?.trim()
    ? params.quality_policy_uri.trim()
    : `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_quality_policy_v1.json')}`;
  const qualityParsed = parseRunArtifactUri(qualityPolicyUri);
  if (qualityParsed.runId !== runId) {
    throw invalidParams('Cross-run quality_policy_uri is not allowed', {
      run_id: runId,
      quality_policy_uri: qualityPolicyUri,
      manifest_uri: params.manifest_uri,
    });
  }

  const reviewerReport = extractReviewerReportOrThrow(runId, params.reviewer_report_uri);
  ensureQualityPolicyOrThrow(runId, qualityPolicyUri);

  const contextUris: string[] = [params.reviewer_report_uri, params.manifest_uri, qualityPolicyUri];
  for (const name of ['writing_reviewer_context.md', 'writing_integrated.tex']) {
    if (!fs.existsSync(getRunArtifactPath(runId, name))) continue;
    contextUris.push(`hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(name)}`);
  }

  const packet = makePromptPacketFromZod({
    schema_name: 'revision_plan_v1',
    schema_version: 1,
    expected_output_format: 'json',
    output_zod_schema: RevisionPlanV1Schema,
    system_prompt: [
      'You are a careful, senior scientific editor and reviewer-response planner.',
      'Your job is to produce an executable RevisionPlan (action list) for the paper draft run.',
      '',
      'Hard constraints:',
      '- Output MUST be valid JSON and must match the provided output_schema exactly (strict; no extra keys).',
      '- Evidence-first: each action.inputs must list existing run artifact URIs (hep://runs/<run_id>/artifact/<name>).',
      '- Fail-fast mindset: prefer explicit, verifiable steps; do not propose vague edits.',
      '- No cross-run references: NEVER reference hep://runs/<other_run_id>/... .',
    ].join('\n'),
    user_prompt: [
      `Run: ${runId}`,
      `Round: ${round}`,
      '',
      'Reviewer report summary (derived):',
      `- severity: ${reviewerReport.severity}`,
      `- major_issues: ${reviewerReport.major_issues.length}`,
      `- minor_issues: ${reviewerReport.minor_issues.length}`,
      `- follow_up_evidence_queries: ${reviewerReport.follow_up_evidence_queries.length}`,
      `- structure_issues: ${reviewerReport.structure_issues.length}`,
      `- grounding_risks: ${reviewerReport.grounding_risks.length}`,
      '',
      'Deliverable:',
      `- Produce a RevisionPlanV1 JSON with version=1, round=${round}, and max_rounds>=${round}.`,
      '- actions[] can be empty ONLY if severity=\"none\" and you are confident all gates will pass.',
      '',
      'Guidance:',
      '- Use rewrite_section actions for structural/clarity issues, with concrete rewrite_instructions.',
      '- Use add_evidence actions to address follow_up_evidence_queries and grounding_risks.',
      '- Include expected_verifications for every action (e.g., citations, originality, assets, cross_references, structure, latex_compile).',
    ].join('\n'),
    context_uris: contextUris,
  });

  const payload: RevisionPlanPacketArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    request: {
      reviewer_report_uri: params.reviewer_report_uri,
      manifest_uri: params.manifest_uri,
      quality_policy_uri: qualityPolicyUri,
      round,
    },
    prompt_packet: packet as any,
  };

  const promptArtifactName = `writing_revision_plan_prompt_packet_round_${pad2(round)}.json`;
  const promptRef = writeRunJsonArtifact(runId, promptArtifactName, payload);
  const llmRequestRef = writePromptPacketArtifact({
    run_id: runId,
    artifact_name: `llm_request_writing_revise_round_${pad2(round)}.json`,
    step: 'writing_revise',
    round,
    prompt_packet: packet as any,
    mode_used: 'client',
    tool: 'hep_run_writing_create_revision_plan_packet_v1',
    schema: 'revision_plan_v1@1',
    extra: {
      prompt_packet_artifact: promptArtifactName,
      prompt_packet_uri: promptRef.uri,
      reviewer_report_uri: params.reviewer_report_uri,
      manifest_uri: params.manifest_uri,
      quality_policy_uri: qualityPolicyUri,
    },
  });

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_revise',
    round,
    pointers: {
      reviewer_report_uri: params.reviewer_report_uri,
      prompt_packet_uri: promptRef.uri,
      llm_request_uri: llmRequestRef.uri,
      manifest_uri: params.manifest_uri,
      quality_policy_uri: qualityPolicyUri,
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_revise',
    round,
    status: 'success',
    title: `RevisionPlanV1 prompt_packet generated (round=${round})`,
    inputs: { reviewer_report_uri: params.reviewer_report_uri, manifest_uri: params.manifest_uri, quality_policy_uri: qualityPolicyUri },
    outputs: { prompt_packet_uri: promptRef.uri, llm_request_uri: llmRequestRef.uri, checkpoint_uri: checkpointRef.uri },
    decisions: [`schema=revision_plan_v1@1`],
    next_actions: [
      {
        tool: 'hep_run_writing_submit_revision_plan_v1',
        args: { run_id: runId, revision_plan: '<paste RevisionPlan v1 JSON here or use revision_plan_uri>' },
        reason: `Run this prompt_packet with an LLM, then submit RevisionPlan v1 for round=${round}.`,
      },
    ],
  });

  // Mark revise step as in-progress (awaiting client submission).
  const updatedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_run_writing_create_revision_plan_packet_v1', args: { reviewer_report_uri: params.reviewer_report_uri, manifest_uri: params.manifest_uri, quality_policy_uri: params.quality_policy_uri, round } },
    update: current => {
      const ensured = ensureReviseStep(current);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;

      const startedAt = manifest.steps[stepIndex]?.started_at ?? updatedAt;
      const merged = mergeArtifactRefs(manifest.steps[stepIndex]?.artifacts, [promptRef, llmRequestRef, checkpointRef, journalRef]);
      const updatedStep: RunStep = {
        ...manifest.steps[stepIndex]!,
        status: 'in_progress',
        started_at: startedAt,
        completed_at: undefined,
        artifacts: merged,
        notes: `Revision plan prompt_packet generated (round=${round}); awaiting hep_run_writing_submit_revision_plan_v1.`,
      };

      const next: RunManifest = {
        ...manifest,
        updated_at: updatedAt,
        steps: manifest.steps.map((s, idx) => (idx === stepIndex ? updatedStep : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [promptRef, llmRequestRef, checkpointRef, journalRef],
    summary: {
      prompt_packet_uri: promptRef.uri,
      prompt_packet_artifact: promptArtifactName,
      llm_request_uri: llmRequestRef.uri,
      schema: 'revision_plan_v1@1',
      round,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
    next_actions: [
      {
        tool: 'hep_run_writing_submit_revision_plan_v1',
        args: {
          run_id: runId,
          revision_plan: '<paste RevisionPlan v1 JSON here or use revision_plan_uri>',
        },
        reason: `Run this prompt_packet with an LLM, then submit RevisionPlan v1 for round=${round}.`,
      },
    ],
  };
}
