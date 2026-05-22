/**
 * P3-C: Harness invocation marker.
 *
 * Cross-dispatcher gate that catches the "research-harness skill drift in
 * long conversations" failure mode mechanically. Every *-mcp dispatcher
 * calls {@link verifyHarnessInvocationMarker} at the outermost layer, before
 * tool spec lookup. If the host agent has not anchored via the
 * research-harness skill in this session (or the anchor has expired), the
 * verifier throws `HARNESS_INVOCATION_REQUIRED` and the dispatcher returns
 * the error to the agent with a remediation pointer.
 *
 * The marker file (`.autoresearch/HARNESS_INVOCATION`) is written by
 * `autoresearch status` on the success path — the same command the
 * research-harness skill already invokes to recover/anchor a project. The
 * agent does not need a new command; running `status --json` doubles as the
 * anchor receipt.
 *
 * ## Separation from `.autoresearch/HARNESS`
 *
 * `.autoresearch/HARNESS` is the *project-level* sentinel — written once by
 * `autoresearch init` and treated as a runtime handshake (see
 * `packages/orchestrator/src/autoresearch-harness-sentinel.ts`). It persists
 * for the project's lifetime.
 *
 * `.autoresearch/HARNESS_INVOCATION` is the *session-level* anchor receipt —
 * rewritten on every successful `status` call with a fresh timestamp and
 * TTL. It exists to prove the agent is currently aligned on project state,
 * not just that the project exists on disk.
 *
 * ## Default TTL
 *
 * 3600 s (1 h). Tuned to require periodic re-anchoring without forcing
 * re-anchor between every tool call. The TTL is encoded in the marker so
 * the verifier can read it back; future tuning is a one-place change in
 * {@link DEFAULT_HARNESS_INVOCATION_TTL_SECONDS}.
 *
 * ## Skip semantics
 *
 *   - `process.env.AUTORESEARCH_HARNESS_VERIFY === 'skip'` → skip
 *   - `process.env.AUTORESEARCH_HARNESS_VERIFY === 'on'`   → force verify
 *   - else `process.env.NODE_ENV === 'test'`               → skip (vitest)
 *   - else                                                 → verify
 *
 * The NODE_ENV=test default keeps the entire existing test suite green
 * without per-package vitest config changes. The explicit `on` override
 * lets the regression test exercise the rejection path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError, type ErrorCode } from './errors.js';
import { writeJsonAtomicDurable } from './atomic-write.js';

export const HARNESS_INVOCATION_FILE = '.autoresearch/HARNESS_INVOCATION';
export const DEFAULT_HARNESS_INVOCATION_TTL_SECONDS = 3600;
const HARNESS_INVOCATION_KIND = 'autoresearch_harness_invocation' as const;

const HARNESS_INVOCATION_REQUIRED_CODE = 'HARNESS_INVOCATION_REQUIRED' satisfies ErrorCode;

export type HarnessInvocationMarker = {
  schema_version: 1;
  kind: typeof HARNESS_INVOCATION_KIND;
  anchored_at: string;
  ttl_seconds: number;
  host_skill: 'research-harness';
  project_root: string;
};

export type HarnessInvocationReason =
  | 'MARKER_MISSING'
  | 'MARKER_STALE'
  | 'MARKER_INVALID';

export type VerifyOptions = {
  /**
   * Override the current time. Tests set this to deterministically exercise
   * the freshness boundary.
   */
  now?: Date;
  /**
   * Override the environment used for skip-mode detection. Tests pass an
   * explicit env so they don't have to mutate `process.env`.
   */
  env?: NodeJS.ProcessEnv;
};

export type WriteOptions = {
  /**
   * TTL stamped into the marker. Defaults to
   * {@link DEFAULT_HARNESS_INVOCATION_TTL_SECONDS}. Verifier reads the TTL
   * back from the file, so tuning the default does not require coordinating
   * a producer/consumer release.
   */
  ttlSeconds?: number;
  /**
   * Override the timestamp written into the marker. Tests pass this to
   * deterministically write a stale marker.
   */
  now?: Date;
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

function harnessInvocationError(
  reason: HarnessInvocationReason,
  projectRoot: string,
  extra: Record<string, unknown> = {},
): McpError {
  const message = (() => {
    switch (reason) {
      case 'MARKER_MISSING':
        return 'Host agent has not anchored via research-harness this session.';
      case 'MARKER_STALE':
        return 'Research-harness anchor has expired; re-anchor before continuing.';
      case 'MARKER_INVALID':
        return 'Research-harness anchor marker is malformed; re-anchor to repair.';
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
  return payload.schema_version === 1
    && payload.kind === HARNESS_INVOCATION_KIND
    && typeof payload.anchored_at === 'string'
    && payload.anchored_at.length > 0
    && typeof payload.ttl_seconds === 'number'
    && Number.isFinite(payload.ttl_seconds)
    && payload.ttl_seconds >= 0
    && payload.host_skill === 'research-harness'
    && typeof payload.project_root === 'string';
}

/**
 * Write the harness invocation marker for the given project root with a
 * fresh `anchored_at` timestamp. Called by `autoresearch status` on the
 * success path; safe to call repeatedly (atomic rewrite).
 */
export function writeHarnessInvocationMarker(
  projectRoot: string,
  opts: WriteOptions = {},
): HarnessInvocationMarker {
  const now = opts.now ?? new Date();
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_HARNESS_INVOCATION_TTL_SECONDS;
  const marker: HarnessInvocationMarker = {
    schema_version: 1,
    kind: HARNESS_INVOCATION_KIND,
    anchored_at: now.toISOString(),
    ttl_seconds: ttlSeconds,
    host_skill: 'research-harness',
    project_root: projectRoot,
  };
  writeJsonAtomicDurable(harnessInvocationMarkerPath(projectRoot), marker);
  return marker;
}

/**
 * Verify the harness invocation marker for the given project root. Throws
 * `HARNESS_INVOCATION_REQUIRED` if the marker is missing, malformed, or
 * stale relative to `opts.now` (defaults to `new Date()`).
 *
 * Honors the skip semantics documented in the module header — production
 * callers do not need to handle the skip case themselves.
 */
export function verifyHarnessInvocationMarker(
  projectRoot: string,
  opts: VerifyOptions = {},
): void {
  const env = opts.env ?? process.env;
  if (isHarnessVerifySkipped(env)) return;

  const markerPath = harnessInvocationMarkerPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf-8');
  } catch (err) {
    // ENOENT is the common path; other errors (EACCES, EIO) are also "we
    // cannot read the marker" so they collapse into MARKER_MISSING.
    throw harnessInvocationError('MARKER_MISSING', projectRoot, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw harnessInvocationError('MARKER_INVALID', projectRoot, {
      detail: 'marker file is not valid JSON',
    });
  }

  if (!isHarnessInvocationMarker(parsed)) {
    throw harnessInvocationError('MARKER_INVALID', projectRoot, {
      detail: 'marker file does not match the expected contract',
    });
  }

  const anchoredAtMs = Date.parse(parsed.anchored_at);
  if (!Number.isFinite(anchoredAtMs)) {
    throw harnessInvocationError('MARKER_INVALID', projectRoot, {
      detail: 'anchored_at is not a parseable ISO timestamp',
    });
  }

  const now = opts.now ?? new Date();
  const expiresAtMs = anchoredAtMs + parsed.ttl_seconds * 1000;
  if (now.getTime() > expiresAtMs) {
    throw harnessInvocationError('MARKER_STALE', projectRoot, {
      anchored_at: parsed.anchored_at,
      ttl_seconds: parsed.ttl_seconds,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
  }
}

/**
 * Read the marker without verifying freshness. Used by diagnostic surfaces
 * (e.g. `autoresearch status`) that want to report the anchor state without
 * forcing a rejection.
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
