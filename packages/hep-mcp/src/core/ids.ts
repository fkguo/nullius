import { randomUUID } from 'crypto';

export function newProjectId(): string {
  return `proj_${randomUUID()}`;
}

// Provider-internal fallback ID. Do not present this as the recommended
// project-local, human-facing research run_id.
export function newRunId(): string {
  return `run_${randomUUID()}`;
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function newSessionId(): string {
  return `sess_${Date.now()}_${randomSuffix()}`;
}
