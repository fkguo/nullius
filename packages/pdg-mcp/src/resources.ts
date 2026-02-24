import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { invalidParams, notFound } from '@autoresearch/shared';
import { getArtifactsDir, ensureDir } from './data/dataDir.js';
import { assertSafePathSegment, resolvePathWithinParent } from './data/pathGuard.js';

const PDG_ARTIFACT_DELETE_AFTER_READ_ENV = 'PDG_ARTIFACT_DELETE_AFTER_READ';

function shouldDeleteArtifactAfterRead(): boolean {
  const raw = process.env[PDG_ARTIFACT_DELETE_AFTER_READ_ENV];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

export interface PdgResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface PdgResourceTemplate {
  name: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
}

export type PdgResourceContents =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

function guessMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.jsonl') return 'application/x-ndjson';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.zip') return 'application/zip';
  return undefined;
}

function sha256FileSync(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function parsePdgUri(uri: string):
  | { kind: 'info' }
  | { kind: 'artifacts_index' }
  | { kind: 'artifact'; name: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams(`Invalid resource URI: ${uri}`);
  }

  if (url.protocol !== 'pdg:') {
    throw invalidParams(`Unsupported resource protocol: ${url.protocol}`);
  }

  const host = url.host;
  const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));

  if (host === 'info' && segments.length === 0) return { kind: 'info' };
  if (host === 'artifacts' && segments.length === 0) return { kind: 'artifacts_index' };
  if (host === 'artifacts' && segments.length === 1) return { kind: 'artifact', name: segments[0] };

  throw notFound(`Unknown resource URI: ${uri}`, { uri });
}

export function listPdgResources(): PdgResource[] {
  return [
    {
      uri: 'pdg://info',
      name: 'pdg_info',
      title: 'PDG MCP info',
      description: 'Server info and local data directories (local-only)',
      mimeType: 'application/json',
    },
    {
      uri: 'pdg://artifacts',
      name: 'pdg_artifacts',
      title: 'PDG MCP artifacts',
      description: 'List artifacts on disk (local-only)',
      mimeType: 'application/json',
    },
  ];
}

export function listPdgResourceTemplates(): PdgResourceTemplate[] {
  return [
    {
      name: 'pdg_artifact',
      uriTemplate: 'pdg://artifacts/{artifact_name}',
      description: 'Read a PDG artifact by name. Discover available names via pdg://artifacts.',
      mimeType: 'application/json',
    },
  ];
}

export function readPdgResource(uri: string): PdgResourceContents {
  const parsed = parsePdgUri(uri);

  const deleteAfterRead = shouldDeleteArtifactAfterRead();

  if (parsed.kind === 'info') {
    const artifactsDir = getArtifactsDir();
    ensureDir(artifactsDir);

    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          server: { name: 'pdg-mcp', version: '0.3.0' },
          artifacts_dir: artifactsDir,
        },
        null,
        2
      ),
    };
  }

  if (parsed.kind === 'artifacts_index') {
    const artifactsDir = getArtifactsDir();
    ensureDir(artifactsDir);

    const artifacts = fs.readdirSync(artifactsDir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const p = path.join(artifactsDir, e.name);
        let size_bytes: number | undefined;
        try {
          size_bytes = fs.statSync(p).size;
        } catch {
          size_bytes = undefined;
        }
        return {
          name: e.name,
          uri: `pdg://artifacts/${encodeURIComponent(e.name)}`,
          mimeType: guessMimeType(e.name),
          size_bytes,
        };
      });

    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ artifacts }, null, 2),
    };
  }

  const artifactsDir = getArtifactsDir();
  ensureDir(artifactsDir);

  assertSafePathSegment(parsed.name, 'artifact name');
  const artifactPath = resolvePathWithinParent(artifactsDir, parsed.name, 'artifact name');
  if (!fs.existsSync(artifactPath)) {
    throw notFound('Artifact not found', { name: parsed.name });
  }

  const stat = fs.statSync(artifactPath);
  if (!stat.isFile()) {
    throw invalidParams('Artifact is not a file', { name: parsed.name });
  }

  const ext = path.extname(parsed.name).toLowerCase();
  const isText = ext === '.json' || ext === '.jsonl' || ext === '.txt' || ext === '.md';
  const mimeType = guessMimeType(parsed.name);

  if (isText) {
    const text = fs.readFileSync(artifactPath, 'utf-8');
    if (deleteAfterRead) {
      try {
        fs.rmSync(artifactPath, { force: true });
      } catch {
        // ignore
      }
    }
    return { uri, mimeType, text };
  }

  // Binary artifacts: return metadata JSON only (no base64 payload).
  const digest = sha256FileSync(artifactPath);
  const result: PdgResourceContents = {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(
      {
        file_path: artifactPath,
        size_bytes: stat.size,
        sha256: digest,
        mimeType: mimeType ?? 'application/octet-stream',
      },
      null,
      2
    ),
  };
  if (deleteAfterRead) {
    try {
      fs.rmSync(artifactPath, { force: true });
    } catch {
      // ignore
    }
  }
  return result;
}
