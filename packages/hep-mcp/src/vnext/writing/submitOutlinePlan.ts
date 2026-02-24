import * as fs from 'fs';

import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { writeClientLlmResponseArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';

import { readStagedContent, stageRunContent } from './staging.js';
import { OutlinePlanV2Schema, validateOutlinePlanV2OrThrow, type OutlinePlan, type OutlinePlanRequest } from './outlinePlanner.js';

type OutlinePlanPacketArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: {
    language: OutlinePlanRequest['language'];
    target_length: OutlinePlanRequest['target_length'];
    title: string;
    topic?: string;
    structure_hints?: string;
    user_outline?: string;
    claims_artifact_name: string;
  };
};

type WritingOutlineV2Artifact = {
  version: 2;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: OutlinePlanPacketArtifactV1['request'];
  outline_plan: OutlinePlan;
};

function nowIso(): string {
  return new Date().toISOString();
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

function ensureOutlineStep(manifest: RunManifest): { manifest: RunManifest; stepIndex: number } {
  const steps = [...manifest.steps];
  let idx = steps.findIndex(s => s.step === 'writing_outline');
  if (idx === -1) {
    steps.push({ step: 'writing_outline', status: 'pending' });
    idx = steps.length - 1;
  }
  return { manifest: { ...manifest, updated_at: nowIso(), steps }, stepIndex: idx };
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
        {
          tool: 'hep_run_read_artifact_chunk',
          args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 1024 },
          reason: 'Inspect the corrupted artifact and re-generate it.',
        },
      ],
    });
  }
}

function readOutlinePlanRequestOrThrow(runId: string, promptArtifactName: string): OutlinePlanPacketArtifactV1['request'] {
  const packet = readRunJsonArtifact<OutlinePlanPacketArtifactV1>(runId, promptArtifactName);
  const request = packet?.request;
  const targetLength = request?.target_length;
  const language = request?.language;

  if (targetLength !== 'short' && targetLength !== 'medium' && targetLength !== 'long') {
    throw invalidParams('Invalid outline plan request: missing target_length', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (language !== 'en' && language !== 'zh' && language !== 'auto') {
    throw invalidParams('Invalid outline plan request: missing language', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (typeof request?.title !== 'string' || request.title.trim().length === 0) {
    throw invalidParams('Invalid outline plan request: missing title', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (typeof request?.claims_artifact_name !== 'string' || request.claims_artifact_name.trim().length === 0) {
    throw invalidParams('Invalid outline plan request: missing claims_artifact_name', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }

  return request;
}

export async function submitRunWritingOutlinePlan(params: {
  run_id: string;
  outline_plan?: Record<string, unknown>;
  outline_plan_uri?: string;
  outline_artifact_name?: string;
  prompt_packet_artifact_name?: string;
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

  const promptArtifactName = params.prompt_packet_artifact_name?.trim()
    ? params.prompt_packet_artifact_name.trim()
    : 'writing_outline_plan_packet.json';
  const request = readOutlinePlanRequestOrThrow(runId, promptArtifactName);

  const claimsArtifact = readRunJsonArtifact<any>(runId, request.claims_artifact_name);
  const claimsTable = claimsArtifact?.claims_table;
  const claims = Array.isArray(claimsTable?.claims) ? claimsTable.claims : [];
  if (!claimsTable || typeof claimsTable !== 'object') {
    throw invalidParams(`Invalid ${request.claims_artifact_name}: missing claims_table`, { run_id: runId, artifact_name: request.claims_artifact_name });
  }
  if (!Array.isArray(claimsTable?.claims)) {
    throw invalidParams(`Invalid ${request.claims_artifact_name}: claims_table.claims must be an array`, {
      run_id: runId,
      artifact_name: request.claims_artifact_name,
    });
  }

  // Load the plan (inline or staged). Always stage to preserve client raw output for reproducibility.
  let rawPlan: unknown;
  let submittedUri: string | undefined;
  let stagedRef: RunArtifactRef | null = null;
  if (params.outline_plan_uri) {
    submittedUri = params.outline_plan_uri;
    rawPlan = await readStagedContent(runId, submittedUri, 'outline_plan');
  } else if (params.outline_plan) {
    let content: string;
    try {
      content = JSON.stringify(params.outline_plan, null, 2);
    } catch (err) {
      throw invalidParams('outline_plan must be JSON-serializable (fail-fast)', {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const staged = await stageRunContent({
      run_id: runId,
      content_type: 'outline_plan',
      content,
      artifact_suffix: `outline_plan_${Date.now()}`,
    });
    submittedUri = staged.staging_uri;
    stagedRef = { name: staged.artifact_name, uri: staged.staging_uri, mimeType: 'application/json' };
    rawPlan = await readStagedContent(runId, submittedUri, 'outline_plan');
  } else {
    throw invalidParams('Exactly one of outline_plan or outline_plan_uri must be provided', { run_id: runId });
  }

  const parsed = OutlinePlanV2Schema.safeParse(rawPlan);
  if (!parsed.success) {
    const parseErrRef = writeRunJsonArtifact(runId, 'writing_parse_error_outline_v2.json', {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      schema: 'outline_plan_v2@2',
      error_stage: 'schema_parse',
      issues: parsed.error.issues,
      prompt_packet_artifact: promptArtifactName,
      raw_uri: submittedUri ?? null,
    });
    const journalRef = writeWritingJournalMarkdown({
      run_id: runId,
      step: 'writing_outline',
      round: 1,
      status: 'failed',
      title: 'OutlinePlanV2 schema mismatch',
      inputs: {
        prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
        ...(submittedUri ? { outline_plan_raw_uri: submittedUri } : {}),
      },
      outputs: { parse_error_uri: parseErrRef.uri },
      error: { message: 'Outline plan does not match OutlinePlanV2Schema', data: { issues: parsed.error.issues } },
      next_actions: [
        {
          tool: 'hep_run_writing_create_outline_candidates_packet_v1',
          args: {
            run_id: runId,
            language: request.language,
            target_length: request.target_length,
            title: request.title,
            ...(request.topic ? { topic: request.topic } : {}),
            ...(request.structure_hints ? { structure_hints: request.structure_hints } : {}),
            ...(request.user_outline ? { user_outline: request.user_outline } : {}),
          },
          reason: 'M13: Regenerate N-best outline candidates and re-judge (fail-fast; no single-sample submit).',
        },
      ],
    });
    throw invalidParams('Outline plan does not match OutlinePlanV2Schema (fail-fast)', {
      run_id: runId,
      issues: parsed.error.issues,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      journal_uri: journalRef.uri,
      journal_artifact: journalRef.name,
      next_actions: [
        {
          tool: 'hep_run_writing_create_outline_candidates_packet_v1',
          args: {
            run_id: runId,
            language: request.language,
            target_length: request.target_length,
            title: request.title,
            ...(request.topic ? { topic: request.topic } : {}),
            ...(request.structure_hints ? { structure_hints: request.structure_hints } : {}),
            ...(request.user_outline ? { user_outline: request.user_outline } : {}),
          },
          reason: 'M13: Regenerate N-best outline candidates and re-judge (fail-fast; no bypass).',
        },
      ],
    });
  }
  const plan = parsed.data;

  validateOutlinePlanV2OrThrow({
    plan,
    claims,
    target_length: request.target_length,
  });

  const outlineArtifactName = params.outline_artifact_name?.trim() ? params.outline_artifact_name.trim() : 'writing_outline_v2.json';
  const outlinePayload: WritingOutlineV2Artifact = {
    version: 2,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    request,
    outline_plan: plan,
  };
  const outlineRef = writeRunJsonArtifact(runId, outlineArtifactName, outlinePayload);
  const llmRequestName = 'llm_request_writing_outline_round_01.json';
  const llmRequestUri = fs.existsSync(getRunArtifactPath(runId, llmRequestName))
    ? `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(llmRequestName)}`
    : `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`;
  const llmResponseRef = writeClientLlmResponseArtifact({
    run_id: runId,
    artifact_name: 'llm_response_writing_outline_round_01.json',
    step: 'writing_outline',
    round: 1,
    prompt_packet_uri: llmRequestUri,
    client_raw_output_uri: submittedUri,
    parsed: plan,
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? undefined,
  });

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_outline',
    round: 1,
    pointers: {
      outline_uri: outlineRef.uri,
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      claims_table_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(request.claims_artifact_name)}`,
      llm_response_uri: llmResponseRef.uri,
      ...(submittedUri ? { submitted_uri: submittedUri } : {}),
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_outline',
    round: 1,
    status: 'success',
    title: 'OutlinePlanV2 received',
    inputs: {
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      claims_table_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(request.claims_artifact_name)}`,
      ...(submittedUri ? { submitted_uri: submittedUri } : {}),
    },
    outputs: { outline_uri: outlineRef.uri, llm_response_uri: llmResponseRef.uri, checkpoint_uri: checkpointRef.uri },
    decisions: [`sections_total=${plan.sections.length}`, `language=${plan.language}`, `target_length=${request.target_length}`],
  });

  // Mark outline step as done.
  const completedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_run_writing_submit_outline_judge_decision_v1', args: { run_id: runId } },
    update: current => {
      const ensured = ensureOutlineStep(current);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;

      const startedAt = manifest.steps[stepIndex]?.started_at ?? completedAt;
      const merged = mergeArtifactRefs(
        manifest.steps[stepIndex]?.artifacts,
        [outlineRef, llmResponseRef, checkpointRef, journalRef, ...(stagedRef ? [stagedRef] : [])]
      );
      const updatedStep: RunStep = {
        ...manifest.steps[stepIndex]!,
        status: 'done',
        started_at: startedAt,
        completed_at: completedAt,
        artifacts: merged,
        notes: 'OutlinePlanV2 received (writing_outline_v2.json).',
      };

      const next: RunManifest = {
        ...manifest,
        updated_at: completedAt,
        steps: manifest.steps.map((s, idx) => (idx === stepIndex ? updatedStep : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });

  const primaryClaims = plan.sections.filter(s => s.type === 'body').reduce((sum, s) => sum + s.assigned_claim_ids.length, 0);

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [outlineRef, llmResponseRef, checkpointRef, journalRef, ...(stagedRef ? [stagedRef] : [])],
    summary: {
      outline_uri: outlineRef.uri,
      outline_artifact: outlineArtifactName,
      sections_total: plan.sections.length,
      body_sections: plan.sections.filter(s => s.type === 'body').length,
      claims_total: claims.length,
      claims_assigned_primary: primaryClaims,
      target_length: request.target_length,
      language: plan.language,
      llm_response_uri: llmResponseRef.uri,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
  };
}
