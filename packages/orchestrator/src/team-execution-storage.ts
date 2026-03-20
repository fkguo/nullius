import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TeamExecutionState } from './team-execution-types.js';

function stateDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, 'artifacts', 'runs', runId);
}

export function teamExecutionStatePath(projectRoot: string, runId: string): string {
  return path.join(stateDir(projectRoot, runId), 'team-execution-state.json');
}

function writeJsonAtomic(filePath: string, payload: TeamExecutionState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  const content = JSON.stringify(payload, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

export class TeamExecutionStateManager {
  constructor(private readonly projectRoot: string) {}

  pathFor(runId: string): string {
    return teamExecutionStatePath(this.projectRoot, runId);
  }

  load(runId: string): TeamExecutionState | null {
    const filePath = this.pathFor(runId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TeamExecutionState;
  }

  save(state: TeamExecutionState): void {
    writeJsonAtomic(this.pathFor(state.run_id), state);
  }
}
