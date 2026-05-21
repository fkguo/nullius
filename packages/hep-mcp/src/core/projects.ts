import * as fs from 'fs';
import { ensureDir } from '../data/dataDir.js';
import { notFound, writeJsonAtomicDurable } from '@autoresearch/shared';
import { newProjectId } from './ids.js';
import { getProjectDir, getProjectJsonPath, getProjectsDir } from './paths.js';

// hep-mcp project/paper JSON convention: no trailing newline (legacy). The
// default writeJsonAtomicDurable stringify adds '\n' — pass an explicit
// stringify to preserve byte-for-byte parity with the existing on-disk
// format and any external readers that compare bytes.
const stringifyNoTrailingNewline = (payload: unknown): string =>
  JSON.stringify(payload, null, 2);

export interface HepProject {
  project_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export function createProject(params: { name: string; description?: string }): HepProject {
  const now = new Date().toISOString();
  const project: HepProject = {
    project_id: newProjectId(),
    name: params.name,
    description: params.description,
    created_at: now,
    updated_at: now,
  };

  const projectDir = getProjectDir(project.project_id);
  ensureDir(projectDir);
  writeJsonAtomicDurable(
    getProjectJsonPath(project.project_id),
    project,
    stringifyNoTrailingNewline,
  );
  return project;
}

export function getProject(projectId: string): HepProject {
  const projectPath = getProjectJsonPath(projectId);
  if (!fs.existsSync(projectPath)) {
    throw notFound(`Project not found: ${projectId}`, { project_id: projectId });
  }
  return JSON.parse(fs.readFileSync(projectPath, 'utf-8')) as HepProject;
}

export function updateProjectUpdatedAt(projectId: string): HepProject {
  const project = getProject(projectId);
  const updated: HepProject = { ...project, updated_at: new Date().toISOString() };
  writeJsonAtomicDurable(
    getProjectJsonPath(projectId),
    updated,
    stringifyNoTrailingNewline,
  );
  return updated;
}

export function listProjects(): HepProject[] {
  const dir = getProjectsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const projects: HepProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    try {
      projects.push(getProject(projectId));
    } catch {
      // Skip unreadable entries
    }
  }

  projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return projects;
}

