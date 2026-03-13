import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, McpError } from '@autoresearch/shared';
import { getRunDir } from '../core/paths.js';
import { parseHepRunArtifactUriOrThrow } from '../core/runArtifactUri.js';
import { getDataDir } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';

export interface OutlineSeedV1 {
  thesis: string;
  claims: unknown[];
  hypotheses: string[];
  source_handoff_uri: string;
}

export interface IdeaStagingHints {
  campaign_id?: string;
  node_id?: string;
  idea_id?: string;
  promoted_at?: string;
  required_observables?: string[];
  candidate_formalisms?: string[];
  minimal_compute_plan?: Array<{
    step: string;
    method: string;
    estimated_difficulty: string;
    estimate_confidence?: string;
    estimated_compute_hours_log10?: number;
    required_infrastructure?: string;
    blockers?: string[];
    tool_hint?: string;
  }>;
}

export interface StagedIdeaSurface {
  outlineSeedPath: string;
  outlineSeed: OutlineSeedV1;
  hints: IdeaStagingHints | null;
}

export function resolveHandoffPath(handoffUri: string): string {
  if (handoffUri.startsWith('hep://')) {
    const { runId, artifactName } = parseHepRunArtifactUriOrThrow(handoffUri);
    return path.join(getRunDir(runId), 'artifacts', artifactName);
  }
  try {
    return resolvePathWithinParent(getDataDir(), handoffUri, 'handoff_uri');
  } catch (err) {
    if (err instanceof McpError) throw invalidParams(err.message, err.data);
    throw err;
  }
}

function parseJsonObject(filePath: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidParams(`${label} must be a JSON object`, { file_path: filePath });
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw invalidParams(`Failed to parse ${label}`, {
      file_path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseOutlineSeed(filePath: string): OutlineSeedV1 {
  const record = parseJsonObject(filePath, 'outline_seed_v1.json');
  const thesis = record.thesis;
  const claims = record.claims;
  const hypotheses = record.hypotheses;
  const sourceHandoffUri = record.source_handoff_uri;
  if (typeof thesis !== 'string' || thesis.length === 0) throw invalidParams('outline_seed_v1.json missing thesis', { file_path: filePath });
  if (!Array.isArray(claims) || claims.length === 0) throw invalidParams('outline_seed_v1.json missing claims', { file_path: filePath });
  if (!Array.isArray(hypotheses) || hypotheses.some(item => typeof item !== 'string')) {
    throw invalidParams('outline_seed_v1.json hypotheses must be an array of strings', { file_path: filePath });
  }
  if (typeof sourceHandoffUri !== 'string' || sourceHandoffUri.length === 0) {
    throw invalidParams('outline_seed_v1.json missing source_handoff_uri', { file_path: filePath });
  }
  return { thesis, claims, hypotheses: hypotheses as string[], source_handoff_uri: sourceHandoffUri };
}

function extractHints(record: Record<string, unknown>): IdeaStagingHints | null {
  const ideaCard = record.idea_card;
  if (!ideaCard || typeof ideaCard !== 'object' || Array.isArray(ideaCard)) return null;
  const typedIdeaCard = ideaCard as Record<string, unknown>;
  return {
    ...(typeof record.campaign_id === 'string' ? { campaign_id: record.campaign_id } : {}),
    ...(typeof record.node_id === 'string' ? { node_id: record.node_id } : {}),
    ...(typeof record.idea_id === 'string' ? { idea_id: record.idea_id } : {}),
    ...(typeof record.promoted_at === 'string' ? { promoted_at: record.promoted_at } : {}),
    ...(Array.isArray(typedIdeaCard.required_observables) ? { required_observables: typedIdeaCard.required_observables as string[] } : {}),
    ...(Array.isArray(typedIdeaCard.candidate_formalisms) ? { candidate_formalisms: typedIdeaCard.candidate_formalisms as string[] } : {}),
    ...(Array.isArray(typedIdeaCard.minimal_compute_plan) ? { minimal_compute_plan: typedIdeaCard.minimal_compute_plan as IdeaStagingHints['minimal_compute_plan'] } : {}),
  };
}

export function loadStagedIdeaSurface(runId: string): StagedIdeaSurface {
  const outlineSeedPath = path.join(getRunDir(runId), 'artifacts', 'outline_seed_v1.json');
  if (!fs.existsSync(outlineSeedPath)) {
    throw invalidParams('outline_seed_v1.json not found for run', {
      run_id: runId,
      outline_seed_path: outlineSeedPath,
      next_actions: [{ tool: 'hep_run_create_from_idea', reason: 'Create or re-stage the run from an IdeaHandoffC2 artifact first.' }],
    });
  }
  const outlineSeed = parseOutlineSeed(outlineSeedPath);
  const sourcePath = resolveHandoffPath(outlineSeed.source_handoff_uri);
  const hints = fs.existsSync(sourcePath) ? extractHints(parseJsonObject(sourcePath, 'IdeaHandoffC2 artifact')) : null;
  return { outlineSeedPath, outlineSeed, hints };
}
