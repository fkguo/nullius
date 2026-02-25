/**
 * ArtifactRef runtime construction and validation helpers (H-18).
 *
 * The generated type `ArtifactRefV1` (from `meta/schemas/artifact_ref_v1.schema.json`)
 * is the SSOT for the full content-addressed reference. This module provides:
 * - Lightweight artifact ref construction (URI + name, no hash required)
 * - Full ArtifactRefV1 construction (with sha256)
 * - URI format validation
 */

import type { ArtifactRefV1 } from './generated/artifact-ref-v1.js';

// ── Lightweight Run Artifact Ref ─────────────────────────────────────────────

/**
 * Lightweight artifact reference returned from tool results.
 * This is the "Evidence-first" summary — URI + name + optional mime type.
 * Compatible with the existing RunArtifactRef in hep-mcp.
 */
export interface RunArtifactRef {
  name: string;
  uri: string;
  mimeType?: string;
}

/** Construct a `hep://` URI for a run artifact. */
export function makeRunArtifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

/** Construct a lightweight run artifact ref. */
export function createRunArtifactRef(
  runId: string,
  artifactName: string,
  mimeType?: string,
): RunArtifactRef {
  return {
    name: artifactName,
    uri: makeRunArtifactUri(runId, artifactName),
    mimeType: mimeType ?? 'application/json',
  };
}

// ── Full ArtifactRefV1 Construction ──────────────────────────────────────────

export interface CreateArtifactRefV1Options {
  uri: string;
  sha256: string;
  kind?: string;
  schema_version?: number;
  size_bytes?: number;
  produced_by?: string;
  created_at?: string;
}

/** Construct a full content-addressed ArtifactRefV1. */
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

// ── URI Validation ───────────────────────────────────────────────────────────

const HEP_ARTIFACT_URI_RE = /^hep:\/\/runs\/[^/]+\/artifact\/[^/]+$/;

/** Check whether a string is a valid `hep://runs/<id>/artifact/<name>` URI. */
export function isHepArtifactUri(uri: string): boolean {
  return HEP_ARTIFACT_URI_RE.test(uri);
}

/** Parse a `hep://runs/<id>/artifact/<name>` URI into its components. Returns null if invalid. */
export function parseHepArtifactUri(uri: string): { runId: string; artifactName: string } | null {
  const match = /^hep:\/\/runs\/([^/]+)\/artifact\/([^/]+)$/.exec(uri);
  if (!match) return null;
  try {
    return {
      runId: decodeURIComponent(match[1]),
      artifactName: decodeURIComponent(match[2]),
    };
  } catch {
    // Malformed percent-encoding — treat as invalid URI
    return null;
  }
}
