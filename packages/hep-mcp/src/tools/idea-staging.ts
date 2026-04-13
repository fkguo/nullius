import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidParams, McpError } from '@autoresearch/shared';
import { parseHepRunArtifactUriOrThrow } from '../core/runArtifactUri.js';
import { getDataDir } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';

export function resolveHandoffPath(handoffUri: string): string {
  if (handoffUri.startsWith('hep://')) {
    const { runId, artifactName } = parseHepRunArtifactUriOrThrow(handoffUri);
    return path.join(getDataDir(), 'runs', runId, 'artifacts', artifactName);
  }
  if (handoffUri.startsWith('file://')) {
    const ideaDataDir = process.env.IDEA_MCP_DATA_DIR?.trim();
    if (!ideaDataDir) {
      throw invalidParams('file:// handoff_uri requires IDEA_MCP_DATA_DIR to be set', {
        handoff_uri: handoffUri,
      });
    }
    let handoffPath: string;
    try {
      handoffPath = fileURLToPath(handoffUri);
    } catch (err) {
      throw invalidParams('file:// handoff_uri is not a valid file URL', {
        handoff_uri: handoffUri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      return resolvePathWithinParent(path.resolve(ideaDataDir), handoffPath, 'handoff_uri');
    } catch (err) {
      if (err instanceof McpError) throw invalidParams(err.message, err.data);
      throw err;
    }
  }
  try {
    return resolvePathWithinParent(getDataDir(), handoffUri, 'handoff_uri');
  } catch (err) {
    if (err instanceof McpError) throw invalidParams(err.message, err.data);
    throw err;
  }
}
