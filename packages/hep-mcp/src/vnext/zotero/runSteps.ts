import { invalidParams } from '@autoresearch/shared';

import type { RunArtifactRef, RunManifest, RunStep } from '../runs.js';
import { updateRunManifestAtomic } from '../runs.js';

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

export async function startRunStep(runId: string, stepName: string): Promise<{
  manifestStart: RunManifest;
  stepIndex: number;
  step: RunStep;
}> {
  const now = new Date().toISOString();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    update: current => {
      const step: RunStep = { step: stepName, status: 'in_progress', started_at: now };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: [...current.steps, step],
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
  const stepIndex = manifestStart.steps.length - 1;
  const step = manifestStart.steps[stepIndex]!;
  return { manifestStart, stepIndex, step };
}

export async function completeRunStep(params: {
  runId: string;
  stepIndex: number;
  stepStart: RunStep;
  status: 'done' | 'failed';
  artifacts: RunArtifactRef[];
  notes?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await updateRunManifestAtomic({
    run_id: params.runId,
    update: current => {
      const idx = current.steps[params.stepIndex]?.step === params.stepStart.step
        ? params.stepIndex
        : current.steps.findIndex(s => s.step === params.stepStart.step && s.started_at === params.stepStart.started_at);
      if (idx < 0) {
        throw invalidParams('Internal: unable to locate run step for completion (fail-fast)', {
          run_id: params.runId,
          step: params.stepStart.step,
          started_at: params.stepStart.started_at ?? null,
        });
      }

      const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, params.artifacts);
      const nextStep: RunStep = {
        ...current.steps[idx]!,
        status: params.status,
        started_at: current.steps[idx]!.started_at ?? params.stepStart.started_at,
        completed_at: now,
        artifacts: merged,
        notes: params.notes,
      };

      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: current.steps.map((s, i) => (i === idx ? nextStep : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
}
