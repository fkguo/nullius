import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComputationResultV1 } from '@autoresearch/shared';
import { makeRunArtifactUri } from './artifact-refs.js';
import { writeJsonAtomic } from './io.js';
import { loadStagedIdeaSurfaceFromRunDir } from './staged-idea-artifacts.js';
import type { PreparedManifest } from './types.js';

const PENDING_FEEDBACK_DIR = 'computation_feedback_pending';

function stagedIdeaSurfaceExists(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, 'artifacts', 'outline_seed_v1.json'))
    && fs.existsSync(path.join(runDir, 'artifacts', 'idea_handoff_hints_v1.json'));
}

function resolveLocalPath(sourceHandoffUri: string): string | null {
  if (!sourceHandoffUri) return null;
  if (sourceHandoffUri.startsWith('file://')) {
    return path.resolve(fileURLToPath(sourceHandoffUri));
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(sourceHandoffUri)) {
    return null;
  }
  return path.resolve(sourceHandoffUri);
}

function resolveIdeaEngineCampaignDir(sourceHandoffUri: string, campaignId: string): string | null {
  const handoffPath = resolveLocalPath(sourceHandoffUri);
  if (!handoffPath) return null;
  const campaignDir = path.dirname(path.dirname(path.dirname(handoffPath)));
  const expectedHandoffDir = path.join(campaignDir, 'artifacts', 'handoff');
  if (path.basename(campaignDir) !== campaignId || path.basename(path.dirname(campaignDir)) !== 'campaigns') {
    return null;
  }
  if (path.dirname(handoffPath) !== expectedHandoffDir) {
    return null;
  }
  return campaignDir;
}

export function maybeQueueIdeaEngineComputationFeedback(params: {
  prepared: PreparedManifest;
  computationResult: ComputationResultV1;
}): { campaignDir: string; pendingPath: string } | null {
  if (!stagedIdeaSurfaceExists(params.prepared.runDir)) {
    return null;
  }

  const stagedIdea = loadStagedIdeaSurfaceFromRunDir(params.prepared.runDir);
  const hints = stagedIdea.hints;
  if (!hints?.campaign_id || !hints.node_id || !hints.idea_id) {
    return null;
  }

  const campaignDir = resolveIdeaEngineCampaignDir(stagedIdea.outline.source_handoff_uri, String(hints.campaign_id));
  if (!campaignDir) {
    return null;
  }
  if (!fs.existsSync(campaignDir)) {
    throw new Error(`idea-engine campaign directory is missing for staged handoff campaign ${String(hints.campaign_id)}`);
  }

  const pendingPath = path.join(campaignDir, 'artifacts', PENDING_FEEDBACK_DIR, `${params.prepared.runId}.json`);
  writeJsonAtomic(pendingPath, {
    schema_version: 1,
    generated_at: params.computationResult.finished_at,
    run_id: params.prepared.runId,
    campaign_id: String(hints.campaign_id),
    node_id: String(hints.node_id),
    idea_id: String(hints.idea_id),
    source_handoff_uri: stagedIdea.outline.source_handoff_uri,
    computation_result_uri: makeRunArtifactUri(params.prepared.runId, 'artifacts/computation_result_v1.json'),
    manifest_ref_uri: params.computationResult.manifest_ref.uri,
    produced_artifact_uris: params.computationResult.produced_artifact_refs.map(ref => ref.uri),
    execution_status: params.computationResult.execution_status,
    feedback_signal: params.computationResult.feedback_lowering.signal,
    decision_kind: params.computationResult.feedback_lowering.decision_kind,
    priority_change: params.computationResult.feedback_lowering.priority_change,
    prune_candidate: params.computationResult.feedback_lowering.prune_candidate,
    objective_title: params.computationResult.objective_title,
    summary: params.computationResult.summary,
    failure_reason: params.computationResult.failure_reason ?? null,
    finished_at: params.computationResult.finished_at,
    executor_step_ids: [...params.computationResult.executor_provenance.step_ids],
  });

  return {
    campaignDir,
    pendingPath,
  };
}
