import * as fs from 'fs';
import { ensureDir } from '../data/dataDir.js';
import { notFound } from '@autoresearch/shared';
import { newProjectId } from './ids.js';
import { getProjectDir, getProjectJsonPath, getProjectsDir } from './paths.js';

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
  fs.writeFileSync(getProjectJsonPath(project.project_id), JSON.stringify(project, null, 2), 'utf-8');
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
  fs.writeFileSync(getProjectJsonPath(projectId), JSON.stringify(updated, null, 2), 'utf-8');
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

