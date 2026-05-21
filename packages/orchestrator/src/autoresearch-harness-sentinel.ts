import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomicDurable } from '@autoresearch/shared';

const AUTORESEARCH_DIRNAME = '.autoresearch';
const HARNESS_FILENAME = 'HARNESS';

export type AutoresearchHarnessSentinelPayload = {
  schema_version: 1;
  kind: 'autoresearch_project_harness';
  status_receipt_required: true;
  project_local_status_command: '.autoresearch/bin/autoresearch status --json';
  fallback_status_command: 'autoresearch status --json';
  host_skill: 'research-harness';
  lifecycle_authority: 'autoresearch';
  milestone_executor: 'research-team';
};

export type AutoresearchHarnessSentinelHealth = {
  path: string;
  exists: boolean;
  valid: boolean;
  payload: AutoresearchHarnessSentinelPayload | null;
  issue_code: string | null;
  message: string | null;
};

export function autoresearchHarnessSentinelRelativePath(): string {
  return path.join(AUTORESEARCH_DIRNAME, HARNESS_FILENAME).split(path.sep).join('/');
}

export function autoresearchHarnessSentinelPayload(): AutoresearchHarnessSentinelPayload {
  return {
    schema_version: 1,
    kind: 'autoresearch_project_harness',
    status_receipt_required: true,
    project_local_status_command: '.autoresearch/bin/autoresearch status --json',
    fallback_status_command: 'autoresearch status --json',
    host_skill: 'research-harness',
    lifecycle_authority: 'autoresearch',
    milestone_executor: 'research-team',
  };
}

function isAutoresearchHarnessSentinelPayload(value: unknown): value is AutoresearchHarnessSentinelPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.schema_version === 1
    && payload.kind === 'autoresearch_project_harness'
    && payload.status_receipt_required === true
    && payload.project_local_status_command === '.autoresearch/bin/autoresearch status --json'
    && payload.fallback_status_command === 'autoresearch status --json'
    && payload.host_skill === 'research-harness'
    && payload.lifecycle_authority === 'autoresearch'
    && payload.milestone_executor === 'research-team';
}

export function ensureAutoresearchHarnessSentinel(projectRoot: string): string {
  const sentinelPath = path.join(projectRoot, autoresearchHarnessSentinelRelativePath());
  // writeJsonAtomicDurable performs mkdir + atomic write + file fsync +
  // parent-dir fsync; eliminates the partial-file window where another
  // process could read a truncated sentinel between mkdir and write.
  writeJsonAtomicDurable(sentinelPath, autoresearchHarnessSentinelPayload());
  return sentinelPath;
}

export function readAutoresearchHarnessSentinelHealth(projectRoot: string): AutoresearchHarnessSentinelHealth {
  const relativePath = autoresearchHarnessSentinelRelativePath();
  const sentinelPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(sentinelPath)) {
    return {
      path: relativePath,
      exists: false,
      valid: false,
      payload: null,
      issue_code: 'AUTORESEARCH_HARNESS_SENTINEL_MISSING',
      message: 'Autoresearch harness sentinel is missing; run autoresearch init --runtime-only from the project root to refresh it.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sentinelPath, 'utf-8'));
  } catch {
    return {
      path: relativePath,
      exists: true,
      valid: false,
      payload: null,
      issue_code: 'AUTORESEARCH_HARNESS_SENTINEL_INVALID_JSON',
      message: 'Autoresearch harness sentinel is not valid JSON; run autoresearch init --runtime-only from the project root to refresh it.',
    };
  }
  if (!isAutoresearchHarnessSentinelPayload(parsed)) {
    return {
      path: relativePath,
      exists: true,
      valid: false,
      payload: null,
      issue_code: 'AUTORESEARCH_HARNESS_SENTINEL_INVALID_CONTRACT',
      message: 'Autoresearch harness sentinel does not match the expected contract; run autoresearch init --runtime-only from the project root to refresh it.',
    };
  }
  return {
    path: relativePath,
    exists: true,
    valid: true,
    payload: parsed,
    issue_code: null,
    message: null,
  };
}
