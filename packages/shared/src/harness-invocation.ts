/**
 * P3-C harness invocation marker — REDESIGNED 2026-05-23.
 *
 * Earlier design (schema v1, clock-based 1h TTL) caused real-world friction:
 * the TTL expired inside legitimate sessions when the user did long thinking
 * or reading between tool calls, forcing ceremonial re-anchor with no actual
 * drift to detect. Both Codex (config_lock content-equality validation at
 * session boundaries; MtimeConfigReloader event-driven cache invalidation)
 * and Claude Code (FileEditTool per-resource mtime check at write-time) use
 * **event/state-driven invalidation, not clock TTL**, for equivalent
 * "is my agent still in sync with reality" concerns. The 1h clock TTL was a
 * design error.
 *
 * ## Current design (schema v2)
 *
 * Anchor is valid iff:
 *   1. `.autoresearch/HARNESS_INVOCATION` exists and is well-formed.
 *   2. `marker.anchored_at >= max(state.json mtime, ledger.jsonl mtime)` —
 *      i.e. no lifecycle event has happened on the project since the agent
 *      last anchored. State mutations bump the marker stale; pure thinking /
 *      reading do not.
 *
 * **There is no clock TTL.** Once you anchor against current project state,
 * the anchor stays valid until state actually changes. This matches Codex's
 * config_lock and Claude Code's FileEditTool mtime patterns.
 *
 * ## Skip layers (in order)
 *
 *   B. `process.cwd()` has no `.autoresearch/` directory → skip (standalone
 *      provider use; no lifecycle context to drift from).
 *   C. Caller (dispatcher) signals `toolIsStateTouching=false` for pure
 *      read-only provider queries → skip even with a `.autoresearch/` dir
 *      present (classification per dispatcher per audit; see each *-mcp
 *      dispatcher source).
 *   D. `AUTORESEARCH_HARNESS_VERIFY=skip` or `NODE_ENV=test` → skip
 *      (escape hatches; test default keeps suites green).
 *
 * ## Marker schema (v2)
 *
 * ```jsonc
 * {
 *   "schema_version": 2,
 *   "kind": "autoresearch_harness_invocation",
 *   "anchored_at": "2026-05-22T08:30:00Z",
 *   "host_skill": "research-harness",
 *   "project_root": "/abs/path",
 *   "state_mtime_at_anchor": "2026-05-22T08:29:55.123Z",  // ISO; optional
 *   "ledger_mtime_at_anchor": "2026-05-22T08:25:10.456Z" // ISO; optional
 * }
 * ```
 *
 * v1 markers (with `ttl_seconds`) are accepted backward-compat for one
 * release: their `anchored_at` is checked against current state.json /
 * ledger.jsonl mtime exactly like v2, with the legacy `ttl_seconds` field
 * ignored. `autoresearch status` writes v2 going forward.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError, type ErrorCode } from './errors.js';
import { writeJsonAtomicDurable } from './atomic-write.js';

export const HARNESS_INVOCATION_FILE = '.autoresearch/HARNESS_INVOCATION';
export const AUTORESEARCH_STATE_FILE = '.autoresearch/state.json';
export const AUTORESEARCH_LEDGER_FILE = '.autoresearch/ledger.jsonl';
const HARNESS_INVOCATION_KIND = 'autoresearch_harness_invocation' as const;
export const HARNESS_INVOCATION_SCHEMA_VERSION = 2 as const;

/**
 * Legacy v1 schema default TTL kept ONLY for backward-compat parsing.
 * v2 markers do not use it. Verifier ignores it on v1 markers too.
 *
 * @deprecated kept exported so dependent packages compiling against an
 *   older `@autoresearch/shared` do not break at import time.
 */
export const DEFAULT_HARNESS_INVOCATION_TTL_SECONDS = 3600;

const HARNESS_INVOCATION_REQUIRED_CODE = 'HARNESS_INVOCATION_REQUIRED' satisfies ErrorCode;

export type HarnessInvocationMarker = {
  schema_version: 1 | 2;
  kind: typeof HARNESS_INVOCATION_KIND;
  anchored_at: string;
  /** Legacy v1 only; ignored by current verifier. Optional. */
  ttl_seconds?: number;
  host_skill: 'research-harness';
  project_root: string;
  /** ISO mtime of `.autoresearch/state.json` at anchor time, if it existed. v2 only. */
  state_mtime_at_anchor?: string;
  /** ISO mtime of `.autoresearch/ledger.jsonl` at anchor time, if it existed. v2 only. */
  ledger_mtime_at_anchor?: string;
};

export type HarnessInvocationReason =
  | 'MARKER_MISSING'
  | 'MARKER_INVALID'
  | 'STATE_CHANGED_SINCE_ANCHOR';

export type VerifyOptions = {
  /**
   * Caller (dispatcher) signals whether the dispatched tool may touch
   * project state. When `false`, anchor verification is skipped — pure
   * provider queries (arxiv/openalex/etc.) do not need to anchor against
   * project state because they don't read or write it.
   *
   * Default `true` (conservative). Each *-mcp dispatcher computes this
   * from a per-tool classification table; see the dispatcher source for
   * the audit-backed list.
   */
  toolIsStateTouching?: boolean;
  /**
   * Override "now" for tests. Verifier reads mtimes from disk, so this
   * is rarely needed; provided for symmetry.
   */
  now?: Date;
  /**
   * Override the environment used for skip-mode detection. Tests pass
   * an explicit env so they don't have to mutate `process.env`.
   */
  env?: NodeJS.ProcessEnv;
};

export type WriteOptions = {
  /**
   * Override the timestamp written into the marker. Tests pass this to
   * deterministically write a marker at a known time.
   */
  now?: Date;
  /**
   * Legacy v1 field. Ignored by v2 writer; kept as an optional parameter
   * so call sites that previously passed it do not need a code change in
   * the same PR. Will be removed in a follow-up cleanup.
   *
   * @deprecated
   */
  ttlSeconds?: number;
};

export function isHarnessVerifySkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = typeof env.AUTORESEARCH_HARNESS_VERIFY === 'string'
    ? env.AUTORESEARCH_HARNESS_VERIFY.trim().toLowerCase()
    : '';
  if (explicit === 'skip') return true;
  if (explicit === 'on') return false;
  return env.NODE_ENV === 'test';
}

export function harnessInvocationMarkerPath(projectRoot: string): string {
  return path.join(projectRoot, HARNESS_INVOCATION_FILE);
}

export function autoresearchStatePath(projectRoot: string): string {
  return path.join(projectRoot, AUTORESEARCH_STATE_FILE);
}

export function autoresearchLedgerPath(projectRoot: string): string {
  return path.join(projectRoot, AUTORESEARCH_LEDGER_FILE);
}

function autoresearchDirPath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch');
}

function harnessInvocationError(
  reason: HarnessInvocationReason,
  projectRoot: string,
  extra: Record<string, unknown> = {},
): McpError {
  const message = (() => {
    switch (reason) {
      case 'MARKER_MISSING':
        return 'Host agent has not anchored via research-harness for this session.';
      case 'MARKER_INVALID':
        return 'Research-harness anchor marker is malformed; re-anchor to repair.';
      case 'STATE_CHANGED_SINCE_ANCHOR':
        return 'Project state has changed since the last anchor; re-anchor to confirm current state before continuing.';
    }
  })();
  return new McpError(HARNESS_INVOCATION_REQUIRED_CODE, message, {
    reason,
    project_root: projectRoot,
    marker_path: HARNESS_INVOCATION_FILE,
    remediation:
      'Invoke the research-harness skill, or run `autoresearch status --json` from the project root, to refresh the anchor marker.',
    ...extra,
  });
}

function isHarnessInvocationMarker(value: unknown): value is HarnessInvocationMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.schema_version !== 1 && payload.schema_version !== 2) return false;
  if (payload.kind !== HARNESS_INVOCATION_KIND) return false;
  if (typeof payload.anchored_at !== 'string' || payload.anchored_at.length === 0) return false;
  if (payload.host_skill !== 'research-harness') return false;
  if (typeof payload.project_root !== 'string') return false;
  // v1 may carry ttl_seconds; v2 may carry state_mtime_at_anchor /
  // ledger_mtime_at_anchor. We do not enforce these — they are informational
  // for diagnostic readers. The verifier always reads current state.json /
  // ledger.jsonl mtimes from disk, not from the marker.
  if (payload.ttl_seconds !== undefined && typeof payload.ttl_seconds !== 'number') return false;
  if (payload.state_mtime_at_anchor !== undefined && typeof payload.state_mtime_at_anchor !== 'string') return false;
  if (payload.ledger_mtime_at_anchor !== undefined && typeof payload.ledger_mtime_at_anchor !== 'string') return false;
  return true;
}

function safeMtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Write the harness invocation marker for the given project root with a
 * fresh `anchored_at` timestamp + current state.json / ledger.jsonl
 * mtimes (for diagnostic surfaces; verifier ignores them and reads from
 * disk). Called by `autoresearch status` on the success path; safe to
 * call repeatedly (atomic rewrite).
 */
export function writeHarnessInvocationMarker(
  projectRoot: string,
  opts: WriteOptions = {},
): HarnessInvocationMarker {
  const now = opts.now ?? new Date();
  const stateMtimeMs = safeMtimeMs(autoresearchStatePath(projectRoot));
  const ledgerMtimeMs = safeMtimeMs(autoresearchLedgerPath(projectRoot));
  const marker: HarnessInvocationMarker = {
    schema_version: HARNESS_INVOCATION_SCHEMA_VERSION,
    kind: HARNESS_INVOCATION_KIND,
    anchored_at: now.toISOString(),
    host_skill: 'research-harness',
    project_root: projectRoot,
    ...(stateMtimeMs !== null ? { state_mtime_at_anchor: new Date(stateMtimeMs).toISOString() } : {}),
    ...(ledgerMtimeMs !== null ? { ledger_mtime_at_anchor: new Date(ledgerMtimeMs).toISOString() } : {}),
  };
  writeJsonAtomicDurable(harnessInvocationMarkerPath(projectRoot), marker);
  return marker;
}

/**
 * Verify the harness invocation marker for the project rooted at `cwd`.
 *
 * Skip layers (in order):
 *   1. Test / explicit-skip env (`AUTORESEARCH_HARNESS_VERIFY=skip` or
 *      `NODE_ENV=test` without explicit `on`).
 *   2. `cwd` has no `.autoresearch/` directory (B — standalone provider
 *      use; no lifecycle context to drift from).
 *   3. Caller passed `toolIsStateTouching=false` (C — read-only provider
 *      queries do not need to anchor against project state).
 *
 * If none of those apply, verify:
 *   - Marker exists at `<cwd>/.autoresearch/HARNESS_INVOCATION` and
 *     parses as a v1 or v2 marker.
 *   - `marker.anchored_at >= max(state.json mtime, ledger.jsonl mtime)`.
 *
 * Throws `HARNESS_INVOCATION_REQUIRED` otherwise. No clock TTL.
 */
export function verifyHarnessInvocationMarker(
  cwd: string,
  opts: VerifyOptions = {},
): void {
  const env = opts.env ?? process.env;

  // Skip 1: test / explicit skip.
  if (isHarnessVerifySkipped(env)) return;

  // Skip 2: no autoresearch context at cwd (standalone provider use).
  if (!fs.existsSync(autoresearchDirPath(cwd))) return;

  // Skip 3: dispatcher told us this specific tool doesn't touch project state.
  if (opts.toolIsStateTouching === false) return;

  const markerPath = harnessInvocationMarkerPath(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf-8');
  } catch (err) {
    // ENOENT is the common path; other errors (EACCES, EIO) collapse into
    // MARKER_MISSING — caller cannot read the marker either way.
    throw harnessInvocationError('MARKER_MISSING', cwd, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw harnessInvocationError('MARKER_INVALID', cwd, {
      detail: 'marker file is not valid JSON',
    });
  }

  if (!isHarnessInvocationMarker(parsed)) {
    throw harnessInvocationError('MARKER_INVALID', cwd, {
      detail: 'marker file does not match the expected contract (accepted schemas: 1, 2)',
    });
  }

  const anchoredAtMs = Date.parse(parsed.anchored_at);
  if (!Number.isFinite(anchoredAtMs)) {
    throw harnessInvocationError('MARKER_INVALID', cwd, {
      detail: 'anchored_at is not a parseable ISO timestamp',
    });
  }

  // Event-driven freshness: anchor must be >= max(state.json mtime, ledger mtime).
  // If neither file exists yet (fresh project), anchor passes trivially.
  const stateMtimeMs = safeMtimeMs(autoresearchStatePath(cwd));
  const ledgerMtimeMs = safeMtimeMs(autoresearchLedgerPath(cwd));
  const latestStateChangeMs = Math.max(
    stateMtimeMs ?? Number.NEGATIVE_INFINITY,
    ledgerMtimeMs ?? Number.NEGATIVE_INFINITY,
  );

  if (Number.isFinite(latestStateChangeMs) && anchoredAtMs < latestStateChangeMs) {
    throw harnessInvocationError('STATE_CHANGED_SINCE_ANCHOR', cwd, {
      anchored_at: parsed.anchored_at,
      latest_state_change_at: new Date(latestStateChangeMs).toISOString(),
      ...(stateMtimeMs !== null ? { state_mtime: new Date(stateMtimeMs).toISOString() } : {}),
      ...(ledgerMtimeMs !== null ? { ledger_mtime: new Date(ledgerMtimeMs).toISOString() } : {}),
    });
  }
}

/**
 * Read the marker without verifying freshness. Used by diagnostic
 * surfaces (e.g. `autoresearch status`) that want to report anchor state
 * without forcing a rejection. Returns null on any read or parse failure.
 */
export function readHarnessInvocationMarker(projectRoot: string): HarnessInvocationMarker | null {
  const markerPath = harnessInvocationMarkerPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isHarnessInvocationMarker(parsed) ? parsed : null;
}
