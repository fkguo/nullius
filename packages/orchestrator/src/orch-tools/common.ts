import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { notFound } from '@autoresearch/shared';
import { StateManager } from '../state-manager.js';

export const POLICY_KEYS: Record<string, string> = {
  A1: 'mass_search',
  A2: 'code_changes',
  A3: 'compute_runs',
  A4: 'paper_edits',
  A5: 'final_conclusions',
};

export const DEFAULT_APPROVAL_REQUIRED: Record<string, boolean> = {
  mass_search: true,
  code_changes: true,
  compute_runs: true,
  paper_edits: true,
  final_conclusions: true,
};

export function expandTilde(rawPath: string): string {
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export function resolveProjectRoot(rawProjectRoot: string): string {
  return path.resolve(expandTilde(rawProjectRoot.trim()));
}

export function pauseFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.pause');
}

export function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function createStateManager(rawProjectRoot: string): {
  manager: StateManager;
  projectRoot: string;
} {
  const projectRoot = resolveProjectRoot(rawProjectRoot);
  return { manager: new StateManager(projectRoot), projectRoot };
}

export function requireState(projectRoot: string, manager: StateManager) {
  if (!fs.existsSync(manager.statePath)) {
    throw notFound(`No orchestrator state found at ${manager.statePath}. Run orch_run_create first.`, {
      project_root: projectRoot,
    });
  }
  return manager.readState();
}
