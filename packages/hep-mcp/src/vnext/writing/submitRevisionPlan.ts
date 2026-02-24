import * as fs from 'fs';

import {
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_STAGE_CONTENT,
  HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { parseHepRunArtifactUriOrThrow } from '../runArtifactUri.js';
import { writeClientLlmResponseArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';

import { readStagedContent, stageRunContent } from './staging.js';
import { RevisionPlanV1Schema, type RevisionPlanV1 } from '../contracts/revisionPlan.js';

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
};

type WritingRevisionPlanArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: RevisionPlanPacketArtifactV1['request'];
  revision_plan: RevisionPlanV1;
  derived: {
    actions_total: number;
    action_types: Record<string, number>;
  };
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

function validatePlanInputUrisOrThrow(runId: string, plan: RevisionPlanV1): void {
  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i]!;
    for (let j = 0; j < action.inputs.length; j++) {
      const uri = action.inputs[j]!;
      const parsed = parseHepRunArtifactUriOrThrow(uri);
      if (parsed.runId !== runId) {
        throw invalidParams('Cross-run input URI is not allowed in revision_plan.actions[].inputs', {
          run_id: runId,
          uri,
          action_index: i,
          input_index: j,
        });
      }
      const p = getRunArtifactPath(runId, parsed.artifactName);
      if (!fs.existsSync(p)) {
        throw invalidParams('Referenced input artifact not found', {
          run_id: runId,
          uri,
          artifact_name: parsed.artifactName,
          action_index: i,
          input_index: j,
        });
      }
    }
  }
}

function readRunJsonArtifact<T>(runId: string, artifactName: string): T {
  const artifactPath = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams(`Missing required run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  }
  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as T;
  } catch (err) {
    const parseErrRef = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      artifact_name: artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Malformed JSON in required run artifact (fail-fast)', {
      run_id: runId,
      artifact_name: artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        { tool: HEP_RUN_READ_ARTIFACT_CHUNK, args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 1024 }, reason: 'Inspect the corrupted artifact and re-generate it.' },
      ],
    });
  }
}

function readRevisionPlanRequestOrThrow(runId: string, promptArtifactName: string, expectedRound: number): RevisionPlanPacketArtifactV1['request'] {
  const packet = readRunJsonArtifact<RevisionPlanPacketArtifactV1>(runId, promptArtifactName);
  const request = packet?.request;
  if (!request || typeof request !== 'object') {
    throw invalidParams('Invalid revision plan prompt_packet artifact: missing request', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (request.round !== expectedRound) {
    throw invalidParams(`Invalid revision plan request: expected round=${expectedRound}`, {
      run_id: runId,
      prompt_artifact_name: promptArtifactName,
      expected_round: expectedRound,
      received_round: request.round,
    });
  }
  if (typeof request.reviewer_report_uri !== 'string' || request.reviewer_report_uri.trim().length === 0) {
    throw invalidParams('Invalid revision plan request: missing reviewer_report_uri', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (typeof request.manifest_uri !== 'string' || request.manifest_uri.trim().length === 0) {
    throw invalidParams('Invalid revision plan request: missing manifest_uri', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (typeof request.quality_policy_uri !== 'string' || request.quality_policy_uri.trim().length === 0) {
    throw invalidParams('Invalid revision plan request: missing quality_policy_uri', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  return request as RevisionPlanPacketArtifactV1['request'];
}

function writeParseErrorAndThrow(runId: string, rawPlan: unknown, issues: unknown): never {
  const ref = writeRunJsonArtifact(runId, 'writing_parse_error_revision_plan_v1.json', {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    issues,
    received_revision_plan: rawPlan,
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_revise',
    round: 1,
    status: 'failed',
    title: 'RevisionPlanV1 schema mismatch',
    outputs: { parse_error_uri: ref.uri },
    error: { message: 'revision_plan does not match RevisionPlan v1 schema', data: { issues } },
    next_actions: [
      { tool: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1, args: { run_id: runId, revision_plan: '<re-run revision plan prompt_packet and re-submit>' }, reason: 'Submit a valid RevisionPlan v1 JSON.' },
    ],
  });
  throw invalidParams('revision_plan does not match RevisionPlan v1 schema (fail-fast)', {
    run_id: runId,
    parse_error_uri: ref.uri,
    parse_error_artifact: ref.name,
    journal_uri: journalRef.uri,
    journal_artifact: journalRef.name,
    next_actions: [
      {
        tool: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
        args: { run_id: runId, revision_plan: '<re-run revision plan prompt_packet and re-submit>' },
        reason: 'Submit a valid RevisionPlan v1 JSON.',
      },
    ],
  });
}

export async function submitRunWritingRevisionPlanV1(params: {
  run_id: string;
  revision_plan?: Record<string, unknown>;
  revision_plan_uri?: string;
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
  const run = getRun(runId);

  // Load plan (inline or staged). Always stage to preserve client raw output for reproducibility.
  let rawPlan: unknown;
  let submittedUri: string | undefined;
  let stagedRef: RunArtifactRef | null = null;
  if (params.revision_plan_uri) {
    submittedUri = params.revision_plan_uri;
    try {
      rawPlan = await readStagedContent(runId, submittedUri, 'revision_plan');
    } catch (err) {
      const ref = writeRunJsonArtifact(runId, 'writing_parse_error_revision_plan_v1.json', {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
        revision_plan_uri: submittedUri,
      });
      const journalRef = writeWritingJournalMarkdown({
        run_id: runId,
        step: 'writing_revise',
        round: 1,
        status: 'failed',
        title: 'Failed to read staged revision_plan',
        inputs: { revision_plan_uri: submittedUri },
        outputs: { parse_error_uri: ref.uri },
        error: { message: err instanceof Error ? err.message : String(err) },
        next_actions: [
          { tool: HEP_RUN_STAGE_CONTENT, args: { run_id: runId, content_type: 'revision_plan', content: '<JSON.stringify(RevisionPlan v1) then stage again>' }, reason: 'Stage a valid JSON RevisionPlan v1 with content_type=revision_plan.' },
          { tool: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1, args: { run_id: runId, revision_plan: '<or submit inline RevisionPlan v1 JSON>' }, reason: 'Retry submission after staging a valid revision_plan payload.' },
        ],
      });
      throw invalidParams('Failed to read staged revision_plan content (fail-fast)', {
        run_id: runId,
        revision_plan_uri: submittedUri,
        parse_error_uri: ref.uri,
        parse_error_artifact: ref.name,
        journal_uri: journalRef.uri,
        journal_artifact: journalRef.name,
        next_actions: [
          {
            tool: HEP_RUN_STAGE_CONTENT,
            args: {
              run_id: runId,
              content_type: 'revision_plan',
              content: '<JSON.stringify(RevisionPlan v1) then stage again>',
            },
            reason: 'Stage a valid JSON RevisionPlan v1 with content_type=revision_plan.',
          },
          {
            tool: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
            args: { run_id: runId, revision_plan: '<or submit inline RevisionPlan v1 JSON>' },
            reason: 'Retry submission after staging a valid revision_plan payload.',
          },
        ],
      });
    }
  } else if (params.revision_plan) {
    let content: string;
    try {
      content = JSON.stringify(params.revision_plan, null, 2);
    } catch (err) {
      throw invalidParams('revision_plan must be JSON-serializable (fail-fast)', {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const staged = await stageRunContent({
      run_id: runId,
      content_type: 'revision_plan',
      content,
      artifact_suffix: `revision_plan_${Date.now()}`,
    });
    submittedUri = staged.staging_uri;
    stagedRef = { name: staged.artifact_name, uri: staged.staging_uri, mimeType: 'application/json' };
    rawPlan = await readStagedContent(runId, submittedUri, 'revision_plan');
  } else {
    throw invalidParams('Exactly one of revision_plan or revision_plan_uri must be provided', { run_id: runId });
  }

  const parsed = RevisionPlanV1Schema.safeParse(rawPlan);
  if (!parsed.success) {
    writeParseErrorAndThrow(runId, rawPlan, parsed.error.issues);
  }
  const plan = parsed.data;

  const round = plan.round;
  const roundKey = pad2(round);

  const promptArtifactName = `writing_revision_plan_prompt_packet_round_${roundKey}.json`;
  if (!fs.existsSync(getRunArtifactPath(runId, promptArtifactName))) {
    const reviewerReportName = `writing_reviewer_report_round_${roundKey}.json`;
    const reviewerReportUri = fs.existsSync(getRunArtifactPath(runId, reviewerReportName))
      ? `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(reviewerReportName)}`
      : `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_reviewer_report.json')}`;

    throw invalidParams('Missing revision plan prompt_packet artifact (fail-fast)', {
      run_id: runId,
      round,
      missing_artifact: promptArtifactName,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1,
          args: {
            reviewer_report_uri: reviewerReportUri,
            manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
            round,
          },
          reason: 'Create the revision plan prompt_packet for this run/round (requires an existing ReviewerReport v2).',
        },
        {
          tool: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
          args: { run_id: runId, revision_plan: '<paste RevisionPlan v1 JSON here or use revision_plan_uri>' },
          reason: 'After generating a RevisionPlan v1 JSON from the prompt_packet, submit it to write run artifacts.',
        },
      ],
    });
  }

  const request = readRevisionPlanRequestOrThrow(runId, promptArtifactName, round);
  const llmRequestName = `llm_request_writing_revise_round_${roundKey}.json`;
  const llmRequestUri = fs.existsSync(getRunArtifactPath(runId, llmRequestName))
    ? `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(llmRequestName)}`
    : `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`;
  const llmResponseName = `llm_response_writing_revise_round_${roundKey}.json`;
  const llmResponseRef = writeClientLlmResponseArtifact({
    run_id: runId,
    artifact_name: llmResponseName,
    step: 'writing_revise',
    round,
    prompt_packet_uri: llmRequestUri,
    client_raw_output_uri: submittedUri,
    parsed: plan,
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? undefined,
  });

  validatePlanInputUrisOrThrow(runId, plan);

  const derivedTypes: Record<string, number> = {};
  for (const a of plan.actions) {
    derivedTypes[a.type] = (derivedTypes[a.type] ?? 0) + 1;
  }

  const artifactName = `writing_revision_plan_round_${roundKey}_v1.json`;
  const payload: WritingRevisionPlanArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    request,
    revision_plan: plan,
    derived: {
      actions_total: plan.actions.length,
      action_types: derivedTypes,
    },
  };
  const planRef = writeRunJsonArtifact(runId, artifactName, payload);
  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_revise',
    round,
    pointers: {
      revision_plan_uri: planRef.uri,
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      llm_response_uri: llmResponseRef.uri,
      ...(submittedUri ? { submitted_uri: submittedUri } : {}),
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_revise',
    round,
    status: 'success',
    title: `Revision plan received (round=${round})`,
    inputs: {
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      ...(submittedUri ? { revision_plan_raw_uri: submittedUri } : {}),
    },
    outputs: { revision_plan_uri: planRef.uri, llm_response_uri: llmResponseRef.uri, checkpoint_uri: checkpointRef.uri },
    decisions: [`actions_total=${plan.actions.length}`],
  });

  // Mark revise step as done.
  const completedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1, args: { run_id: runId } },
    update: current => {
      const ensured = ensureReviseStep(current);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;

      const startedAt = manifest.steps[stepIndex]?.started_at ?? completedAt;
      const merged = mergeArtifactRefs(
        manifest.steps[stepIndex]?.artifacts,
        [planRef, llmResponseRef, checkpointRef, journalRef, ...(stagedRef ? [stagedRef] : [])]
      );
      const updatedStep: RunStep = {
        ...manifest.steps[stepIndex]!,
        status: 'done',
        started_at: startedAt,
        completed_at: completedAt,
        artifacts: merged,
        notes: `Revision plan received (round=${round}, actions=${plan.actions.length}).`,
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
    artifacts: [planRef, llmResponseRef, checkpointRef, journalRef, ...(stagedRef ? [stagedRef] : [])],
    summary: {
      revision_plan_uri: planRef.uri,
      revision_plan_artifact: artifactName,
      round,
      actions_total: plan.actions.length,
      action_types: derivedTypes,
      llm_response_uri: llmResponseRef.uri,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
  };
}
