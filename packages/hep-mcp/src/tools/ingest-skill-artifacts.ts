import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { invalidParams } from '@autoresearch/shared';
import type { ComputationEvidenceCatalogItemV1 } from '@autoresearch/shared';
import { getRunDir } from '../core/paths.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import { getRun } from '../core/runs.js';

export interface IngestSkillArtifactsParams {
  run_id: string;
  skill_artifacts_dir: string;
  manifest_path?: string;
  step_id?: string;
  tags?: string[];
}

export interface IngestSkillArtifactsResult {
  ok: true;
  catalog_entry_id: string;
  artifact_count: number;
  ingested_at: string;
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function ingestSkillArtifacts(
  params: IngestSkillArtifactsParams,
): Promise<IngestSkillArtifactsResult> {
  const { run_id, skill_artifacts_dir, manifest_path, step_id: providedStepId, tags } = params;

  // Validate run exists
  getRun(run_id);

  const runDir = getRunDir(run_id);

  // C-02: path containment check
  const resolvedArtifactsDir = resolvePathWithinParent(
    runDir,
    skill_artifacts_dir,
    'skill_artifacts_dir',
  );

  if (!fs.existsSync(resolvedArtifactsDir)) {
    throw invalidParams(`skill_artifacts_dir does not exist: ${resolvedArtifactsDir}`);
  }

  const stat = fs.statSync(resolvedArtifactsDir);
  if (!stat.isDirectory()) {
    throw invalidParams(`skill_artifacts_dir is not a directory: ${resolvedArtifactsDir}`);
  }

  // Enumerate artifact files (recursive, includes subdirectories)
  const files: string[] = [];
  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  walkDir(resolvedArtifactsDir);

  if (files.length === 0) {
    throw invalidParams('skill_artifacts_dir contains no files', { dir: resolvedArtifactsDir });
  }

  // Build artifact list with SHA-256
  const artifacts: ComputationEvidenceCatalogItemV1['artifacts'] = files.map(filePath => ({
    path: path.relative(runDir, filePath),
    sha256: sha256File(filePath),
  })) as ComputationEvidenceCatalogItemV1['artifacts'];

  // Compute manifest SHA-256 if provided
  let manifestSha256: string | undefined;
  if (manifest_path) {
    const resolvedManifest = resolvePathWithinParent(runDir, manifest_path, 'manifest_path');
    if (!fs.existsSync(resolvedManifest)) {
      throw invalidParams(`manifest_path does not exist: ${resolvedManifest}`);
    }
    manifestSha256 = sha256File(resolvedManifest);
  }

  const now = new Date().toISOString();
  const stepId = providedStepId ?? randomUUID();

  // Infer skill_id from directory name
  const skillId = path.basename(resolvedArtifactsDir);

  const entry: ComputationEvidenceCatalogItemV1 = {
    schema_version: 1,
    run_id,
    step_id: stepId,
    skill_id: skillId,
    artifacts,
    ingested_at: now,
    ...(manifestSha256 ? { manifest_sha256: manifestSha256 } : {}),
    ...(tags && tags.length > 0 ? { tags: tags as ComputationEvidenceCatalogItemV1['tags'] } : {}),
  };

  // Append to JSONL catalog
  const catalogPath = path.join(runDir, 'computation_evidence_catalog_v1.jsonl');
  fs.appendFileSync(catalogPath, JSON.stringify(entry) + '\n', 'utf-8');

  // Generate catalog entry ID from content hash
  const entryHash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  const catalogEntryId = `comp_ev_${entryHash.slice(0, 12)}`;

  return {
    ok: true,
    catalog_entry_id: catalogEntryId,
    artifact_count: artifacts.length,
    ingested_at: now,
  };
}
