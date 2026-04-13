import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams } from '@autoresearch/shared';
import type { OutlineSeedInput, StagedIdeaHints, StagedIdeaSurface } from './execution-plan.js';
import { writeJsonAtomic } from './io.js';

export interface StagedIdeaHintsSnapshotV1 {
  version: 1;
  source_handoff_uri: string;
  hints: StagedIdeaHints | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseJsonObject(filePath: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    throw invalidParams(`Failed to parse ${label}`, {
      file_path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParams(`${label} must be a JSON object`, { file_path: filePath });
  }
  return raw as Record<string, unknown>;
}

function requireUuidField(record: Record<string, unknown>, handoffUri: string, field: 'campaign_id' | 'node_id' | 'idea_id'): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`IdeaHandoffC2 artifact missing ${field}`, { handoff_uri: handoffUri });
  }
  if (!UUID_PATTERN.test(value)) {
    throw invalidParams(`IdeaHandoffC2 artifact requires ${field} to be a UUID`, {
      handoff_uri: handoffUri,
      field,
      value,
    });
  }
  return value;
}

function requireDateTimeField(record: Record<string, unknown>, handoffUri: string, field: 'promoted_at'): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`IdeaHandoffC2 artifact missing ${field}`, { handoff_uri: handoffUri });
  }
  if (Number.isNaN(Date.parse(value))) {
    throw invalidParams(`IdeaHandoffC2 artifact requires ${field} to be an ISO date-time`, {
      handoff_uri: handoffUri,
      field,
      value,
    });
  }
  return value;
}

function parseOutlineSeed(filePath: string): OutlineSeedInput {
  const record = parseJsonObject(filePath, 'outline_seed_v1.json');
  const thesis = record.thesis;
  const claims = record.claims;
  const hypotheses = record.hypotheses;
  const sourceHandoffUri = record.source_handoff_uri;
  if (typeof thesis !== 'string' || thesis.length === 0) {
    throw invalidParams('outline_seed_v1.json missing thesis', { file_path: filePath });
  }
  if (!Array.isArray(claims) || claims.length === 0) {
    throw invalidParams('outline_seed_v1.json missing claims', { file_path: filePath });
  }
  if (!Array.isArray(hypotheses) || hypotheses.some(item => typeof item !== 'string' || item.length === 0)) {
    throw invalidParams('outline_seed_v1.json hypotheses must be a non-empty string array', { file_path: filePath });
  }
  if (typeof sourceHandoffUri !== 'string' || sourceHandoffUri.length === 0) {
    throw invalidParams('outline_seed_v1.json missing source_handoff_uri', { file_path: filePath });
  }
  return { thesis, claims, hypotheses: hypotheses as string[], source_handoff_uri: sourceHandoffUri };
}

function parseHintsSnapshot(filePath: string): StagedIdeaHintsSnapshotV1 {
  const record = parseJsonObject(filePath, 'idea_handoff_hints_v1.json');
  if (record.version !== 1) {
    throw invalidParams('idea_handoff_hints_v1.json has unsupported version', { file_path: filePath });
  }
  if (typeof record.source_handoff_uri !== 'string' || record.source_handoff_uri.length === 0) {
    throw invalidParams('idea_handoff_hints_v1.json missing source_handoff_uri', { file_path: filePath });
  }
  const hints = record.hints;
  if (hints !== null && hints !== undefined && (typeof hints !== 'object' || Array.isArray(hints))) {
    throw invalidParams('idea_handoff_hints_v1.json hints must be an object or null', { file_path: filePath });
  }
  return {
    version: 1,
    source_handoff_uri: record.source_handoff_uri,
    hints: (hints ?? null) as StagedIdeaHints | null,
  };
}

export function extractIdeaStagingHints(record: Record<string, unknown>): StagedIdeaHints | null {
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
    ...(Array.isArray(typedIdeaCard.minimal_compute_plan) ? { minimal_compute_plan: typedIdeaCard.minimal_compute_plan as StagedIdeaHints['minimal_compute_plan'] } : {}),
    ...(typedIdeaCard.method_spec && typeof typedIdeaCard.method_spec === 'object' && !Array.isArray(typedIdeaCard.method_spec)
      ? { method_spec: typedIdeaCard.method_spec as Record<string, unknown> }
      : {}),
  };
}

export function parseIdeaHandoffRecord(params: {
  handoffRecord: Record<string, unknown>;
  handoffUri: string;
}): {
  outlineSeed: OutlineSeedInput;
  hintsSnapshot: StagedIdeaHintsSnapshotV1;
} {
  const { handoffRecord, handoffUri } = params;
  requireUuidField(handoffRecord, handoffUri, 'campaign_id');
  requireUuidField(handoffRecord, handoffUri, 'node_id');
  requireUuidField(handoffRecord, handoffUri, 'idea_id');
  requireDateTimeField(handoffRecord, handoffUri, 'promoted_at');

  const groundingAudit = handoffRecord.grounding_audit;
  if (!groundingAudit || typeof groundingAudit !== 'object' || Array.isArray(groundingAudit)) {
    throw invalidParams('IdeaHandoffC2 artifact missing grounding_audit', { handoff_uri: handoffUri });
  }
  if ((groundingAudit as Record<string, unknown>).status !== 'pass') {
    throw invalidParams('IdeaHandoffC2 artifact requires grounding_audit.status=pass', { handoff_uri: handoffUri });
  }

  const reductionReport = handoffRecord.reduction_report;
  const reductionAudit = handoffRecord.reduction_audit;
  if (reductionReport !== undefined && reductionReport !== null) {
    if (!reductionAudit || typeof reductionAudit !== 'object' || Array.isArray(reductionAudit)) {
      throw invalidParams('IdeaHandoffC2 artifact requires reduction_audit when reduction_report is present', { handoff_uri: handoffUri });
    }
    if ((reductionAudit as Record<string, unknown>).status !== 'pass') {
      throw invalidParams('IdeaHandoffC2 artifact requires reduction_audit.status=pass when reduction_report is present', { handoff_uri: handoffUri });
    }
  }

  const ideaCard = handoffRecord.idea_card as Record<string, unknown> | undefined;
  if (!ideaCard || typeof ideaCard !== 'object' || Array.isArray(ideaCard)) {
    throw invalidParams('IdeaHandoffC2 artifact missing idea_card', { handoff_uri: handoffUri });
  }
  const thesis = ideaCard.thesis_statement;
  if (typeof thesis !== 'string' || thesis.length === 0) {
    throw invalidParams('idea_card.thesis_statement missing or empty', { handoff_uri: handoffUri });
  }
  const claims = ideaCard.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    throw invalidParams('idea_card.claims missing or empty', { handoff_uri: handoffUri });
  }
  const hypotheses = ideaCard.testable_hypotheses;
  if (!Array.isArray(hypotheses)) {
    throw invalidParams('idea_card.testable_hypotheses missing', { handoff_uri: handoffUri });
  }
  for (let i = 0; i < hypotheses.length; i += 1) {
    if (typeof hypotheses[i] !== 'string') {
      throw invalidParams(`idea_card.testable_hypotheses[${i}] must be a string`, { handoff_uri: handoffUri });
    }
  }

  return {
    outlineSeed: {
      thesis,
      claims,
      hypotheses: hypotheses as string[],
      source_handoff_uri: handoffUri,
    },
    hintsSnapshot: {
      version: 1,
      source_handoff_uri: handoffUri,
      hints: extractIdeaStagingHints(handoffRecord),
    },
  };
}

export function readIdeaHandoffRecord(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw invalidParams('IdeaHandoffC2 artifact not found', { handoff_path: filePath });
  }
  return parseJsonObject(filePath, 'IdeaHandoffC2 artifact');
}

export function stageIdeaArtifactsIntoRun(params: {
  handoffRecord: Record<string, unknown>;
  handoffUri: string;
  runDir: string;
}): {
  outlineSeed: OutlineSeedInput;
  hintsSnapshot: StagedIdeaHintsSnapshotV1;
  outlineSeedPath: string;
  hintsSnapshotPath: string;
} {
  const { outlineSeed, hintsSnapshot } = parseIdeaHandoffRecord({
    handoffRecord: params.handoffRecord,
    handoffUri: params.handoffUri,
  });
  const artifactsDir = path.join(params.runDir, 'artifacts');
  const outlineSeedPath = path.join(artifactsDir, 'outline_seed_v1.json');
  const hintsSnapshotPath = path.join(artifactsDir, 'idea_handoff_hints_v1.json');
  writeJsonAtomic(outlineSeedPath, outlineSeed);
  writeJsonAtomic(hintsSnapshotPath, hintsSnapshot);
  return { outlineSeed, hintsSnapshot, outlineSeedPath, hintsSnapshotPath };
}

export function stageIdeaArtifactsIntoRunFromPath(params: {
  handoffPath: string;
  handoffUri?: string;
  runDir: string;
}): {
  outlineSeed: OutlineSeedInput;
  hintsSnapshot: StagedIdeaHintsSnapshotV1;
  outlineSeedPath: string;
  hintsSnapshotPath: string;
} {
  const handoffRecord = readIdeaHandoffRecord(params.handoffPath);
  return stageIdeaArtifactsIntoRun({
    handoffRecord,
    handoffUri: params.handoffUri ?? params.handoffPath,
    runDir: params.runDir,
  });
}

export function loadStagedIdeaSurfaceFromRunDir(runDir: string): StagedIdeaSurface {
  const outlineSeedPath = path.join(runDir, 'artifacts', 'outline_seed_v1.json');
  if (!fs.existsSync(outlineSeedPath)) {
    throw invalidParams('outline_seed_v1.json missing for run', {
      run_dir: runDir,
      expected_path: outlineSeedPath,
    });
  }
  const hintsSnapshotPath = path.join(runDir, 'artifacts', 'idea_handoff_hints_v1.json');
  if (!fs.existsSync(hintsSnapshotPath)) {
    throw invalidParams('idea_handoff_hints_v1.json missing for run', {
      run_dir: runDir,
      expected_path: hintsSnapshotPath,
    });
  }
  const outlineSeed = parseOutlineSeed(outlineSeedPath);
  const hintsSnapshot = parseHintsSnapshot(hintsSnapshotPath);
  if (hintsSnapshot.source_handoff_uri !== outlineSeed.source_handoff_uri) {
    throw invalidParams('idea_handoff_hints_v1.json source_handoff_uri does not match outline_seed_v1.json provenance', {
      run_dir: runDir,
      hints_snapshot_path: hintsSnapshotPath,
      snapshot_source_handoff_uri: hintsSnapshot.source_handoff_uri,
      outline_source_handoff_uri: outlineSeed.source_handoff_uri,
    });
  }
  return {
    outline_seed_path: path.relative(runDir, outlineSeedPath).split(path.sep).join('/'),
    outline: outlineSeed,
    hints: hintsSnapshot.hints,
  };
}
