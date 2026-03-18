import {
  createScopedArtifactRef,
  invalidParams,
  isScopedArtifactUri,
  makeScopedArtifactUri,
  parseScopedArtifactUri,
  type ArtifactRefSummary,
} from '@autoresearch/shared';

import { assertSafePathSegment } from './paths.js';

const HEP_RUN_URI_EXPECTATION = { scheme: 'hep', scope: 'runs' } as const;

export function makeHepRunsUri(): string {
  return `${HEP_RUN_URI_EXPECTATION.scheme}://${HEP_RUN_URI_EXPECTATION.scope}`;
}

export function makeHepRunManifestUri(runId: string): string {
  return `${makeHepRunsUri()}/${encodeURIComponent(runId)}/manifest`;
}

export function makeHepRunArtifactUri(runId: string, artifactName: string): string {
  return makeScopedArtifactUri({
    scheme: HEP_RUN_URI_EXPECTATION.scheme,
    scope: HEP_RUN_URI_EXPECTATION.scope,
    scopeId: runId,
    artifactName,
  });
}

export function createHepRunArtifactRef(
  runId: string,
  artifactName: string,
  mimeType?: string,
): ArtifactRefSummary {
  return createScopedArtifactRef(
    {
      scheme: HEP_RUN_URI_EXPECTATION.scheme,
      scope: HEP_RUN_URI_EXPECTATION.scope,
      scopeId: runId,
      artifactName,
    },
    mimeType,
  );
}

export function isHepRunArtifactUri(uri: string): boolean {
  return isScopedArtifactUri(uri, HEP_RUN_URI_EXPECTATION);
}

export function parseHepRunArtifactUri(uri: string): { runId: string; artifactName: string } | null {
  const parsed = parseScopedArtifactUri(uri, HEP_RUN_URI_EXPECTATION);
  if (!parsed) return null;
  return {
    runId: parsed.scopeId,
    artifactName: parsed.artifactName,
  };
}

export function parseHepRunArtifactUriOrThrow(uri: string): { runId: string; artifactName: string } {
  const parsed = parseHepRunArtifactUri(uri);
  if (!parsed) {
    throw invalidParams(
      'Invalid run artifact URI path (expected hep://runs/<run_id>/artifact/<artifact_name>)',
      { uri },
    );
  }

  assertSafePathSegment(parsed.runId, 'run_id');
  assertSafePathSegment(parsed.artifactName, 'artifact_name');
  return parsed;
}
