import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { invalidParams, notFound } from '@autoresearch/shared';
import { getDataDir } from '../data/dataDir.js';
import { getProject, listProjects } from './projects.js';
import { listRuns } from './runs.js';
import { getProjectArtifactPath, getProjectPaperEvidenceCatalogPath, getRunArtifactPath, getRunManifestPath } from './paths.js';
import { getPaper, listPapers } from './papers.js';
import { assertSafeArtifactName, assertSafeStyleId } from '../corpora/style/paths.js';

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

function corporaUri(): string {
  return 'hep://corpora';
}

function corpusUri(styleId: string): string {
  return `hep://corpora/${encodeURIComponent(styleId)}`;
}

function corpusProfileUri(styleId: string): string {
  return `${corpusUri(styleId)}/profile`;
}

function corpusManifestUri(styleId: string): string {
  return `${corpusUri(styleId)}/manifest`;
}

function corpusIndexMetaUri(styleId: string): string {
  return `${corpusUri(styleId)}/index/meta`;
}

function corpusArtifactUri(styleId: string, artifactName: string): string {
  return `${corpusUri(styleId)}/artifact/${encodeURIComponent(artifactName)}`;
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
  | { kind: 'run_artifact'; runId: string; artifactName: string }
  | { kind: 'corpora_index' }
  | { kind: 'corpus'; styleId: string }
  | { kind: 'corpus_profile'; styleId: string }
  | { kind: 'corpus_manifest'; styleId: string }
  | { kind: 'corpus_index_meta'; styleId: string }
  | { kind: 'corpus_artifact'; styleId: string; artifactName: string } {
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

  if (host === 'corpora') {
    if (segments.length === 0) return { kind: 'corpora_index' };
    if (segments.length === 1) return { kind: 'corpus', styleId: segments[0] };
    if (segments.length === 2 && segments[1] === 'profile') return { kind: 'corpus_profile', styleId: segments[0] };
    if (segments.length === 2 && segments[1] === 'manifest') return { kind: 'corpus_manifest', styleId: segments[0] };
    if (segments.length === 3 && segments[1] === 'index' && segments[2] === 'meta') {
      return { kind: 'corpus_index_meta', styleId: segments[0] };
    }
    if (segments.length === 3 && segments[1] === 'artifact') {
      return { kind: 'corpus_artifact', styleId: segments[0], artifactName: segments[2] };
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
    {
      uri: corporaUri(),
      name: 'hep_corpora',
      title: 'Style Corpora',
      description: 'List style corpora on disk (local-only)',
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
    {
      name: 'hep_corpus',
      uriTemplate: 'hep://corpora/{style_id}',
      description: 'Read a style corpus overview. Discover style ids via hep://corpora.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_corpus_profile',
      uriTemplate: 'hep://corpora/{style_id}/profile',
      description: 'Read a style corpus profile.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_corpus_manifest',
      uriTemplate: 'hep://corpora/{style_id}/manifest',
      description: 'Read a style corpus manifest (NDJSON).',
      mimeType: 'application/x-ndjson',
    },
    {
      name: 'hep_corpus_index_meta',
      uriTemplate: 'hep://corpora/{style_id}/index/meta',
      description: 'Read a style corpus index metadata JSON.',
      mimeType: 'application/json',
    },
    {
      name: 'hep_corpus_artifact',
      uriTemplate: 'hep://corpora/{style_id}/artifact/{artifact_name}',
      description: 'Read a style corpus artifact by name.',
    },
  ];
}

export function readHepResource(uri: string): HepResourceContents {
  const parsed = parseHepUri(uri);

  if (parsed.kind === 'corpora_index') {
    const dataDir = getDataDir();
    const corporaDir = path.join(dataDir, 'corpora');
    const corpora: Array<{
      style_id: string;
      uri: string;
      profile_uri: string;
      manifest_uri: string;
      index_meta_uri: string;
    }> = [];

    if (fs.existsSync(corporaDir) && fs.statSync(corporaDir).isDirectory()) {
      const dirs = fs.readdirSync(corporaDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        corpora.push({
          style_id: d.name,
          uri: corpusUri(d.name),
          profile_uri: corpusProfileUri(d.name),
          manifest_uri: corpusManifestUri(d.name),
          index_meta_uri: corpusIndexMetaUri(d.name),
        });
      }
    }

    corpora.sort((a, b) => a.style_id.localeCompare(b.style_id));
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ corpora }, null, 2),
    };
  }

  if (
    parsed.kind === 'corpus'
    || parsed.kind === 'corpus_profile'
    || parsed.kind === 'corpus_manifest'
    || parsed.kind === 'corpus_index_meta'
    || parsed.kind === 'corpus_artifact'
  ) {
    const styleId = parsed.styleId;
    assertSafeStyleId(styleId);

    const dataDir = getDataDir();
    const corporaDir = path.join(dataDir, 'corpora');
    const corpusDir = path.join(corporaDir, styleId);
    if (!fs.existsSync(corpusDir) || !fs.statSync(corpusDir).isDirectory()) {
      throw notFound('Style corpus not found', { style_id: styleId, path: corpusDir });
    }

    if (parsed.kind === 'corpus') {
      const profilePath = path.join(corpusDir, 'profile.json');
      const manifestPath = path.join(corpusDir, 'manifest.jsonl');
      const indexMetaPath = path.join(corpusDir, 'index', 'style_index_meta.json');
      const artifactsDir = path.join(corpusDir, 'artifacts');

      const artifacts: Array<{ name: string; uri: string; mimeType?: string }> = [];
      if (fs.existsSync(artifactsDir) && fs.statSync(artifactsDir).isDirectory()) {
        const names = fs
          .readdirSync(artifactsDir, { withFileTypes: true })
          .filter(d => d.isFile())
          .map(d => d.name)
          .sort((a, b) => a.localeCompare(b));
        for (const name of names) {
          artifacts.push({
            name,
            uri: corpusArtifactUri(styleId, name),
            mimeType: guessMimeType(name),
          });
        }
      }

      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          style_id: styleId,
          dir_path: corpusDir,
          profile: {
            exists: fs.existsSync(profilePath),
            uri: corpusProfileUri(styleId),
          },
          manifest: {
            exists: fs.existsSync(manifestPath),
            uri: corpusManifestUri(styleId),
          },
          index: {
            meta_exists: fs.existsSync(indexMetaPath),
            meta_uri: corpusIndexMetaUri(styleId),
          },
          artifacts,
        }, null, 2),
      };
    }

    if (parsed.kind === 'corpus_profile') {
      const profilePath = path.join(corpusDir, 'profile.json');
      if (!fs.existsSync(profilePath)) {
        throw notFound('Style profile not found', { style_id: styleId, path: profilePath });
      }
      return { uri, mimeType: 'application/json', text: fs.readFileSync(profilePath, 'utf-8') };
    }

    if (parsed.kind === 'corpus_manifest') {
      const manifestPath = path.join(corpusDir, 'manifest.jsonl');
      if (!fs.existsSync(manifestPath)) {
        throw notFound('Style corpus manifest not found', { style_id: styleId, path: manifestPath });
      }
      return { uri, mimeType: 'application/x-ndjson', text: fs.readFileSync(manifestPath, 'utf-8') };
    }

    if (parsed.kind === 'corpus_index_meta') {
      const indexMetaPath = path.join(corpusDir, 'index', 'style_index_meta.json');
      if (!fs.existsSync(indexMetaPath)) {
        throw notFound('Style corpus index meta not found', { style_id: styleId, path: indexMetaPath });
      }
      return { uri, mimeType: 'application/json', text: fs.readFileSync(indexMetaPath, 'utf-8') };
    }

    // corpus_artifact
    assertSafeArtifactName(parsed.artifactName);
    const artifactPath = path.join(corpusDir, 'artifacts', parsed.artifactName);
    if (!fs.existsSync(artifactPath)) {
      throw notFound('Style corpus artifact not found', {
        style_id: styleId,
        artifact_name: parsed.artifactName,
        path: artifactPath,
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
      return { uri, mimeType, text: fs.readFileSync(artifactPath, 'utf-8') };
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
