import * as fs from 'fs';
import {
  invalidParams,
  parseStagedContentArtifactV1,
} from '@autoresearch/shared';
import { stageContentInRunDir } from '@autoresearch/orchestrator';

import { getRun } from '../runs.js';
import { getRunArtifactPath, getRunDir } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { HEP_RUN_STAGE_CONTENT } from '../../tool-names.js';
import { parseHepRunArtifactUriOrThrow } from '../runArtifactUri.js';

function nowIso(): string {
  return new Date().toISOString();
}

export async function stageRunContent(params: {
  run_id: string;
  content_type: 'section_output' | 'outline_plan' | 'paperset_curation' | 'revision_plan' | 'reviewer_report' | 'judge_decision';
  content: string;
  artifact_suffix?: string;
  task_id?: string;
  task_kind?: 'draft_update' | 'review';
}): Promise<{
  run_id: string;
  staging_uri: string;
  artifact_name: string;
  content_bytes: number;
}> {
  const run = getRun(params.run_id);
  const staged = stageContentInRunDir({
    runId: params.run_id,
    runDir: getRunDir(params.run_id),
    contentType: params.content_type,
    content: params.content,
    artifactSuffix: params.artifact_suffix,
    taskId: params.task_id,
    taskKind: params.task_kind,
  });
  const repArtifactName = staged.artifact_name;

  return {
    run_id: params.run_id,
    staging_uri: `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent(repArtifactName)}`,
    artifact_name: repArtifactName,
    content_bytes: staged.content_bytes,
  };
}

export async function readStagedContent(
  run_id: string,
  staging_uri: string,
  expected_content_type: 'section_output' | 'outline_plan' | 'paperset_curation' | 'revision_plan' | 'reviewer_report' | 'judge_decision' = 'section_output'
): Promise<unknown> {
  const parsed = parseHepRunArtifactUriOrThrow(staging_uri);
  if (parsed.runId !== run_id) {
    throw invalidParams('Cross-run staging reference is not allowed', { run_id, staging_uri });
  }

  const artifactPath = getRunArtifactPath(run_id, parsed.artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Staged artifact not found', { run_id, staging_uri, artifact_name: parsed.artifactName });
  }

  let artifact: unknown;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  } catch (err) {
    const parseErrRef = writeRunJsonArtifact(run_id, `writing_parse_error_staged_artifact_${parsed.artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Staged artifact is not valid JSON (fail-fast)', {
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        { tool: HEP_RUN_STAGE_CONTENT, args: { run_id, content_type: expected_content_type, content: '<valid JSON string>' }, reason: 'Re-stage valid JSON content and retry.' },
      ],
    });
  }

  let stagedArtifact;
  try {
    stagedArtifact = parseStagedContentArtifactV1(artifact);
  } catch (err) {
    throw invalidParams('Unsupported staged artifact shape', {
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (stagedArtifact.content_type !== expected_content_type) {
    throw invalidParams('Unsupported staged content_type', {
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      content_type: stagedArtifact.content_type,
      expected_content_type,
    });
  }

  try {
    return JSON.parse(stagedArtifact.content);
  } catch (err) {
    const preview = stagedArtifact.content.length > 512 ? `${stagedArtifact.content.slice(0, 512)}…` : stagedArtifact.content;
    const parseErrRef = writeRunJsonArtifact(run_id, `writing_parse_error_staged_content_${parsed.artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      expected_content_type,
      error: err instanceof Error ? err.message : String(err),
      content_preview: preview,
      content_bytes: Buffer.byteLength(stagedArtifact.content, 'utf-8'),
    });
    throw invalidParams('Staged content is not valid JSON (fail-fast)', {
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        { tool: HEP_RUN_STAGE_CONTENT, args: { run_id, content_type: expected_content_type, content: '<valid JSON string>' }, reason: 'Re-stage valid JSON content and retry.' },
      ],
    });
  }
}
