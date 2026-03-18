/**
 * NEW-CONN-04: Create a research run from an IdeaHandoffC2 artifact.
 *
 * Pure staging operation — no network calls, no LLM calls.
 * Reads the handoff artifact, creates project + run, writes outline_seed_v1.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  invalidParams,
  INSPIRE_SEARCH,
} from '@autoresearch/shared';
import { createProject } from '../core/projects.js';
import { createRun } from '../core/runs.js';
import { getProjectDir } from '../core/paths.js';
import { writeRunJsonArtifact } from '../core/citations.js';
import { makeHepRunManifestUri } from '../core/runArtifactUri.js';
import { HEP_PROJECT_BUILD_EVIDENCE, HEP_RUN_PLAN_COMPUTATION } from '../tool-names.js';
import { type OutlineSeedV1, resolveHandoffPath } from './idea-staging.js';

export interface CreateFromIdeaParams {
  handoff_uri: string;
  project_id?: string;
  run_label?: string;
}

export interface CreateFromIdeaResult {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  outline_seed_uri: string;
  next_actions: Array<{ tool: string; reason: string }>;
}

export function createFromIdea(params: CreateFromIdeaParams): CreateFromIdeaResult {
  const { handoff_uri, project_id: existingProjectId, run_label } = params;

  // 1. Read handoff artifact
  const handoffPath = resolveHandoffPath(handoff_uri);
  if (!fs.existsSync(handoffPath)) {
    throw invalidParams('IdeaHandoffC2 artifact not found', {
      handoff_uri,
      resolved_path: handoffPath,
    });
  }

  let handoff: Record<string, unknown>;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw invalidParams('Failed to parse IdeaHandoffC2 artifact', {
      handoff_uri,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Extract idea_card fields
  const ideaCard = handoff.idea_card as Record<string, unknown> | undefined;
  if (!ideaCard || typeof ideaCard !== 'object') {
    throw invalidParams('IdeaHandoffC2 artifact missing idea_card', { handoff_uri });
  }

  const thesis = ideaCard.thesis_statement;
  if (typeof thesis !== 'string' || thesis.length === 0) {
    throw invalidParams('idea_card.thesis_statement missing or empty', { handoff_uri });
  }

  const claims = ideaCard.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    throw invalidParams('idea_card.claims missing or empty', { handoff_uri });
  }

  const hypotheses = ideaCard.testable_hypotheses;
  if (!Array.isArray(hypotheses)) {
    throw invalidParams('idea_card.testable_hypotheses missing', { handoff_uri });
  }

  // Validate hypothesis elements are strings
  for (let i = 0; i < hypotheses.length; i++) {
    if (typeof hypotheses[i] !== 'string') {
      throw invalidParams(`idea_card.testable_hypotheses[${i}] must be a string`, { handoff_uri });
    }
  }

  // 3. Create or reuse project
  let projectId: string;
  if (existingProjectId) {
    // Validate project existence and parsability up-front → consistent invalidParams error
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

  // 4. Create run
  const { manifest } = createRun({
    project_id: projectId,
    args_snapshot: {
      source: 'create_from_idea',
      handoff_uri,
      ...(run_label ? { run_label } : {}),
    },
  });

  const runId = manifest.run_id;

  // 5. Write outline_seed_v1.json
  const outlineSeed: OutlineSeedV1 = {
    thesis,
    claims,
    hypotheses: hypotheses as string[],
    source_handoff_uri: handoff_uri,
  };

  const outlineSeedRef = writeRunJsonArtifact(runId, 'outline_seed_v1.json', outlineSeed);

  // 6. Return result with hint-only next_actions (no args — agent fills from context)
  return {
    run_id: runId,
    project_id: projectId,
    manifest_uri: makeHepRunManifestUri(runId),
    outline_seed_uri: outlineSeedRef.uri,
    next_actions: [
      {
        tool: HEP_RUN_PLAN_COMPUTATION,
        reason: 'Compile the staged outline seed into execution_plan_v1 and materialize computation/manifest.json before any approval request.',
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
