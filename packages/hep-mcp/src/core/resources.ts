import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { invalidParams, notFound } from '@autoresearch/shared';
import { getProject, listProjects } from './projects.js';
import { listRuns } from './runs.js';
import { getProjectArtifactPath, getProjectPaperEvidenceCatalogPath, getRunArtifactPath, getRunManifestPath } from './paths.js';
import { getPaper, listPapers } from './papers.js';


export interface HepResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export type HepResourceContents =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

function projectUri(projectId: string): string {
  return `hep://projects/${encodeURIComponent(projectId)}`;
}

function paperUri(projectId: string, paperId: string): string {
  return `hep://projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}`;
}

function runManifestUri(runId: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/manifest`;
}

function runsUri(): string {
  return 'hep://runs';
}

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

function sha256FileHex(filePath: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      offset += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function parseHepUri(uri: string):
  | { kind: 'projects_index' }
  | { kind: 'project'; projectId: string }
  | { kind: 'project_artifact'; projectId: string; artifactName: string }
  | { kind: 'project_papers'; projectId: string }
  | { kind: 'paper'; projectId: string; paperId: string }
  | { kind: 'paper_evidence_catalog'; projectId: string; paperId: string }
  | { kind: 'runs_index' }
  | { kind: 'run_manifest'; runId: string }
  | { kind: 'run_artifact'; runId: string; artifactName: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams(`Invalid resource URI: ${uri}`);
  }

  if (url.protocol !== 'hep:') {
    throw invalidParams(`Unsupported resource protocol: ${url.protocol}`);
  }

  const host = url.host;
  const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));

  if (host === 'projects') {
    if (segments.length === 0) return { kind: 'projects_index' };
    if (segments.length === 1) return { kind: 'project', projectId: segments[0] };

    if (segments.length === 3 && segments[1] === 'artifact') {
      return { kind: 'project_artifact', projectId: segments[0], artifactName: segments[2] };
    }
    if (segments.length === 2 && segments[1] === 'papers') {
      return { kind: 'project_papers', projectId: segments[0] };
    }
    if (segments.length === 3 && segments[1] === 'papers') {
      return { kind: 'paper', projectId: segments[0], paperId: segments[2] };
    }
    if (segments.length === 5 && segments[1] === 'papers' && segments[3] === 'evidence' && segments[4] === 'catalog') {
      return { kind: 'paper_evidence_catalog', projectId: segments[0], paperId: segments[2] };
    }
  }

  if (host === 'runs') {
    if (segments.length === 0) return { kind: 'runs_index' };
    if (segments.length === 2 && segments[1] === 'manifest') {
      return { kind: 'run_manifest', runId: segments[0] };
    }
    if (segments.length === 3 && segments[1] === 'artifact') {
      return { kind: 'run_artifact', runId: segments[0], artifactName: segments[2] };
    }
  }

  throw notFound(`Unknown resource URI: ${uri}`, { uri });
}

export function listHepResources(): HepResource[] {
  return [
    {
      uri: 'hep://projects',
      name: 'hep_projects',
      title: 'HEP Projects',
      description: 'List projects on disk (local-only)',
      mimeType: 'application/json',
    },
    {
      uri: runsUri(),
      name: 'hep_runs',
      title: 'HEP Runs',
      description: 'List runs on disk (local-only)',
      mimeType: 'application/json',
    },
  ];
}

export function listHepResourceTemplates(): Array<{
  name: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
}> {
  return [
    {
      name: 'hep_project',
      uriTemplate: 'hep://projects/{project_id}',
      description: 'Read a project manifest by id. Discover ids via hep://projects.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_project_papers',
      uriTemplate: 'hep://projects/{project_id}/papers',
      description: 'List papers in a project.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_project_artifact',
      uriTemplate: 'hep://projects/{project_id}/artifact/{artifact_name}',
      description: 'Read a project artifact by name.',
    },
    {
      name: 'hep_paper',
      uriTemplate: 'hep://projects/{project_id}/papers/{paper_id}',
      description: 'Read a paper manifest by id.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_paper_evidence_catalog',
      uriTemplate: 'hep://projects/{project_id}/papers/{paper_id}/evidence/catalog',
      description: 'Read a paper evidence catalog (NDJSON).',
      mimeType: 'application/x-ndjson',
    },
    {
      name: 'hep_run_manifest',
      uriTemplate: 'hep://runs/{run_id}/manifest',
      description: 'Read a run manifest by id. Discover ids via hep://runs.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_run_artifact',
      uriTemplate: 'hep://runs/{run_id}/artifact/{artifact_name}',
      description: 'Read a run artifact by name. Discover artifact names via the run manifest.',
    },
  ];
}

export function readHepResource(uri: string): HepResourceContents {
  const parsed = parseHepUri(uri);

  if (parsed.kind === 'projects_index') {
    const projects = listProjects().map(p => ({
      project_id: p.project_id,
      name: p.name,
      description: p.description,
      created_at: p.created_at,
      updated_at: p.updated_at,
      uri: projectUri(p.project_id),
    }));

    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ projects }, null, 2),
    };
  }

  if (parsed.kind === 'runs_index') {
    const runs = listRuns().map(r => ({
      run_id: r.run_id,
      project_id: r.project_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      status: r.status,
      uri: runManifestUri(r.run_id),
      args_snapshot_uri: r.args_snapshot?.uri,
    }));

    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ runs }, null, 2),
    };
  }

  if (parsed.kind === 'project') {
    const project = getProject(parsed.projectId);
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(project, null, 2),
    };
  }

  if (parsed.kind === 'project_papers') {
    const papers = listPapers(parsed.projectId).map(p => ({
      paper_id: p.paper_id,
      updated_at: p.updated_at,
      uri: paperUri(parsed.projectId, p.paper_id),
      evidence_catalog_uri: p.artifacts?.evidence_catalog?.uri,
    }));
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ project_id: parsed.projectId, papers }, null, 2),
    };
  }

  if (parsed.kind === 'project_artifact') {
    const artifactPath = getProjectArtifactPath(parsed.projectId, parsed.artifactName);
    if (!fs.existsSync(artifactPath)) {
      throw notFound(`Project artifact not found: ${parsed.artifactName}`, {
        project_id: parsed.projectId,
        artifact_name: parsed.artifactName,
      });
    }

    const mimeType = guessMimeType(parsed.artifactName);
    const ext = path.extname(parsed.artifactName).toLowerCase();
    const isText =
      ext === '.json'
      || ext === '.jsonl'
      || ext === '.txt'
      || ext === '.md'
      || ext === '.tex'
      || ext === '.bib';

    if (isText) {
      const buf = fs.readFileSync(artifactPath);
      return { uri, mimeType, text: buf.toString('utf-8') };
    }

    const stat = fs.statSync(artifactPath);
    const metadata = {
      file_path: artifactPath,
      size: stat.size,
      sha256: sha256FileHex(artifactPath),
      mimeType: mimeType ?? 'application/octet-stream',
    };

    return { uri, mimeType: 'application/json', text: JSON.stringify(metadata, null, 2) };
  }

  if (parsed.kind === 'paper') {
    const paper = getPaper(parsed.projectId, parsed.paperId);
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(paper, null, 2),
    };
  }

  if (parsed.kind === 'paper_evidence_catalog') {
    // Ensure project exists
    getProject(parsed.projectId);
    const catalogPath = getProjectPaperEvidenceCatalogPath(parsed.projectId, parsed.paperId);
    if (!fs.existsSync(catalogPath)) {
      throw notFound('Evidence catalog not found', { project_id: parsed.projectId, paper_id: parsed.paperId });
    }
    return {
      uri,
      mimeType: 'application/x-ndjson',
      text: fs.readFileSync(catalogPath, 'utf-8'),
    };
  }

  if (parsed.kind === 'run_manifest') {
    const manifestPath = getRunManifestPath(parsed.runId);
    if (!fs.existsSync(manifestPath)) {
      throw notFound(`Run manifest not found: ${parsed.runId}`, { run_id: parsed.runId });
    }
    return {
      uri,
      mimeType: 'application/json',
      text: fs.readFileSync(manifestPath, 'utf-8'),
    };
  }

  const artifactPath = getRunArtifactPath(parsed.runId, parsed.artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw notFound(`Artifact not found: ${parsed.artifactName}`, {
      run_id: parsed.runId,
      artifact_name: parsed.artifactName,
    });
  }

  const mimeType = guessMimeType(parsed.artifactName);
  const ext = path.extname(parsed.artifactName).toLowerCase();
  const isText =
    ext === '.json'
    || ext === '.jsonl'
    || ext === '.txt'
    || ext === '.md'
    || ext === '.tex'
    || ext === '.bib';

  if (isText) {
    const buf = fs.readFileSync(artifactPath);
    return { uri, mimeType, text: buf.toString('utf-8') };
  }

  // Evidence-first: avoid embedding large binary payloads. Return metadata by default.
  const stat = fs.statSync(artifactPath);
  const metadata = {
    file_path: artifactPath,
    size: stat.size,
    sha256: sha256FileHex(artifactPath),
    mimeType: mimeType ?? 'application/octet-stream',
  };

  return { uri, mimeType: 'application/json', text: JSON.stringify(metadata, null, 2) };
}
