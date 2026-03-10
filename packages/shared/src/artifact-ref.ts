/**
 * ArtifactRef runtime construction and validation helpers (H-18).
 *
 * The generated type `ArtifactRefV1` (from `meta/schemas/artifact_ref_v1.schema.json`)
 * remains the SSOT for the full content-addressed reference. This module keeps
 * lightweight provider-agnostic URI helpers in shared.
 */

import type { ArtifactRefV1 } from './generated/artifact-ref-v1.js';

export interface ArtifactRefSummary {
  name: string;
  uri: string;
  mimeType?: string;
}

/**
 * Kept as a structural alias so existing run-manifest consumers do not need a
 * rename when the helper surface becomes provider-agnostic.
 */
export type RunArtifactRef = ArtifactRefSummary;

export interface ArtifactUriParts {
  scheme: string;
  authority: string;
  pathSegments: string[];
}

export interface ScopedArtifactUriParts {
  scheme: string;
  scope: string;
  scopeId: string;
  artifactName: string;
}

function decodeSegments(rawSegments: string[]): string[] {
  return rawSegments.map(segment => decodeURIComponent(segment));
}

export function makeArtifactUri(parts: ArtifactUriParts): string {
  if (!parts.scheme) throw new Error('Artifact URI requires a non-empty scheme');
  if (!parts.authority) throw new Error('Artifact URI requires a non-empty authority');
  const encodedPath = parts.pathSegments.map(segment => encodeURIComponent(segment)).join('/');
  return encodedPath.length > 0
    ? `${parts.scheme}://${parts.authority}/${encodedPath}`
    : `${parts.scheme}://${parts.authority}`;
}

export function parseArtifactUri(uri: string): ArtifactUriParts | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (!scheme || !url.host) return null;

  try {
    return {
      scheme,
      authority: url.host,
      pathSegments: decodeSegments(url.pathname.split('/').filter(Boolean)),
    };
  } catch {
    return null;
  }
}

export function makeScopedArtifactUri(parts: ScopedArtifactUriParts): string {
  return makeArtifactUri({
    scheme: parts.scheme,
    authority: parts.scope,
    pathSegments: [parts.scopeId, 'artifact', parts.artifactName],
  });
}

export function createScopedArtifactRef(
  parts: ScopedArtifactUriParts,
  mimeType = 'application/json',
): ArtifactRefSummary {
  return {
    name: parts.artifactName,
    uri: makeScopedArtifactUri(parts),
    mimeType,
  };
}

export function parseScopedArtifactUri(
  uri: string,
  expected: Partial<Pick<ScopedArtifactUriParts, 'scheme' | 'scope'>> = {},
): ScopedArtifactUriParts | null {
  const parsed = parseArtifactUri(uri);
  if (!parsed) return null;
  if (expected.scheme && parsed.scheme !== expected.scheme) return null;
  if (expected.scope && parsed.authority !== expected.scope) return null;
  if (parsed.pathSegments.length !== 3 || parsed.pathSegments[1] !== 'artifact') return null;
  return {
    scheme: parsed.scheme,
    scope: parsed.authority,
    scopeId: parsed.pathSegments[0]!,
    artifactName: parsed.pathSegments[2]!,
  };
}

export function isScopedArtifactUri(
  uri: string,
  expected: Partial<Pick<ScopedArtifactUriParts, 'scheme' | 'scope'>> = {},
): boolean {
  return parseScopedArtifactUri(uri, expected) !== null;
}

export interface CreateArtifactRefV1Options {
  uri: string;
  sha256: string;
  kind?: string;
  schema_version?: number;
  size_bytes?: number;
  produced_by?: string;
  created_at?: string;
}

export function createArtifactRefV1(opts: CreateArtifactRefV1Options): ArtifactRefV1 {
  if (!opts.uri) throw new Error('ArtifactRefV1 requires a non-empty uri');
  if (!opts.sha256 || !/^[0-9a-f]{64}$/.test(opts.sha256)) {
    throw new Error('ArtifactRefV1 requires a valid sha256 hex digest (64 lowercase hex chars)');
  }
  return {
    uri: opts.uri,
    sha256: opts.sha256,
    ...(opts.kind !== undefined && { kind: opts.kind }),
    ...(opts.schema_version !== undefined && { schema_version: opts.schema_version }),
    ...(opts.size_bytes !== undefined && { size_bytes: opts.size_bytes }),
    ...(opts.produced_by !== undefined && { produced_by: opts.produced_by }),
    ...(opts.created_at !== undefined && { created_at: opts.created_at }),
  };
}
