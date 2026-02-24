import * as path from 'path';
import { ensureDir, getDataDir } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import { invalidParams } from '@autoresearch/shared';

function ensureSubdir(name: string): string {
  const dataDir = getDataDir();
  const dirPath = resolvePathWithinParent(dataDir, path.join(dataDir, name), name);
  ensureDir(dirPath);
  return dirPath;
}

export function getProjectsDir(): string {
  return ensureSubdir('projects');
}

export function getRunsDir(): string {
  return ensureSubdir('runs');
}

export function assertSafePathSegment(segment: string, what: string): void {
  if (segment.length === 0) throw invalidParams(`${what} cannot be empty`);
  if (segment.includes('\0')) throw invalidParams(`${what} cannot include null byte`);
  if (segment.includes('/') || segment.includes('\\')) {
    throw invalidParams(`${what} cannot include path separators`);
  }
  if (segment === '.' || segment === '..' || segment.includes('..')) {
    throw invalidParams(`${what} contains unsafe segment`);
  }
}

export function getProjectDir(projectId: string): string {
  assertSafePathSegment(projectId, 'project_id');
  const projectsDir = getProjectsDir();
  return resolvePathWithinParent(projectsDir, path.join(projectsDir, projectId), 'project_dir');
}

export function getProjectJsonPath(projectId: string): string {
  const projectDir = getProjectDir(projectId);
  return resolvePathWithinParent(projectDir, path.join(projectDir, 'project.json'), 'project.json');
}

export function getProjectPapersDir(projectId: string): string {
  const projectDir = getProjectDir(projectId);
  const papersDir = resolvePathWithinParent(projectDir, path.join(projectDir, 'papers'), 'papers_dir');
  ensureDir(papersDir);
  return papersDir;
}

export function getProjectArtifactsDir(projectId: string): string {
  const projectDir = getProjectDir(projectId);
  const artifactsDir = resolvePathWithinParent(projectDir, path.join(projectDir, 'artifacts'), 'project_artifacts_dir');
  ensureDir(artifactsDir);
  return artifactsDir;
}

export function getProjectArtifactPath(projectId: string, artifactName: string): string {
  assertSafePathSegment(artifactName, 'artifact_name');
  const artifactsDir = getProjectArtifactsDir(projectId);
  return resolvePathWithinParent(artifactsDir, path.join(artifactsDir, artifactName), 'project_artifact_path');
}

export function getProjectPaperDir(projectId: string, paperId: string): string {
  assertSafePathSegment(paperId, 'paper_id');
  const papersDir = getProjectPapersDir(projectId);
  return resolvePathWithinParent(papersDir, path.join(papersDir, paperId), 'paper_dir');
}

export function getProjectPaperJsonPath(projectId: string, paperId: string): string {
  const paperDir = getProjectPaperDir(projectId, paperId);
  return resolvePathWithinParent(paperDir, path.join(paperDir, 'paper.json'), 'paper.json');
}

export function getProjectPaperSourcesDir(projectId: string, paperId: string): string {
  const paperDir = getProjectPaperDir(projectId, paperId);
  const sourcesDir = resolvePathWithinParent(paperDir, path.join(paperDir, 'sources'), 'paper_sources_dir');
  ensureDir(sourcesDir);
  return sourcesDir;
}

export function getProjectPaperLatexDir(projectId: string, paperId: string): string {
  const sourcesDir = getProjectPaperSourcesDir(projectId, paperId);
  const latexDir = resolvePathWithinParent(sourcesDir, path.join(sourcesDir, 'latex'), 'paper_latex_dir');
  ensureDir(latexDir);
  return latexDir;
}

export function getProjectPaperLatexExtractedDir(projectId: string, paperId: string): string {
  const latexDir = getProjectPaperLatexDir(projectId, paperId);
  const extractedDir = resolvePathWithinParent(latexDir, path.join(latexDir, 'extracted'), 'paper_latex_extracted_dir');
  ensureDir(extractedDir);
  return extractedDir;
}

export function getProjectPaperEvidenceDir(projectId: string, paperId: string): string {
  const paperDir = getProjectPaperDir(projectId, paperId);
  const evidenceDir = resolvePathWithinParent(paperDir, path.join(paperDir, 'evidence'), 'paper_evidence_dir');
  ensureDir(evidenceDir);
  return evidenceDir;
}

export function getProjectPaperEvidenceCatalogPath(projectId: string, paperId: string): string {
  const evidenceDir = getProjectPaperEvidenceDir(projectId, paperId);
  return resolvePathWithinParent(evidenceDir, path.join(evidenceDir, 'catalog.jsonl'), 'paper_evidence_catalog');
}

export function getRunDir(runId: string): string {
  assertSafePathSegment(runId, 'run_id');
  const runsDir = getRunsDir();
  return resolvePathWithinParent(runsDir, path.join(runsDir, runId), 'run_dir');
}

export function getRunManifestPath(runId: string): string {
  const runDir = getRunDir(runId);
  return resolvePathWithinParent(runDir, path.join(runDir, 'manifest.json'), 'manifest.json');
}

export function getRunArtifactsDir(runId: string): string {
  const runDir = getRunDir(runId);
  const artifactsDir = resolvePathWithinParent(runDir, path.join(runDir, 'artifacts'), 'artifacts_dir');
  ensureDir(artifactsDir);
  return artifactsDir;
}

export function getRunStagingDir(runId: string): string {
  const runDir = getRunDir(runId);
  const stagingDir = resolvePathWithinParent(runDir, path.join(runDir, 'staging'), 'staging_dir');
  ensureDir(stagingDir);
  return stagingDir;
}

export function getRunArtifactPath(runId: string, artifactName: string): string {
  assertSafePathSegment(artifactName, 'artifact_name');
  const artifactsDir = getRunArtifactsDir(runId);
  return resolvePathWithinParent(artifactsDir, path.join(artifactsDir, artifactName), 'artifact_path');
}
