import * as fs from 'fs';
import { invalidParams } from '@autoresearch/shared';

import { detectConflicts } from '../../tools/research/conflictDetector.js';
import type { ConflictDetectionResult } from '../../tools/research/conflictDetector.js';
import type { Claim, EvidenceLevel } from '../../tools/writing/types.js';

import { writeRunJsonArtifact } from '../citations.js';
import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';

function nowIso(): string {
  return new Date().toISOString();
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function ensureStep(manifest: RunManifest, stepName: string): { manifest: RunManifest; stepIndex: number } {
  const steps = [...manifest.steps];
  let idx = steps.findIndex(s => s.step === stepName);
  if (idx === -1) {
    steps.push({ step: stepName, status: 'pending' });
    idx = steps.length - 1;
  }
  return {
    manifest: {
      ...manifest,
      updated_at: nowIso(),
      steps,
    },
    stepIndex: idx,
  };
}

function writeRunTextArtifact(params: {
  runId: string;
  artifactName: string;
  content: string;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, params.content, 'utf-8');
  return {
    name: params.artifactName,
    uri: `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(params.artifactName)}`,
    mimeType: params.mimeType,
  };
}

function readRunJsonArtifact<T>(runId: string, artifactName: string): T {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) {
    throw invalidParams(`Missing required run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function extractClaimsFromClaimsArtifact(payload: unknown): { claims: Claim[]; recids?: string[] } {
  if (!payload || typeof payload !== 'object') return { claims: [] };
  const p = payload as any;
  const table = p.claims_table ?? p;
  const claims = Array.isArray(table?.claims) ? (table.claims as Claim[]) : [];
  const recids = Array.isArray(table?.corpus_snapshot?.recids) ? table.corpus_snapshot.recids.map((x: any) => String(x)) : undefined;
  return { claims, recids };
}

function countEvidenceGrades(claims: Claim[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of claims) {
    const grade = (c?.evidence_grade ?? 'unknown') as EvidenceLevel | 'unknown';
    counts[grade] = (counts[grade] ?? 0) + 1;
  }
  return counts;
}

function summarizeConflicts(result: ConflictDetectionResult): {
  total: number;
  by_type: Record<string, number>;
  top: Array<{ quantity: string; tension_sigma: number; conflict_type: string; recids: string[]; notes?: string }>;
  compatible_groups: number;
} {
  const by_type: Record<string, number> = {};
  for (const c of result.conflicts ?? []) {
    const t = String(c.conflict_type ?? 'unknown');
    by_type[t] = (by_type[t] ?? 0) + 1;
  }

  const top = [...(result.conflicts ?? [])]
    .sort((a, b) => (b.tension_sigma ?? 0) - (a.tension_sigma ?? 0))
    .slice(0, 5)
    .map(c => ({
      quantity: c.quantity,
      tension_sigma: c.tension_sigma,
      conflict_type: c.conflict_type,
      recids: (c.measurements ?? []).map(m => m.recid),
      notes: c.notes,
    }));

  return {
    total: (result.conflicts ?? []).length,
    by_type,
    top,
    compatible_groups: (result.compatible_groups ?? []).length,
  };
}

export async function buildRunWritingCritical(params: {
  run_id: string;
  recids: string[];
  claims_artifact_name: string;
  conflicts_artifact_name: string;
  stance_artifact_name: string;
  evidence_grades_artifact_name: string;
  summary_artifact_name: string;
  min_tension_sigma: number;
  target_quantities?: string[];
  include_tables?: boolean;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}> {
  if (!Array.isArray(params.recids) || params.recids.length === 0) {
    throw invalidParams('recids must be a non-empty array', { recids: params.recids });
  }

  const runId = params.run_id;
  const run = getRun(runId);
  const stepName = 'writing_critical';
  const startedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_run_build_writing_critical', args: { run_id: runId } },
    update: current => {
      const ensured = ensureStep(current, stepName);
      const manifest = ensured.manifest;
      const stepIndex = ensured.stepIndex;
      const updatedStep: RunStep = {
        ...manifest.steps[stepIndex]!,
        status: 'in_progress',
        started_at: manifest.steps[stepIndex]?.started_at ?? startedAt,
        completed_at: undefined,
      };
      const next: RunManifest = {
        ...manifest,
        updated_at: startedAt,
        steps: manifest.steps.map((s, idx) => (idx === stepIndex ? updatedStep : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });

  const warnings: string[] = [];
  const artifacts: RunArtifactRef[] = [];

  try {
    const claimsArtifact = readRunJsonArtifact<any>(runId, params.claims_artifact_name);
    const { claims, recids: claimsRecids } = extractClaimsFromClaimsArtifact(claimsArtifact);
    const evidenceGrades = countEvidenceGrades(claims);

    const evidenceGradesPayload = {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      paper_recids: claimsRecids ?? params.recids,
      counts: evidenceGrades,
      claims: claims.map(c => ({
        claim_id: c.claim_id,
        claim_no: c.claim_no,
        category: c.category,
        paper_ids: c.paper_ids,
        evidence_grade: c.evidence_grade,
        keywords: c.keywords,
      })),
    };
    const gradesRef = writeRunJsonArtifact(runId, params.evidence_grades_artifact_name, evidenceGradesPayload);
    artifacts.push(gradesRef);

    let conflictsResult: ConflictDetectionResult;
    try {
      conflictsResult = await detectConflicts({
        recids: params.recids,
        target_quantities: params.target_quantities,
        min_tension_sigma: params.min_tension_sigma,
        include_tables: params.include_tables,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`conflict_detector_error:${message}`);
      conflictsResult = {
        success: false,
        error: message,
        warnings: [],
        conflicts: [],
        compatible_groups: [],
        summary: {
          papers_analyzed: 0,
          total_measurements: 0,
          hard_conflicts: 0,
          soft_conflicts: 0,
          apparent_conflicts: 0,
          compatible_quantities: 0,
        },
      };
    }

    const conflictsPayload = {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      recids: params.recids,
      params: {
        target_quantities: params.target_quantities ?? null,
        min_tension_sigma: params.min_tension_sigma,
        include_tables: params.include_tables ?? null,
      },
      result: conflictsResult,
      warnings,
    };
    const conflictsRef = writeRunJsonArtifact(runId, params.conflicts_artifact_name, conflictsPayload);
    artifacts.push(conflictsRef);

    const stanceLines: string[] = [];
    const generatedAt = nowIso();

    for (const conflict of conflictsResult.conflicts ?? []) {
      stanceLines.push(
        JSON.stringify({
          version: 1,
          generated_at: generatedAt,
          run_id: runId,
          kind: 'measurement_conflict',
          stance: 'contradicting',
          conflict_type: conflict.conflict_type,
          tension_sigma: conflict.tension_sigma,
          quantity: conflict.quantity,
          measurements: conflict.measurements,
          notes: conflict.notes,
        })
      );
    }

    for (const group of conflictsResult.compatible_groups ?? []) {
      stanceLines.push(
        JSON.stringify({
          version: 1,
          generated_at: generatedAt,
          run_id: runId,
          kind: 'measurement_compatible',
          stance: 'confirming',
          quantity: group.quantity,
          papers: group.papers,
          combined_value: group.combined_value,
          weighted_average: group.weighted_average,
          combined_uncertainty: group.combined_uncertainty,
        })
      );
    }

    const stanceRef = writeRunTextArtifact({
      runId,
      artifactName: params.stance_artifact_name,
      content: stanceLines.join('\n') + '\n',
      mimeType: 'application/x-ndjson',
    });
    artifacts.push(stanceRef);

    const conflictSummary = summarizeConflicts(conflictsResult);
    const summaryPayload = {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      recids: params.recids,
      conflicts: conflictSummary,
      evidence_grades: {
        total_claims: claims.length,
        counts: evidenceGrades,
      },
      artifacts: {
        conflicts_uri: conflictsRef.uri,
        stance_uri: stanceRef.uri,
        evidence_grades_uri: gradesRef.uri,
      },
      warnings,
    };
    const summaryRef = writeRunJsonArtifact(runId, params.summary_artifact_name, summaryPayload);
    artifacts.push(summaryRef);

    const completedAt = nowIso();
    await updateRunManifestAtomic({
      run_id: runId,
      tool: { name: 'hep_run_build_writing_critical', args: { run_id: runId } },
      update: current => {
        const ensured = ensureStep(current, stepName);
        const manifest = ensured.manifest;
        const stepIndex = ensured.stepIndex;
        const merged = mergeArtifactRefs(manifest.steps[stepIndex]?.artifacts, artifacts);
        const updatedStep: RunStep = {
          ...manifest.steps[stepIndex]!,
          status: 'done',
          started_at: manifest.steps[stepIndex]!.started_at ?? startedAt,
          completed_at: completedAt,
          artifacts: merged,
        };
        const next: RunManifest = {
          ...manifest,
          updated_at: completedAt,
          steps: manifest.steps.map((s, idx) => (idx === stepIndex ? updatedStep : s)),
        };
        return { ...next, status: computeRunStatus(next) };
      },
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        conflicts: conflictSummary,
        evidence_grades: summaryPayload.evidence_grades,
        warnings_total: warnings.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const failedAt = nowIso();
      await updateRunManifestAtomic({
        run_id: runId,
        tool: { name: 'hep_run_build_writing_critical', args: { run_id: runId } },
        update: current => {
          const ensured = ensureStep(current, stepName);
          const manifest = ensured.manifest;
          const stepIndex = ensured.stepIndex;
          const updatedStep: RunStep = {
            ...manifest.steps[stepIndex]!,
            status: 'failed',
            started_at: manifest.steps[stepIndex]!.started_at ?? startedAt,
            completed_at: failedAt,
            artifacts,
            notes: message,
          };
          const next: RunManifest = {
            ...manifest,
            updated_at: failedAt,
            steps: manifest.steps.map((s, idx) => (idx === stepIndex ? updatedStep : s)),
          };
          return { ...next, status: computeRunStatus(next) };
        },
      });
    } catch {
      // ignore secondary failures
    }
    throw err;
  }
}
