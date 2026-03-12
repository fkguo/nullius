import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../src/state-manager.js';

export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execute-manifest-core-'));
}

export function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

export function initRunState(projectRoot: string, runId: string): StateManager {
  const manager = new StateManager(projectRoot);
  const state = manager.readState();
  manager.createRun(state, runId, 'computation');
  return manager;
}

export function markA3Satisfied(manager: StateManager, approvalId: string): void {
  const state = manager.readState();
  state.gate_satisfied.A3 = approvalId;
  manager.saveState(state);
}

export function createManifest(runDir: string, manifest: Record<string, unknown>): string {
  const manifestPath = path.join(runDir, 'computation', 'manifest.json');
  writeJson(manifestPath, manifest);
  return manifestPath;
}

export function createPythonStep(runDir: string, relativeScriptPath: string, body: string): void {
  const scriptPath = path.join(runDir, 'computation', relativeScriptPath);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, body, 'utf-8');
}

export function extractArtifactPaths(
  result: Awaited<ReturnType<typeof import('../src/computation/index.js').executeComputationManifest>>,
): { execution_status: string; logs_dir: string } | null {
  if (result.status === 'completed' || result.status === 'failed') {
    return result.artifact_paths;
  }
  return null;
}

const cleanupDirs: string[] = [];

export function registerCleanup(dirPath: string): void {
  cleanupDirs.push(dirPath);
}

export function cleanupRegisteredDirs(): void {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
}
