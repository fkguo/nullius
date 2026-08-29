import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomicDurable } from '@nullius/shared';
import {
  projectLocalNulliusStatusCommand,
  type ProjectLocalNulliusStatusCommand,
} from './project-local-nullius.js';

const NULLIUS_DIRNAME = '.nullius';
const HARNESS_FILENAME = 'HARNESS';
const PROJECT_LOCAL_STATUS_COMMANDS = new Set<ProjectLocalNulliusStatusCommand>([
  '.nullius/bin/nullius status --json',
  '.nullius/bin/nullius.cmd status --json',
]);

export type NulliusHarnessSentinelPayload = {
  schema_version: 1;
  kind: 'nullius_project_harness';
  status_receipt_required: true;
  project_local_status_command: ProjectLocalNulliusStatusCommand;
  fallback_status_command: 'nullius status --json';
  host_skill: 'research-harness';
  lifecycle_authority: 'nullius';
  milestone_executor: 'research-team';
};

export type NulliusHarnessSentinelHealth = {
  path: string;
  exists: boolean;
  valid: boolean;
  payload: NulliusHarnessSentinelPayload | null;
  issue_code: string | null;
  message: string | null;
};

export function nulliusHarnessSentinelRelativePath(): string {
  return path.join(NULLIUS_DIRNAME, HARNESS_FILENAME).split(path.sep).join('/');
}

export function nulliusHarnessSentinelPayload(): NulliusHarnessSentinelPayload {
  return {
    schema_version: 1,
    kind: 'nullius_project_harness',
    status_receipt_required: true,
    project_local_status_command: projectLocalNulliusStatusCommand(),
    fallback_status_command: 'nullius status --json',
    host_skill: 'research-harness',
    lifecycle_authority: 'nullius',
    milestone_executor: 'research-team',
  };
}

function isNulliusHarnessSentinelPayload(value: unknown): value is NulliusHarnessSentinelPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.schema_version === 1
    && payload.kind === 'nullius_project_harness'
    && payload.status_receipt_required === true
    // A project may move between Windows and POSIX. Both current protocol-2
    // launcher spellings are portable sentinel truth; the read model chooses
    // the host-preferred spelling when presenting the reconnect command.
    && PROJECT_LOCAL_STATUS_COMMANDS.has(payload.project_local_status_command as ProjectLocalNulliusStatusCommand)
    && payload.fallback_status_command === 'nullius status --json'
    && payload.host_skill === 'research-harness'
    && payload.lifecycle_authority === 'nullius'
    && payload.milestone_executor === 'research-team';
}

export function ensureNulliusHarnessSentinel(projectRoot: string): string {
  const sentinelPath = path.join(projectRoot, nulliusHarnessSentinelRelativePath());
  // writeJsonAtomicDurable performs mkdir + atomic write + file fsync +
  // parent-dir fsync; eliminates the partial-file window where another
  // process could read a truncated sentinel between mkdir and write.
  writeJsonAtomicDurable(sentinelPath, nulliusHarnessSentinelPayload());
  return sentinelPath;
}

export function readNulliusHarnessSentinelHealth(projectRoot: string): NulliusHarnessSentinelHealth {
  const relativePath = nulliusHarnessSentinelRelativePath();
  const sentinelPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(sentinelPath)) {
    return {
      path: relativePath,
      exists: false,
      valid: false,
      payload: null,
      issue_code: 'NULLIUS_HARNESS_SENTINEL_MISSING',
      message: 'Nullius harness sentinel is missing; run nullius init --runtime-only from the project root to refresh it.',
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
      issue_code: 'NULLIUS_HARNESS_SENTINEL_INVALID_JSON',
      message: 'Nullius harness sentinel is not valid JSON; run nullius init --runtime-only from the project root to refresh it.',
    };
  }
  if (!isNulliusHarnessSentinelPayload(parsed)) {
    return {
      path: relativePath,
      exists: true,
      valid: false,
      payload: null,
      issue_code: 'NULLIUS_HARNESS_SENTINEL_INVALID_CONTRACT',
      message: 'Nullius harness sentinel does not match the expected contract; run nullius init --runtime-only from the project root to refresh it.',
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
