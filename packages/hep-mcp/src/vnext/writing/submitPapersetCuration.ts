import * as fs from 'fs';

import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { writeClientLlmResponseArtifact, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';

import { readStagedContent, stageRunContent } from './staging.js';
import type { CandidatePoolArtifactV1 } from './candidatePool.js';
import {
  PaperSetCurationV1Schema,
  validatePaperSetCurationOrThrow,
  type PaperSetCuration,
  type PaperSetCurationRequest,
} from './papersetPlanner.js';

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
};

type WritingPaperSetArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: PapersetCurationPacketArtifactV1['request'];
  paperset: PaperSetCuration;
  traceability: {
    candidate_pool_uri: string;
    prompt_packet_uri: string;
    submitted_uri?: string;
  };
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

function readPapersetRequestOrThrow(runId: string, promptArtifactName: string): PapersetCurationPacketArtifactV1['request'] {
  const packet = readRunJsonArtifact<PapersetCurationPacketArtifactV1>(runId, promptArtifactName);
  const request = packet?.request;

  const targetLength = request?.target_length;
  const language = request?.language;
  if (targetLength !== 'short' && targetLength !== 'medium' && targetLength !== 'long') {
    throw invalidParams('Invalid paperset request: missing target_length', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (language !== 'en' && language !== 'zh' && language !== 'auto') {
    throw invalidParams('Invalid paperset request: missing language', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (typeof request?.title !== 'string' || request.title.trim().length === 0) {
    throw invalidParams('Invalid paperset request: missing title', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (typeof request?.candidate_pool_artifact_name !== 'string' || request.candidate_pool_artifact_name.trim().length === 0) {
    throw invalidParams('Invalid paperset request: missing candidate_pool_artifact_name', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }
  if (!Array.isArray(request?.seed_identifiers)) {
    throw invalidParams('Invalid paperset request: missing seed_identifiers', { run_id: runId, prompt_artifact_name: promptArtifactName });
  }

  return request;
}

export async function submitRunWritingPaperSetCuration(params: {
  run_id: string;
  paperset?: Record<string, unknown>;
  paperset_uri?: string;
  paperset_artifact_name?: string;
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
    : 'writing_paperset_curation_packet.json';
  const request = readPapersetRequestOrThrow(runId, promptArtifactName);

  const pool = readRunJsonArtifact<CandidatePoolArtifactV1>(runId, request.candidate_pool_artifact_name);
  const candidatePool = Array.isArray(pool?.candidates) ? pool.candidates : [];
  if (candidatePool.length === 0) {
    throw invalidParams('Candidate pool is empty; cannot submit paperset', { run_id: runId, candidate_pool_artifact_name: request.candidate_pool_artifact_name });
  }

  // Load the paperset (inline or staged).
  let raw: unknown;
  let submittedUri: string | undefined;
  let stagedRef: RunArtifactRef | null = null;
  if (params.paperset_uri) {
    submittedUri = params.paperset_uri;
    raw = await readStagedContent(runId, submittedUri, 'paperset_curation');
  } else if (params.paperset) {
    let content: string;
    try {
      content = JSON.stringify(params.paperset, null, 2);
    } catch (err) {
      throw invalidParams('paperset must be JSON-serializable (fail-fast)', {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const staged = await stageRunContent({
      run_id: runId,
      content_type: 'paperset_curation',
      content,
      artifact_suffix: `paperset_${Date.now()}`,
    });
    submittedUri = staged.staging_uri;
    stagedRef = { name: staged.artifact_name, uri: staged.staging_uri, mimeType: 'application/json' };
    raw = await readStagedContent(runId, submittedUri, 'paperset_curation');
  } else {
    throw invalidParams('Exactly one of paperset or paperset_uri must be provided', { run_id: runId });
  }

  const parsed = PaperSetCurationV1Schema.safeParse(raw);
  if (!parsed.success) {
    const parseErrRef = writeRunJsonArtifact(runId, 'writing_parse_error_paperset_v1.json', {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      project_id: run.project_id,
      prompt_packet_artifact: promptArtifactName,
      candidate_pool_artifact: request.candidate_pool_artifact_name,
      issues: parsed.error.issues,
      raw_uri: submittedUri,
    });
    const journalRef = writeWritingJournalMarkdown({
      run_id: runId,
      step: 'writing_paperset',
      round: 1,
      status: 'failed',
      title: 'PaperSetCuration schema mismatch',
      inputs: submittedUri ? { paperset_raw_uri: submittedUri } : undefined,
      outputs: { parse_error_uri: parseErrRef.uri },
      error: { message: 'PaperSetCuration does not match PaperSetCurationV1Schema', data: { issues: parsed.error.issues } },
      next_actions: [
        {
          tool: 'hep_run_writing_submit_paperset_curation',
          args: { run_id: runId, paperset: '<valid PaperSetCuration V1 JSON>' },
          reason: 'Re-submit a valid PaperSetCuration payload.',
        },
      ],
    });
    throw invalidParams('PaperSetCuration does not match PaperSetCurationV1Schema', {
      run_id: runId,
      parse_error_uri: parseErrRef.uri,
      issues: parsed.error.issues,
      journal_uri: journalRef.uri,
      journal_artifact: journalRef.name,
    });
  }

  const paperset = parsed.data;
  validatePaperSetCurationOrThrow({ paperset, candidate_pool: candidatePool });

  const papersetArtifactName = params.paperset_artifact_name?.trim() ? params.paperset_artifact_name.trim() : 'writing_paperset_v1.json';
  const payload: WritingPaperSetArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    request,
    paperset,
    traceability: {
      candidate_pool_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(request.candidate_pool_artifact_name)}`,
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      submitted_uri: submittedUri,
    },
  };
  const papersetRef = writeRunJsonArtifact(runId, papersetArtifactName, payload);
  const llmRequestName = 'llm_request_writing_paperset_round_01.json';
  const llmRequestUri = fs.existsSync(getRunArtifactPath(runId, llmRequestName))
    ? `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(llmRequestName)}`
    : `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`;
  const llmResponseRef = writeClientLlmResponseArtifact({
    run_id: runId,
    artifact_name: 'llm_response_writing_paperset_round_01.json',
    step: 'writing_paperset',
    round: 1,
    prompt_packet_uri: llmRequestUri,
    client_raw_output_uri: submittedUri,
    parsed: paperset,
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? undefined,
  });

  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_paperset',
    round: 1,
    pointers: {
      paperset_uri: papersetRef.uri,
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      candidate_pool_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(request.candidate_pool_artifact_name)}`,
      llm_response_uri: llmResponseRef.uri,
      ...(submittedUri ? { submitted_uri: submittedUri } : {}),
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_paperset',
    round: 1,
    status: 'success',
    title: 'PaperSetCuration received',
    inputs: {
      prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(promptArtifactName)}`,
      candidate_pool_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(request.candidate_pool_artifact_name)}`,
      ...(submittedUri ? { submitted_uri: submittedUri } : {}),
    },
    outputs: { paperset_uri: papersetRef.uri, llm_response_uri: llmResponseRef.uri, checkpoint_uri: checkpointRef.uri },
    decisions: [
      `included=${paperset.included_papers.length}`,
      `excluded=${paperset.excluded_papers.length}`,
      `language=${paperset.language}`,
    ],
  });

  const completedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_run_writing_submit_paperset_curation', args: { run_id: runId } },
    update: current => {
      const ensured = ensurePaperSetStep(current);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;

      const startedAt = manifest.steps[stepIndex]?.started_at ?? completedAt;
      const merged = mergeArtifactRefs(
        manifest.steps[stepIndex]?.artifacts,
        [papersetRef, llmResponseRef, checkpointRef, journalRef, ...(stagedRef ? [stagedRef] : [])]
      );
      const updatedStep: RunStep = {
        ...manifest.steps[stepIndex]!,
        status: 'done',
        started_at: startedAt,
        completed_at: completedAt,
        artifacts: merged,
        notes: 'PaperSetCuration received (writing_paperset_v1.json).',
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
    artifacts: [papersetRef, llmResponseRef, checkpointRef, journalRef, ...(stagedRef ? [stagedRef] : [])],
    summary: {
      paperset_uri: papersetRef.uri,
      paperset_artifact: papersetArtifactName,
      included: paperset.included_papers.length,
      excluded: paperset.excluded_papers.length,
      clusters: paperset.taxonomy.clusters.length,
      axes: paperset.taxonomy.axes.length,
      target_length: request.target_length,
      language: paperset.language,
      llm_response_uri: llmResponseRef.uri,
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
  };
}
