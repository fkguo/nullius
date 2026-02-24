import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { invalidParams } from '@autoresearch/shared';

import { getRun } from '../runs.js';
import { assertSafePathSegment, getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

type StagedContentArtifactV1 = {
  version: 1;
  staged_at: string;
  content_type: 'section_output' | 'outline_plan' | 'paperset_curation' | 'revision_plan' | 'reviewer_report' | 'judge_decision';
  content: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseRunArtifactUri(uri: string): { runId: string; artifactName: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams(`Invalid staging URI: ${uri}`, { staging_uri: uri });
  }

  if (url.protocol !== 'hep:') {
    throw invalidParams(`Invalid staging URI protocol: ${url.protocol}`, { staging_uri: uri });
  }
  if (url.host !== 'runs') {
    throw invalidParams(`Invalid staging URI host: ${url.host}`, { staging_uri: uri });
  }

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch (err) {
    throw invalidParams('Invalid staging URI encoding', { staging_uri: uri, error: String(err) });
  }
  if (segments.length !== 3 || segments[1] !== 'artifact') {
    throw invalidParams('Invalid staging URI path (expected hep://runs/<run_id>/artifact/<artifact_name>)', { staging_uri: uri });
  }

  const runId = segments[0]!;
  const artifactName = segments[2]!;

  try {
    assertSafePathSegment(runId, 'run_id');
    assertSafePathSegment(artifactName, 'artifact_name');
  } catch (err) {
    throw invalidParams('Invalid staging URI path segments', {
      staging_uri: uri,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { runId, artifactName };
}

export async function stageRunContent(params: {
  run_id: string;
  content_type: 'section_output' | 'outline_plan' | 'paperset_curation' | 'revision_plan' | 'reviewer_report' | 'judge_decision';
  content: string;
  artifact_suffix?: string;
}): Promise<{
  run_id: string;
  staging_uri: string;
  artifact_name: string;
  content_bytes: number;
}> {
  getRun(params.run_id);

  const suffix = params.artifact_suffix?.trim() ? params.artifact_suffix.trim() : `${Date.now()}_${randomUUID()}`;
  const artifactName = `staged_${params.content_type}_${suffix}.json`;

  const payload: StagedContentArtifactV1 = {
    version: 1,
    staged_at: nowIso(),
    content_type: params.content_type,
    content: params.content,
  };

  const ref = writeRunJsonArtifact(params.run_id, artifactName, payload);

  return {
    run_id: params.run_id,
    staging_uri: ref.uri,
    artifact_name: artifactName,
    content_bytes: Buffer.byteLength(params.content, 'utf-8'),
  };
}

export async function readStagedContent(
  run_id: string,
  staging_uri: string,
  expected_content_type: StagedContentArtifactV1['content_type'] = 'section_output'
): Promise<unknown> {
  const parsed = parseRunArtifactUri(staging_uri);
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
        { tool: 'hep_run_stage_content', args: { run_id, content_type: expected_content_type, content: '<valid JSON string>' }, reason: 'Re-stage valid JSON content and retry.' },
      ],
    });
  }

  const obj = artifact && typeof artifact === 'object' ? (artifact as Record<string, unknown>) : null;
  const version = obj?.version;
  const contentType = obj?.content_type;
  const content = obj?.content;

  if (version !== 1) {
    throw invalidParams('Unsupported staged artifact version', { run_id, staging_uri, artifact_name: parsed.artifactName, version });
  }
  if (contentType !== expected_content_type) {
    throw invalidParams('Unsupported staged content_type', {
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      content_type: contentType,
      expected_content_type,
    });
  }
  if (typeof content !== 'string') {
    throw invalidParams('Staged content must be a string', { run_id, staging_uri, artifact_name: parsed.artifactName });
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    const preview = content.length > 512 ? `${content.slice(0, 512)}…` : content;
    const parseErrRef = writeRunJsonArtifact(run_id, `writing_parse_error_staged_content_${parsed.artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      expected_content_type,
      error: err instanceof Error ? err.message : String(err),
      content_preview: preview,
      content_bytes: Buffer.byteLength(content, 'utf-8'),
    });
    throw invalidParams('Staged content is not valid JSON (fail-fast)', {
      run_id,
      staging_uri,
      artifact_name: parsed.artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        { tool: 'hep_run_stage_content', args: { run_id, content_type: expected_content_type, content: '<valid JSON string>' }, reason: 'Re-stage valid JSON content and retry.' },
      ],
    });
  }
}
