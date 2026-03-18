import * as fs from 'fs';
import * as path from 'path';
import { invalidParams, notFound } from '@autoresearch/shared';

import { getRunArtifactPath } from './paths.js';
import { makeHepRunArtifactUri } from './runArtifactUri.js';

const MAX_CHUNK_BYTES = 64 * 1024;

function guessMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.jsonl') return 'application/x-ndjson';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  if (ext === '.tex') return 'text/x-tex';
  if (ext === '.bib') return 'text/x-bibtex';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.zip') return 'application/zip';
  return undefined;
}

export function readRunArtifactChunk(params: {
  run_id: string;
  artifact_name: string;
  offset?: number;
  length?: number;
}): {
  run_id: string;
  artifact_name: string;
  artifact_uri: string;
  mimeType?: string;
  file_size: number;
  offset: number;
  length: number;
  bytes_read: number;
  eof: boolean;
  chunk_base64: string;
} {
  const offset = params.offset ?? 0;
  const requested = params.length ?? 4096;

  if (!Number.isFinite(offset) || offset < 0) throw invalidParams('offset must be a non-negative number', { offset });
  if (!Number.isFinite(requested) || requested <= 0) throw invalidParams('length must be a positive number', { length: requested });
  if (requested > MAX_CHUNK_BYTES) {
    throw invalidParams(`length exceeds MAX_CHUNK_BYTES (${MAX_CHUNK_BYTES})`, { length: requested, max: MAX_CHUNK_BYTES });
  }

  const artifactPath = getRunArtifactPath(params.run_id, params.artifact_name);
  if (!fs.existsSync(artifactPath)) {
    // UX guardrail: users sometimes try to read PDG artifacts (pdg://artifacts/...) using this HEP run helper.
    // PDG artifacts should be fetched via MCP Resources (ReadResource) instead.
    const looksLikePdgArtifact = params.run_id.includes('pdg_') || params.artifact_name.includes('pdg_');
    if (looksLikePdgArtifact) {
      const guessedArtifactName = params.artifact_name.includes('pdg_') ? params.artifact_name : params.run_id;
      throw invalidParams(
        'This looks like a PDG artifact. PDG artifacts (pdg://artifacts/...) should be read via MCP Resources (ReadResource request), not via hep_run_read_artifact_chunk. ' +
          "Use fetch_mcp_resource / ReadResource with uri: pdg://artifacts/{artifact_name}.",
        {
          run_id: params.run_id,
          artifact_name: params.artifact_name,
          suggested_uri: `pdg://artifacts/${guessedArtifactName}`,
        }
      );
    }
    throw notFound('Artifact not found', { run_id: params.run_id, artifact_name: params.artifact_name });
  }

  const stat = fs.statSync(artifactPath);
  if (!stat.isFile()) {
    throw invalidParams('Artifact path is not a file', { run_id: params.run_id, artifact_name: params.artifact_name });
  }

  if (offset > stat.size) {
    throw invalidParams('offset is past end of file', { offset, file_size: stat.size });
  }

  const length = Math.min(requested, stat.size - offset);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(artifactPath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const out = buf.subarray(0, bytesRead);
  return {
    run_id: params.run_id,
    artifact_name: params.artifact_name,
    artifact_uri: makeHepRunArtifactUri(params.run_id, params.artifact_name),
    mimeType: guessMimeType(params.artifact_name),
    file_size: stat.size,
    offset,
    length: requested,
    bytes_read: bytesRead,
    eof: offset + bytesRead >= stat.size,
    chunk_base64: out.toString('base64'),
  };
}
