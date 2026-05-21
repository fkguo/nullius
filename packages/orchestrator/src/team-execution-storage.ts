import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomicDurable } from '@autoresearch/shared';
import {
  normalizeResearchTaskExecutionRefRegistry,
  type ResearchTaskExecutionRefRegistry,
} from './research-task-execution-ref.js';
import type { TeamExecutionState } from './team-execution-types.js';

function stateDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, 'artifacts', 'runs', runId);
}

export function teamExecutionStatePath(projectRoot: string, runId: string): string {
  return path.join(stateDir(projectRoot, runId), 'team-execution-state.json');
}

export function teamExecutionTaskRefRegistryPath(projectRoot: string, runId: string): string {
  return path.join(stateDir(projectRoot, runId), 'team-execution-task-refs.json');
}

export class TeamExecutionStateManager {
  constructor(private readonly projectRoot: string) {}

  pathFor(runId: string): string {
    return teamExecutionStatePath(this.projectRoot, runId);
  }

  taskRefPathFor(runId: string): string {
    return teamExecutionTaskRefRegistryPath(this.projectRoot, runId);
  }

  load(runId: string): TeamExecutionState | null {
    const filePath = this.pathFor(runId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TeamExecutionState;
  }

  loadTaskRefRegistry(runId: string): ResearchTaskExecutionRefRegistry | null {
    const filePath = this.taskRefPathFor(runId);
    if (!fs.existsSync(filePath)) return null;
    return normalizeResearchTaskExecutionRefRegistry(
      runId,
      JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown,
    );
  }

  save(state: TeamExecutionState): void {
    writeJsonAtomicDurable(this.pathFor(state.run_id), state);
  }

  saveTaskRefRegistry(registry: ResearchTaskExecutionRefRegistry): void {
    writeJsonAtomicDurable(this.taskRefPathFor(registry.run_id), registry);
  }
}
