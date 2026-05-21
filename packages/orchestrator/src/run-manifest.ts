// @autoresearch/orchestrator — RunManifest (NEW-RT-04)
// Checkpoint + resume mechanism for durable execution.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomicDurable } from '@autoresearch/shared';
import { utcNowIso } from './util.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepCheckpoint {
  /** Tool-use block ID from the Anthropic API (used as durable step identity). */
  step_id: string;
  completed_at: string;
  result_summary?: string;
}

export interface RunManifest {
  run_id: string;
  created_at: string;
  /** Step ID of the last successfully completed step. */
  last_completed_step?: string;
  /**
   * When set, indicates this run is a resume.
   * Steps whose step_id is in `checkpoints` will be skipped (cached result injected).
   */
  resume_from?: string;
  checkpoints: StepCheckpoint[];
}

// ─── RunManifestManager ───────────────────────────────────────────────────────

export class RunManifestManager {
  constructor(private readonly runsDir: string) {}

  private manifestPath(runId: string): string {
    return path.join(this.runsDir, runId, 'manifest.json');
  }

  /**
   * Atomically save a checkpoint for a completed step.
   * If a checkpoint for this step_id already exists, it is not duplicated.
   */
  saveCheckpoint(runId: string, stepId: string, resultSummary?: string): void {
    const manifest = this.loadManifest(runId) ?? this.newManifest(runId);

    if (!manifest.checkpoints.some((c) => c.step_id === stepId)) {
      manifest.checkpoints.push({
        step_id: stepId,
        completed_at: utcNowIso(),
        ...(resultSummary !== undefined ? { result_summary: resultSummary } : {}),
      });
    }
    manifest.last_completed_step = stepId;
    this.writeManifest(manifest);
  }

  /** Load a manifest from disk. Returns null if not found. */
  loadManifest(runId: string): RunManifest | null {
    const p = this.manifestPath(runId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RunManifest;
  }

  /**
   * Returns true if stepId should be skipped (already completed in a prior run).
   * Only skips when `manifest.resume_from` is set.
   */
  shouldSkipStep(manifest: RunManifest, stepId: string): boolean {
    if (!manifest.resume_from) return false;
    return manifest.checkpoints.some((c) => c.step_id === stepId);
  }

  private newManifest(runId: string): RunManifest {
    return { run_id: runId, created_at: utcNowIso(), checkpoints: [] };
  }

  private writeManifest(manifest: RunManifest): void {
    // P1: now delegated to the shared durable primitive. This was the
    // gold-standard fsync sequence (Batch 8 R2 fix) that the
    // writeJsonAtomicDurable primitive was lifted from — keeping it as a
    // local re-implementation would be a drift hazard.
    writeJsonAtomicDurable(this.manifestPath(manifest.run_id), manifest);
  }
}
