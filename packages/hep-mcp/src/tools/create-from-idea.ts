/**
 * NEW-CONN-04: Create a research run from an IdeaHandoffC2 artifact.
 *
 * Pure staging operation — no network calls, no LLM calls.
 * Reads the handoff artifact, creates project + run, writes outline_seed_v1.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  INSPIRE_SEARCH,
  ORCH_RUN_PLAN_COMPUTATION,
  invalidParams,
} from '@autoresearch/shared';
import {
  parseIdeaHandoffRecord,
  readIdeaHandoffRecord,
  stageIdeaArtifactsIntoRun,
} from '@autoresearch/orchestrator';
import { createProject } from '../core/projects.js';
import { createRun } from '../core/runs.js';
import { getProjectDir, getRunDir } from '../core/paths.js';
import { makeHepRunArtifactUri, makeHepRunManifestUri } from '../core/runArtifactUri.js';
import { HEP_PROJECT_BUILD_EVIDENCE } from '../tool-names.js';
import { resolveHandoffPath } from './idea-staging.js';

export interface CreateFromIdeaParams {
  handoff_uri: string;
  project_id?: string;
  run_label?: string;
}

export interface CreateFromIdeaResult {
  run_id: string;
  run_dir: string;
  project_id: string;
  manifest_uri: string;
  outline_seed_uri: string;
  next_actions: Array<{ tool: string; reason: string }>;
}

export function createFromIdea(params: CreateFromIdeaParams): CreateFromIdeaResult {
  const { handoff_uri, project_id: existingProjectId, run_label } = params;

  // Validate the generic handoff contract before creating any local state.
  const handoffPath = resolveHandoffPath(handoff_uri);
  const handoffRecord = readIdeaHandoffRecord(handoffPath);
  const { outlineSeed } = parseIdeaHandoffRecord({
    handoffRecord,
    handoffUri: handoff_uri,
  });
  const thesis = outlineSeed.thesis;

  // Create or reuse project only after the generic parse succeeds.
  let projectId: string;
  if (existingProjectId) {
    const projectDir = getProjectDir(existingProjectId);
    const projectJsonPath = path.join(projectDir, 'project.json');
    if (!fs.existsSync(projectJsonPath)) {
      throw invalidParams('project_id not found', { project_id: existingProjectId });
    }
    try {
      JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    } catch (err) {
      throw invalidParams('project.json is malformed', {
        project_id: existingProjectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    projectId = existingProjectId;
  } else {
    const projectTitle = thesis.length > 80 ? thesis.slice(0, 80) + '…' : thesis;
    const project = createProject({ name: projectTitle });
    projectId = project.project_id;
  }

  const { manifest } = createRun({
    project_id: projectId,
    args_snapshot: {
      source: 'create_from_idea',
      handoff_uri,
      ...(run_label ? { run_label } : {}),
    },
  });

  const runId = manifest.run_id;
  const runDir = getRunDir(runId);

  // Reuse the already validated handoff record; HEP only owns local project/run placement.
  stageIdeaArtifactsIntoRun({
    handoffRecord,
    handoffUri: handoff_uri,
    runDir,
  });

  return {
    run_id: runId,
    run_dir: runDir,
    project_id: projectId,
    manifest_uri: makeHepRunManifestUri(runId),
    outline_seed_uri: makeHepRunArtifactUri(runId, 'outline_seed_v1.json'),
    next_actions: [
      {
        tool: ORCH_RUN_PLAN_COMPUTATION,
        reason: 'Preferred next step: use the generic orchestrator planning entry with this run_id, returned run_dir, and your chosen orchestrator project_root to compile execution_plan_v1 and materialize computation/manifest.json before any approval request.',
      },
      {
        tool: INSPIRE_SEARCH,
        reason: 'Search related literature using the thesis statement as query.',
      },
      {
        tool: HEP_PROJECT_BUILD_EVIDENCE,
        reason: 'Build evidence catalog after importing papers into the project.',
      },
    ],
  };
}
