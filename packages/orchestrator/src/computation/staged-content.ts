import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseStagedContentArtifactV1,
  type StagedContentArtifactV1,
  type StagedContentType,
} from '@autoresearch/shared';
import { createRunArtifactRef, makeRunArtifactUri } from './artifact-refs.js';
import { writeJsonAtomic } from './io.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function stageContentInRunDir(params: {
  runId: string;
  runDir: string;
  contentType: StagedContentType;
  content: string;
  artifactSuffix?: string;
  taskId?: string;
  taskKind?: 'draft_update' | 'review';
}): {
  run_id: string;
  artifact_name: string;
  staging_uri: string;
  content_bytes: number;
} {
  const suffix = params.artifactSuffix?.trim()
    ? params.artifactSuffix.trim()
    : `${Date.now()}_${randomUUID()}`;
  const artifactName = `staged_${params.contentType}_${suffix}.json`;
  const artifactPath = path.join(params.runDir, 'artifacts', artifactName);
  const payload: StagedContentArtifactV1 = {
    version: 1,
    staged_at: nowIso(),
    content_type: params.contentType,
    content: params.content,
    ...((params.taskId || params.taskKind)
      ? {
          task_ref: {
            task_id: params.taskId!,
            task_kind: params.taskKind!,
          },
        }
      : {}),
  };
  writeJsonAtomic(artifactPath, payload);
  return {
    run_id: params.runId,
    artifact_name: artifactName,
    staging_uri: makeRunArtifactUri(params.runId, `artifacts/${artifactName}`),
    content_bytes: Buffer.byteLength(params.content, 'utf-8'),
  };
}

export function readStagedContentArtifactFromRunDir(params: {
  runDir: string;
  artifactName: string;
}): StagedContentArtifactV1 {
  const artifactPath = path.join(params.runDir, 'artifacts', params.artifactName);
  return parseStagedContentArtifactV1(
    JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as unknown,
  );
}

export function createStagedContentArtifactRef(params: {
  runId: string;
  runDir: string;
  artifactName: string;
}) {
  return createRunArtifactRef(
    params.runId,
    params.runDir,
    path.join(params.runDir, 'artifacts', params.artifactName),
    'staged_content',
  );
}
