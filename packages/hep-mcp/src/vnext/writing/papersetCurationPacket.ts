import * as fs from 'fs';

import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { writePromptPacketArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';

import type { CandidatePoolArtifactV1 } from './candidatePool.js';
import { planPaperSetCuration, type PaperSetCurationRequest } from './papersetPlanner.js';

type PapersetCurationPacketArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: {
    language: PaperSetCurationRequest['language'];
    target_length: PaperSetCurationRequest['target_length'];
    title: string;
    topic?: string;
    structure_hints?: string;
    seed_identifiers: string[];
    candidate_pool_artifact_name: string;
    candidate_count: number;
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

function ensurePaperSetStep(manifest: RunManifest): { manifest: RunManifest; stepIndex: number } {
  const steps = [...manifest.steps];
  let idx = steps.findIndex(s => s.step === 'writing_paperset');
  if (idx === -1) {
    steps.push({ step: 'writing_paperset', status: 'pending' });
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

export async function createRunWritingPaperSetCurationPacket(params: {
  run_id: string;
  language: PaperSetCurationRequest['language'];
  target_length: PaperSetCurationRequest['target_length'];
  title: string;
  topic?: string;
  structure_hints?: string;
  seed_identifiers: string[];
  candidate_pool_artifact_name?: string;
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

  const candidatePoolArtifactName = params.candidate_pool_artifact_name?.trim()
    ? params.candidate_pool_artifact_name.trim()
    : 'writing_candidate_pool_v1.json';
  const pool = readRunJsonArtifact<CandidatePoolArtifactV1>(runId, candidatePoolArtifactName);
  const candidates = Array.isArray(pool?.candidates) ? pool.candidates : [];
  if (candidates.length === 0) {
    throw invalidParams('Candidate pool is empty; cannot create paperset curation packet', {
      run_id: runId,
      candidate_pool_artifact_name: candidatePoolArtifactName,
    });
  }

  const request: PaperSetCurationRequest = {
    run_id: runId,
    project_id: run.project_id,
    language: params.language,
    target_length: params.target_length,
    title: params.title,
    topic: params.topic,
    structure_hints: params.structure_hints,
    seed_identifiers: params.seed_identifiers,
    candidate_pool: candidates,
  };

  const packet = await planPaperSetCuration(request, 'client');
  if (!packet || typeof packet !== 'object' || !('system_prompt' in packet)) {
    throw invalidParams('Internal: expected a PromptPacket from planPaperSetCuration(llm_mode=client)', { run_id: runId });
  }

  const payload: PapersetCurationPacketArtifactV1 = {
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
      seed_identifiers: request.seed_identifiers,
      candidate_pool_artifact_name: candidatePoolArtifactName,
      candidate_count: candidates.length,
    },
    prompt_packet: packet as any,
  };

  const promptArtifactName = params.output_artifact_name?.trim()
    ? params.output_artifact_name.trim()
    : 'writing_paperset_curation_packet.json';
  const promptRef = writeRunJsonArtifact(runId, promptArtifactName, payload);
  const llmRequestRef = writePromptPacketArtifact({
    run_id: runId,
    artifact_name: 'llm_request_writing_paperset_round_01.json',
    step: 'writing_paperset',
    round: 1,
    prompt_packet: packet as any,
    mode_used: 'client',
    tool: 'hep_run_writing_create_paperset_curation_packet',
    schema: 'paperset_curation_v1@1',
    extra: {
      prompt_packet_artifact: promptArtifactName,
      prompt_packet_uri: promptRef.uri,
    },
  });

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_paperset',
    round: 1,
    pointers: {
      prompt_packet_uri: promptRef.uri,
      llm_request_uri: llmRequestRef.uri,
      candidate_pool_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(candidatePoolArtifactName)}`,
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_paperset',
    round: 1,
    status: 'success',
    title: 'PaperSetCuration prompt_packet generated',
    inputs: { candidate_pool_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(candidatePoolArtifactName)}` },
    outputs: { prompt_packet_uri: promptRef.uri, llm_request_uri: llmRequestRef.uri, checkpoint_uri: checkpointRef.uri },
    decisions: [`schema=paperset_curation_v1@1`, `target_length=${params.target_length}`, `language=${params.language}`],
    next_actions: [
      {
        tool: 'hep_run_writing_submit_paperset_curation',
        args: { run_id: runId, paperset: '<paste PaperSetCuration JSON here or use paperset_uri>' },
        reason: 'Submit PaperSetCuration (fail-fast validated) to write writing_paperset_v1.json and unblock the writing pipeline.',
      },
    ],
  });

  // Mark paperset step as in-progress (awaiting client submission).
  const updatedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_run_writing_create_paperset_curation_packet', args: { run_id: runId } },
    update: current => {
      const ensured = ensurePaperSetStep(current);
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
        notes: 'Paperset curation prompt_packet generated; awaiting hep_run_writing_submit_paperset_curation.',
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
      schema: 'paperset_curation_v1@1',
      target_length: params.target_length,
      language: params.language,
      candidates_total: candidates.length,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
    next_actions: [
      {
        tool: 'hep_run_writing_submit_paperset_curation',
        args: {
          run_id: runId,
          paperset: '<paste PaperSetCuration JSON here or use paperset_uri>',
        },
        reason: 'Submit PaperSetCuration (fail-fast validated) to write writing_paperset_v1.json and unblock the writing pipeline.',
      },
    ],
  };
}
