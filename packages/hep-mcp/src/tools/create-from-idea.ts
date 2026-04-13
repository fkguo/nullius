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
  ORCH_RUN_CREATE,
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

function buildHepProviderRunnerContent(): string {
  return [
    'import argparse',
    'import json',
    'from datetime import datetime, timezone',
    'from pathlib import Path',
    '',
    '',
    'def now_iso() -> str:',
    "    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')",
    '',
    "parser = argparse.ArgumentParser(description='HEP provider-backed execution runner')",
    "parser.add_argument('--task-id', required=True)",
    "parser.add_argument('--execution-plan', required=True)",
    'args = parser.parse_args()',
    '',
    "execution_plan = json.loads(Path(args.execution_plan).read_text(encoding='utf-8'))",
    "hints_path = Path('../artifacts/idea_handoff_hints_v1.json')",
    "hints_doc = json.loads(hints_path.read_text(encoding='utf-8')) if hints_path.exists() else {'hints': None}",
    "task = next((item for item in execution_plan.get('tasks', []) if item.get('task_id') == args.task_id), None)",
    'if task is None:',
    "    raise SystemExit(f'Unknown task id: {args.task_id}')",
    '',
    "hints = hints_doc.get('hints') or {}",
    'base_payload = {',
    "    'schema_version': 1,",
    "    'provider': 'hep-mcp',",
    "    'run_id': execution_plan.get('run_id'),",
    "    'task_id': task.get('task_id'),",
    "    'title': task.get('title'),",
    "    'description': task.get('description'),",
    "    'status': 'completed',",
    "    'summary': f\"HEP provider-backed execution completed for {task.get('task_id')}.\",",
    "    'objective': execution_plan.get('objective'),",
    "    'source': execution_plan.get('source'),",
    "    'required_observables': hints.get('required_observables', []),",
    "    'candidate_formalisms': hints.get('candidate_formalisms', []),",
    "    'produced_at': now_iso(),",
    '}',
    '',
    "for artifact in task.get('expected_artifacts', []):",
    "    output_path = Path(artifact['path'])",
    '    output_path.parent.mkdir(parents=True, exist_ok=True)',
    '    payload = {',
    '        **base_payload,',
    "        'artifact_id': artifact.get('artifact_id'),",
    "        'artifact_kind': artifact.get('kind'),",
    "        'artifact_path': artifact.get('path'),",
    '    }',
    "    output_path.write_text(json.dumps(payload, indent=2) + '\\n', encoding='utf-8')",
    '',
  ].join('\n');
}

function buildHepMethodSpecFromIdeaCard(ideaCard: Record<string, unknown>, thesis: string): Record<string, unknown> {
  const minimalComputePlan = Array.isArray(ideaCard.minimal_compute_plan)
    ? ideaCard.minimal_compute_plan as Array<Record<string, unknown>>
    : [];
  const hypotheses = Array.isArray(ideaCard.testable_hypotheses)
    ? ideaCard.testable_hypotheses as string[]
    : [];
  const count = minimalComputePlan.length > 0 ? minimalComputePlan.length : Math.max(1, hypotheses.length);
  const phases = Array.from({ length: count }, (_, index) => {
    const phaseId = `task_${String(index + 1).padStart(3, '0')}`;
    const hint = minimalComputePlan[index];
    const description = typeof hint?.step === 'string' && hint.step.length > 0
      ? hint.step
      : `Evaluate hypothesis ${index + 1}`;
    return {
      phase_id: phaseId,
      description,
      backend: {
        kind: 'shell',
        argv: ['python3', 'scripts/hep_provider_runner.py', '--task-id', phaseId, '--execution-plan', 'execution_plan_v1.json'],
        cwd: '.',
        timeout_seconds: 300 + index * 60,
      },
      outputs: [`outputs/${phaseId}.json`],
    };
  });
  return {
    provider: 'hep-mcp',
    files: [{
      path: 'scripts/hep_provider_runner.py',
      executable: false,
      content: buildHepProviderRunnerContent(),
    }],
    run_card: {
      schema_version: 2,
      workflow_id: 'computation',
      title: `HEP provider-backed execution for ${thesis}`,
      description: 'First-provider execution bundle synthesized by create_from_idea for the single-user capability lane.',
      phases,
    },
  };
}

function withHepProviderMethodSpec(handoffRecord: Record<string, unknown>, thesis: string): Record<string, unknown> {
  const cloned = structuredClone(handoffRecord) as Record<string, unknown>;
  const ideaCard = cloned.idea_card;
  if (!ideaCard || typeof ideaCard !== 'object' || Array.isArray(ideaCard)) {
    return cloned;
  }
  const typedIdeaCard = ideaCard as Record<string, unknown>;
  if (typedIdeaCard.method_spec && typeof typedIdeaCard.method_spec === 'object' && !Array.isArray(typedIdeaCard.method_spec)) {
    return cloned;
  }
  typedIdeaCard.method_spec = buildHepMethodSpecFromIdeaCard(typedIdeaCard, thesis);
  return cloned;
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
  const stagedHandoffRecord = withHepProviderMethodSpec(handoffRecord, thesis);

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
    handoffRecord: stagedHandoffRecord,
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
        tool: ORCH_RUN_CREATE,
        reason: 'Register the returned run_id under your chosen orchestrator project_root before planning or execution; this initializes the generic run-state authority that orch_run_plan_computation and orch_run_execute_manifest consume.',
      },
      {
        tool: ORCH_RUN_PLAN_COMPUTATION,
        reason: 'After orch_run_create, use the generic orchestrator planning entry with this run_id, returned run_dir, and your chosen orchestrator project_root to compile execution_plan_v1 and materialize a provider-backed computation/manifest.json before any approval request.',
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
