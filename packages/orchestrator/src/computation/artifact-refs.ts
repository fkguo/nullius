import * as fs from 'node:fs';
import { createArtifactRefV1, makeScopedArtifactUri, type ArtifactRefV1 } from '@autoresearch/shared';
import { sha256File, toPosixRelative } from './io.js';

export function makeRunArtifactUri(runId: string, runRelativePath: string): string {
  return makeScopedArtifactUri({
    scheme: 'rep',
    scope: 'runs',
    scopeId: runId,
    artifactName: runRelativePath,
  });
}

export function createRunArtifactRef(
  runId: string,
  runDir: string,
  filePath: string,
  kind: string,
): ArtifactRefV1 {
  const relativePath = toPosixRelative(runDir, filePath);
  const stat = fs.statSync(filePath);
  return createArtifactRefV1({
    uri: makeRunArtifactUri(runId, relativePath),
    sha256: sha256File(filePath),
    kind,
    size_bytes: stat.size,
    produced_by: '@autoresearch/orchestrator',
  });
}
