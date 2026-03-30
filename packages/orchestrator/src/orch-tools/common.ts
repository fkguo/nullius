import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  APPROVAL_GATE_IDS,
  isApprovalGateId,
  notFound,
  type ApprovalGateId,
} from '@autoresearch/shared';
import { StateManager } from '../state-manager.js';

export type ApprovalGateFilter = ApprovalGateId | 'A0' | 'all';

export function isApprovalGateFilter(value: string): value is ApprovalGateFilter {
  return value === 'A0' || value === 'all' || isApprovalGateId(value);
}

export const APPROVAL_GATE_FILTER_VALUES = [
  'A0',
  ...APPROVAL_GATE_IDS,
  'all',
] as const satisfies readonly ApprovalGateFilter[];

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
