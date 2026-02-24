import * as fs from 'fs';
import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

import { OutlinePlanV2Schema, validateOutlinePlanV2OrThrow, type OutlinePlan, type OutlinePlanRequest } from './outlinePlanner.js';

type WritingClaimsArtifactLike = {
  claims_table?: { claims?: unknown };
};

type WritingOutlineV2ArtifactLike = {
  version?: unknown;
  request?: { target_length?: unknown } | unknown;
  outline_plan?: unknown;
};

type OutlineContractFailureArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  outline_artifact_name: string;
  error_stage: 'missing' | 'parse_error' | 'schema_mismatch' | 'validation_failed';
  error: string;
  issues?: unknown;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
};

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
        { tool: 'hep_run_read_artifact_chunk', args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 1024 }, reason: 'Inspect the corrupted artifact and re-generate it.' },
      ],
    });
  }
}

function writeOutlineContractFailureAndThrow(params: {
  run_id: string;
  outline_artifact_name: string;
  failure_artifact_name: string;
  error_stage: OutlineContractFailureArtifactV1['error_stage'];
  error: string;
  issues?: unknown;
  next_actions: OutlineContractFailureArtifactV1['next_actions'];
}): never {
  const run = getRun(params.run_id);
  const payload: OutlineContractFailureArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: params.run_id,
    project_id: run.project_id,
    outline_artifact_name: params.outline_artifact_name,
    error_stage: params.error_stage,
    error: params.error,
    ...(params.issues !== undefined ? { issues: params.issues } : {}),
    next_actions: params.next_actions,
  };
  const ref = writeRunJsonArtifact(params.run_id, params.failure_artifact_name, payload);
  throw invalidParams('Outline contract gate failed (fail-fast)', {
    run_id: params.run_id,
    outline_artifact_name: params.outline_artifact_name,
    outline_contract_failure_uri: ref.uri,
    outline_contract_failure_artifact: params.failure_artifact_name,
    next_actions: params.next_actions,
  });
}

export function requireValidWritingOutlineV2OrThrow(params: {
  run_id: string;
  outline_artifact_name?: string;
  claims_artifact_name?: string;
  failure_artifact_name?: string;
}): { outline_plan: OutlinePlan; target_length: OutlinePlanRequest['target_length']; artifacts: RunArtifactRef[] } {
  const runId = params.run_id;
  const outlineArtifactName = params.outline_artifact_name?.trim() ? params.outline_artifact_name.trim() : 'writing_outline_v2.json';
  const claimsArtifactName = params.claims_artifact_name?.trim() ? params.claims_artifact_name.trim() : 'writing_claims_table.json';
  const failureArtifactName = params.failure_artifact_name?.trim()
    ? params.failure_artifact_name.trim()
    : 'writing_outline_missing_or_invalid.json';

  const outlinePath = getRunArtifactPath(runId, outlineArtifactName);
  if (!fs.existsSync(outlinePath)) {
    writeOutlineContractFailureAndThrow({
      run_id: runId,
      outline_artifact_name: outlineArtifactName,
      failure_artifact_name: failureArtifactName,
      error_stage: 'missing',
      error: `Missing required outline artifact: ${outlineArtifactName}`,
      next_actions: [
        {
          tool: 'hep_run_writing_create_outline_candidates_packet_v1',
          args: { run_id: runId, target_length: '<short|medium|long>', title: '<title>', n_candidates: 2 },
          reason: 'M13: Create N-best outline candidates packet (N>=2 required), then follow next_actions to submit candidates + judge + write writing_outline_v2.json.',
        },
      ],
    });
  }

  const outlineArtifact = readRunJsonArtifact<WritingOutlineV2ArtifactLike>(runId, outlineArtifactName);
  const planRaw = (outlineArtifact && typeof outlineArtifact === 'object' ? (outlineArtifact as any).outline_plan : undefined) as unknown;
  const request = (outlineArtifact && typeof outlineArtifact === 'object' ? (outlineArtifact as any).request : undefined) as any;
  const targetLengthRaw = String(request?.target_length ?? '').trim();
  if (targetLengthRaw !== 'short' && targetLengthRaw !== 'medium' && targetLengthRaw !== 'long') {
    writeOutlineContractFailureAndThrow({
      run_id: runId,
      outline_artifact_name: outlineArtifactName,
      failure_artifact_name: failureArtifactName,
      error_stage: 'schema_mismatch',
      error: 'Invalid writing_outline_v2.json: request.target_length is missing/invalid',
      issues: { request_target_length: request?.target_length },
      next_actions: [
        {
          tool: 'hep_run_writing_create_outline_candidates_packet_v1',
          args: { run_id: runId, target_length: '<short|medium|long>', title: '<title>' },
          reason: 'M13: Regenerate outline candidates ensuring target_length is present, then re-judge and write writing_outline_v2.json.',
        },
      ],
    });
  }
  const target_length = targetLengthRaw as OutlinePlanRequest['target_length'];

  const parsed = OutlinePlanV2Schema.safeParse(planRaw);
  if (!parsed.success) {
    writeOutlineContractFailureAndThrow({
      run_id: runId,
      outline_artifact_name: outlineArtifactName,
      failure_artifact_name: failureArtifactName,
      error_stage: 'schema_mismatch',
      error: 'Invalid writing_outline_v2.json: outline_plan schema mismatch',
      issues: parsed.error.issues,
      next_actions: [
        {
          tool: 'hep_run_writing_create_outline_candidates_packet_v1',
          args: { run_id: runId, target_length: '<short|medium|long>', title: '<title>' },
          reason: 'M13: Regenerate outline candidates (must include cross_ref_map + claim_dependency_graph), then re-judge.',
        },
      ],
    });
  }

  const claimsArtifact = readRunJsonArtifact<WritingClaimsArtifactLike>(runId, claimsArtifactName);
  const claimsTable = claimsArtifact?.claims_table;
  const claims = Array.isArray((claimsTable as any)?.claims) ? ((claimsTable as any).claims as any[]) : [];

  try {
    validateOutlinePlanV2OrThrow({
      plan: parsed.data,
      claims,
      target_length,
    });
  } catch (err) {
    const code = (err as any)?.code;
    if (code !== 'INVALID_PARAMS') throw err;
    const data = (err as any)?.data;
    writeOutlineContractFailureAndThrow({
      run_id: runId,
      outline_artifact_name: outlineArtifactName,
      failure_artifact_name: failureArtifactName,
      error_stage: 'validation_failed',
      error: err instanceof Error ? err.message : String(err),
      issues: data,
      next_actions: [
        {
          tool: 'hep_run_writing_create_outline_candidates_packet_v1',
          args: { run_id: runId, target_length: target_length, title: '<title>' },
          reason: 'M13: Regenerate outline candidates applying the outlined issues, then re-judge (fail-fast; no single-sample resubmit).',
        },
      ],
    });
  }

  return {
    outline_plan: parsed.data,
    target_length,
    artifacts: [
      {
        name: outlineArtifactName,
        uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(outlineArtifactName)}`,
        mimeType: 'application/json',
      },
    ],
  };
}
