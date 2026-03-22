import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { FleetWorkersV1 } from '@autoresearch/shared';
import fleetWorkersSchema from '../../../../meta/schemas/fleet_workers_v1.schema.json' with { type: 'json' };
import { utcNowIso } from '../util.js';
import type { ReadModelError } from './run-read-model.js';

type AjvConstructor = new (options: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

const Ajv2020Ctor = Ajv2020 as unknown as AjvConstructor;
// Match the fleet queue store behavior: structural schema validation is strict,
// while date-time freshness is derived from runtime parsing in health logic.
const validator = new Ajv2020Ctor({ allErrors: true, strict: false, validateFormats: false }).compile(
  fleetWorkersSchema as Record<string, unknown>,
);

export type FleetWorkerRecord = FleetWorkersV1['workers'][number];
export type FleetWorkerHealth = 'healthy' | 'stale';
export type FleetWorkerView = FleetWorkerRecord & {
  health_status: FleetWorkerHealth;
  active_claim_count: number;
  available_slots: number;
};
export type FleetWorkersView = {
  workers_initialized: boolean;
  workers: FleetWorkerView[];
  total: number;
  returned: number;
  by_health: Record<FleetWorkerHealth, number>;
  claim_acceptance: {
    accepting_workers: number;
    not_accepting_workers: number;
  };
  capacity: {
    total_slots: number;
    claimed_slots: number;
    available_slots: number;
  };
};
export type FleetWorkersReadResult = {
  initialized: boolean;
  registry: FleetWorkersV1 | null;
  errors: ReadModelError[];
};

export function fleetWorkersPath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch', 'fleet_workers.json');
}

export function createEmptyFleetWorkers(): FleetWorkersV1 {
  return { schema_version: 1, updated_at: utcNowIso(), workers: [] };
}

function writeFleetWorkersAtomic(filePath: string, payload: FleetWorkersV1): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(payload, null, 2) + '\n';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

export function readFleetWorkers(projectRoot: string): FleetWorkersReadResult {
  const filePath = fleetWorkersPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { initialized: false, registry: null, errors: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return {
      initialized: true,
      registry: null,
      errors: [{ code: 'FLEET_WORKERS_PARSE_ERROR', message: `Failed to parse ${filePath}.` }],
    };
  }

  if (!validator(raw)) {
    return {
      initialized: true,
      registry: null,
      errors: [{ code: 'FLEET_WORKERS_SCHEMA_ERROR', message: `Failed fleet_workers_v1 validation for ${filePath}.` }],
    };
  }

  return { initialized: true, registry: raw as FleetWorkersV1, errors: [] };
}

export function writeFleetWorkers(projectRoot: string, registry: FleetWorkersV1): void {
  const nextRegistry: FleetWorkersV1 = {
    ...registry,
    schema_version: 1,
    updated_at: utcNowIso(),
  };
  if (!validator(nextRegistry)) {
    throw new Error(`fleet_workers_v1 validation failed before write: ${JSON.stringify(validator.errors ?? [])}`);
  }
  writeFleetWorkersAtomic(fleetWorkersPath(projectRoot), nextRegistry);
}

function deriveWorkerHealth(worker: FleetWorkerRecord, nowIso: string): FleetWorkerHealth {
  const nowMs = Date.parse(nowIso);
  const heartbeatMs = Date.parse(worker.last_heartbeat_at);
  if (Number.isNaN(nowMs) || Number.isNaN(heartbeatMs)) {
    return 'stale';
  }
  return heartbeatMs + (worker.heartbeat_timeout_seconds * 1000) < nowMs ? 'stale' : 'healthy';
}

export function buildFleetWorkerView(
  worker: FleetWorkerRecord,
  activeClaimCount: number,
  nowIso = utcNowIso(),
): FleetWorkerView {
  return {
    ...worker,
    health_status: deriveWorkerHealth(worker, nowIso),
    active_claim_count: activeClaimCount,
    available_slots: Math.max(worker.max_concurrent_claims - activeClaimCount, 0),
  };
}

export function upsertFleetWorker(
  registry: FleetWorkersV1,
  workerInput: {
    worker_id: string;
    max_concurrent_claims: number;
    heartbeat_timeout_seconds: number;
    note?: string;
  },
  nowIso = utcNowIso(),
): FleetWorkerRecord {
  const existing = registry.workers.find(worker => worker.worker_id === workerInput.worker_id);
  const nextWorker: FleetWorkerRecord = {
    worker_id: workerInput.worker_id,
    registered_at: existing?.registered_at ?? nowIso,
    last_heartbeat_at: nowIso,
    max_concurrent_claims: workerInput.max_concurrent_claims,
    heartbeat_timeout_seconds: workerInput.heartbeat_timeout_seconds,
    accepts_claims: existing?.accepts_claims ?? true,
    ...(workerInput.note !== undefined
      ? { note: workerInput.note }
      : (existing?.note !== undefined ? { note: existing.note } : {})),
  };
  if (existing) {
    Object.assign(existing, nextWorker);
    return existing;
  }
  registry.workers.push(nextWorker);
  return nextWorker;
}

export function summarizeFleetWorkers(
  readResult: FleetWorkersReadResult,
  limit: number,
  activeClaimsByWorker: Record<string, number>,
  nowIso = utcNowIso(),
): FleetWorkersView {
  if (!readResult.registry) {
    return {
      workers_initialized: readResult.initialized,
      workers: [],
      total: 0,
      returned: 0,
      by_health: { healthy: 0, stale: 0 },
      claim_acceptance: { accepting_workers: 0, not_accepting_workers: 0 },
      capacity: { total_slots: 0, claimed_slots: 0, available_slots: 0 },
    };
  }

  const allWorkers = [...readResult.registry.workers]
    .sort((left, right) => right.last_heartbeat_at.localeCompare(left.last_heartbeat_at) || left.worker_id.localeCompare(right.worker_id))
    .map(worker => buildFleetWorkerView(worker, activeClaimsByWorker[worker.worker_id] ?? 0, nowIso));
  const byHealth: Record<FleetWorkerHealth, number> = { healthy: 0, stale: 0 };
  let acceptingWorkers = 0;
  let notAcceptingWorkers = 0;
  let totalSlots = 0;
  let claimedSlots = 0;
  let availableSlots = 0;

  for (const worker of allWorkers) {
    byHealth[worker.health_status] += 1;
    if (worker.accepts_claims) {
      acceptingWorkers += 1;
    } else {
      notAcceptingWorkers += 1;
    }
    totalSlots += worker.max_concurrent_claims;
    claimedSlots += worker.active_claim_count;
    availableSlots += worker.available_slots;
  }

  return {
    workers_initialized: true,
    workers: allWorkers.slice(0, limit),
    total: allWorkers.length,
    returned: Math.min(limit, allWorkers.length),
    by_health: byHealth,
    claim_acceptance: {
      accepting_workers: acceptingWorkers,
      not_accepting_workers: notAcceptingWorkers,
    },
    capacity: {
      total_slots: totalSlots,
      claimed_slots: claimedSlots,
      available_slots: availableSlots,
    },
  };
}
