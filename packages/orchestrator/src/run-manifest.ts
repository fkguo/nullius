// @autoresearch/orchestrator — RunManifest (NEW-RT-04)
// Checkpoint + resume mechanism for durable execution.

import * as fs from 'node:fs';
import * as path from 'node:path';
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
    const p = this.manifestPath(manifest.run_id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    const content = JSON.stringify(manifest, null, 2);
    // fsync before rename for crash durability (required by durable execution contract)
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
    // fsync the parent directory to persist the directory entry after rename
    const dirFd = fs.openSync(path.dirname(p), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}
