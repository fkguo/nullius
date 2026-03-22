import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { FleetQueueV1 } from '@autoresearch/shared';
import fleetQueueSchema from '../../../../meta/schemas/fleet_queue_v1.schema.json' with { type: 'json' };
import { utcNowIso } from '../util.js';
import type { ReadModelError } from './run-read-model.js';

type AjvConstructor = new (options: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

const Ajv2020Ctor = Ajv2020 as unknown as AjvConstructor;
const validator = new Ajv2020Ctor({ allErrors: true, strict: false, validateFormats: false }).compile(
  fleetQueueSchema as Record<string, unknown>,
);

export type FleetQueueItem = FleetQueueV1['items'][number];
export type FleetQueueClaim = NonNullable<FleetQueueItem['claim']>;
export type FleetQueueItemView = Pick<
  FleetQueueItem,
  'queue_item_id' | 'run_id' | 'status' | 'priority' | 'enqueued_at' | 'requested_by' | 'attempt_count' | 'note' | 'claim'
>;

export type FleetQueueView = {
  queue_initialized: boolean;
  items: FleetQueueItemView[];
  total: number;
  returned: number;
  by_status: Record<string, number>;
};

export type FleetQueueReadResult = {
  initialized: boolean;
  queue: FleetQueueV1 | null;
  errors: ReadModelError[];
};

export function fleetQueuePath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch', 'fleet_queue.json');
}

export function createEmptyFleetQueue(): FleetQueueV1 {
  return { schema_version: 1, updated_at: utcNowIso(), items: [] };
}

function writeFleetQueueAtomic(filePath: string, payload: FleetQueueV1): void {
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

export function readFleetQueue(projectRoot: string): FleetQueueReadResult {
  const filePath = fleetQueuePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { initialized: false, queue: null, errors: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return {
      initialized: true,
      queue: null,
      errors: [{ code: 'FLEET_QUEUE_PARSE_ERROR', message: `Failed to parse ${filePath}.` }],
    };
  }

  if (!validator(raw)) {
    return {
      initialized: true,
      queue: null,
      errors: [{
        code: 'FLEET_QUEUE_SCHEMA_ERROR',
        message: `Failed fleet_queue_v1 validation for ${filePath}.`,
      }],
    };
  }

  return { initialized: true, queue: raw as FleetQueueV1, errors: [] };
}

export function writeFleetQueue(projectRoot: string, queue: FleetQueueV1): void {
  const nextQueue: FleetQueueV1 = {
    ...queue,
    schema_version: 1,
    updated_at: utcNowIso(),
  };
  if (!validator(nextQueue)) {
    throw new Error(`fleet_queue_v1 validation failed before write: ${JSON.stringify(validator.errors ?? [])}`);
  }
  writeFleetQueueAtomic(fleetQueuePath(projectRoot), nextQueue);
}

export function summarizeFleetQueue(
  readResult: FleetQueueReadResult,
  limit: number,
): FleetQueueView {
  if (!readResult.queue) {
    return {
      queue_initialized: readResult.initialized,
      items: [],
      total: 0,
      returned: 0,
      by_status: {},
    };
  }

  const byStatus: Record<string, number> = {};
  for (const item of readResult.queue.items) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  }

  const items = [...readResult.queue.items]
    .sort((left, right) => right.enqueued_at.localeCompare(left.enqueued_at))
    .slice(0, limit)
    .map(item => ({ ...item }));

  return {
    queue_initialized: true,
    items,
    total: readResult.queue.items.length,
    returned: items.length,
    by_status: byStatus,
  };
}
