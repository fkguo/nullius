import * as fs from 'fs';

import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { writePromptPacketArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';

import { planOutline, type OutlinePlanRequest } from './outlinePlanner.js';

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
    claims_count: number;
    papers_count: number;
  };
  prompt_packet: Record<string, unknown>;
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

export async function createRunWritingOutlinePlanPacket(params: {
  run_id: string;
  language: OutlinePlanRequest['language'];
  target_length: OutlinePlanRequest['target_length'];
  title: string;
  topic?: string;
  structure_hints?: string;
  user_outline?: string;
  claims_table_artifact_name?: string;
  output_artifact_name?: string;
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

  const claimsArtifactName = params.claims_table_artifact_name?.trim() ? params.claims_table_artifact_name.trim() : 'writing_claims_table.json';
  const claimsArtifact = readRunJsonArtifact<any>(runId, claimsArtifactName);
  const claimsTable = claimsArtifact?.claims_table;
  if (!claimsTable || typeof claimsTable !== 'object') {
    throw invalidParams(`Invalid ${claimsArtifactName}: missing claims_table`, { run_id: runId, artifact_name: claimsArtifactName });
  }

  const request: OutlinePlanRequest = {
    run_id: runId,
    project_id: run.project_id,
    language: params.language,
    target_length: params.target_length,
    title: params.title,
    topic: params.topic,
    structure_hints: params.structure_hints,
    user_outline: params.user_outline,
    claims_table: claimsTable,
  };

  const packet = await planOutline(request, 'client');
  if (!packet || typeof packet !== 'object' || !('system_prompt' in packet)) {
    throw invalidParams('Internal: expected a PromptPacket from planOutline(llm_mode=client)', { run_id: runId });
  }

  const payload: OutlinePlanPacketArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    request: {
      language: request.language,
      target_length: request.target_length,
      title: request.title,
      topic: request.topic,
      structure_hints: request.structure_hints,
      user_outline: request.user_outline,
      claims_artifact_name: claimsArtifactName,
      claims_count: Array.isArray((claimsTable as any).claims) ? (claimsTable as any).claims.length : 0,
      papers_count: Number((claimsTable as any)?.corpus_snapshot?.paper_count ?? 0) || 0,
    },
    prompt_packet: packet as any,
  };

  const promptArtifactName = params.output_artifact_name?.trim() ? params.output_artifact_name.trim() : 'writing_outline_plan_packet.json';
  const promptRef = writeRunJsonArtifact(runId, promptArtifactName, payload);
  const llmRequestRef = writePromptPacketArtifact({
    run_id: runId,
    artifact_name: 'llm_request_writing_outline_round_01.json',
    step: 'writing_outline',
    round: 1,
    prompt_packet: packet as any,
    mode_used: 'client',
    tool: 'hep_run_writing_create_outline_candidates_packet_v1',
    schema: 'outline_plan_v2@2',
    extra: {
      prompt_packet_artifact: promptArtifactName,
      prompt_packet_uri: promptRef.uri,
    },
  });

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_outline',
    round: 1,
    pointers: {
      prompt_packet_uri: promptRef.uri,
      llm_request_uri: llmRequestRef.uri,
      claims_table_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(claimsArtifactName)}`,
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_outline',
    round: 1,
    status: 'success',
    title: 'OutlinePlanV2 prompt_packet generated',
    inputs: { claims_table_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(claimsArtifactName)}` },
    outputs: { prompt_packet_uri: promptRef.uri, llm_request_uri: llmRequestRef.uri, checkpoint_uri: checkpointRef.uri },
    decisions: [`schema=outline_plan_v2@2`, `target_length=${params.target_length}`, `language=${params.language}`],
    next_actions: [
      {
        tool: 'hep_run_writing_create_outline_candidates_packet_v1',
        args: {
          run_id: runId,
          language: params.language,
          target_length: params.target_length,
          title: params.title,
          ...(params.topic ? { topic: params.topic } : {}),
          ...(params.structure_hints ? { structure_hints: params.structure_hints } : {}),
          ...(params.user_outline ? { user_outline: params.user_outline } : {}),
        },
        reason: 'M13: Create N-best outline candidates packet (N>=2 required), then follow next_actions to submit candidates + judge + write writing_outline_v2.json.',
      },
    ],
  });

  // Mark outline step as in-progress (awaiting client submission).
  const updatedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_run_writing_create_outline_candidates_packet_v1', args: { run_id: runId } },
    update: current => {
      const ensuredAtomic = ensureOutlineStep(current);
      const base = ensuredAtomic.manifest;
      const idxAtomic = ensuredAtomic.stepIndex;

      const started = base.steps[idxAtomic]?.started_at ?? updatedAt;
      const mergedArtifacts = mergeArtifactRefs(base.steps[idxAtomic]?.artifacts, [promptRef, llmRequestRef, checkpointRef, journalRef]);
      const step: RunStep = {
        ...base.steps[idxAtomic]!,
        status: 'in_progress',
        started_at: started,
        completed_at: undefined,
        artifacts: mergedArtifacts,
        notes: 'Outline plan prompt_packet generated; awaiting M13 N-best outline candidates + judge decision.',
      };

      const next: RunManifest = {
        ...base,
        updated_at: updatedAt,
        steps: base.steps.map((s, i) => (i === idxAtomic ? step : s)),
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
      schema: 'outline_plan_v2@2',
      target_length: params.target_length,
      language: params.language,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
    next_actions: [
      {
        tool: 'hep_run_writing_create_outline_candidates_packet_v1',
        args: {
          run_id: runId,
          language: params.language,
          target_length: params.target_length,
          title: params.title,
          ...(params.topic ? { topic: params.topic } : {}),
          ...(params.structure_hints ? { structure_hints: params.structure_hints } : {}),
          ...(params.user_outline ? { user_outline: params.user_outline } : {}),
        },
        reason: 'M13: Create N-best outline candidates packet (N>=2 required), then follow next_actions to submit candidates + judge + write writing_outline_v2.json.',
      },
    ],
  };
}
