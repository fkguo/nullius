import { invalidParams } from '@autoresearch/shared';

import { assertSafePathSegment } from './paths.js';

export function parseHepRunArtifactUriOrThrow(uri: string): { runId: string; artifactName: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams('Invalid run artifact URI', { uri });
  }

  if (url.protocol !== 'hep:') throw invalidParams('Invalid run artifact URI protocol', { uri, protocol: url.protocol });
  if (url.host !== 'runs') throw invalidParams('Invalid run artifact URI host', { uri, host: url.host });

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch (err) {
    throw invalidParams('Invalid run artifact URI encoding', { uri, error: err instanceof Error ? err.message : String(err) });
  }
  if (segments.length !== 3 || segments[1] !== 'artifact') {
    throw invalidParams('Invalid run artifact URI path (expected hep://runs/<run_id>/artifact/<artifact_name>)', { uri });
  }

  const runId = segments[0]!;
  const artifactName = segments[2]!;
  assertSafePathSegment(runId, 'run_id');
  assertSafePathSegment(artifactName, 'artifact_name');
  return { runId, artifactName };
}

