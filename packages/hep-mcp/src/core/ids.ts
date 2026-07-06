import { randomUUID } from 'crypto';
import { shortId } from '@nullius/shared';

// proj_/run_ follow the EcosystemID `{prefix}_{opaque}` convention. The opaque
// part is a human-referenced handle id, so it uses a compact shortId (Crockford
// base32 — a strict subset of the EcosystemID opaque charset, so `proj_<id>` /
// `run_<id>` stay valid EcosystemIDs and remain parseable downstream).
export function newProjectId(): string {
  return `proj_${shortId()}`;
}

// Provider-internal fallback ID. Do not present this as the recommended
// project-local, human-facing research run_id.
export function newRunId(): string {
  return `run_${shortId()}`;
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function newSessionId(): string {
  return `sess_${Date.now()}_${randomSuffix()}`;
}
