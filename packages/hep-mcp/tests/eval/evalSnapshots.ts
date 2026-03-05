import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

import { EvalSetSchema, type EvalSet } from '../../src/eval/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const SNAPSHOTS_DIR = path.join(HERE, 'snapshots');
export const BASELINES_DIR = path.join(HERE, 'baselines');

export function readEvalFixture<T>(name: string): T {
  const p = path.join(FIXTURES_DIR, name);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

export function readEvalSetFixture(name: string): EvalSet {
  return EvalSetSchema.parse(readEvalFixture<unknown>(name));
}

export function assertEvalSnapshot(name: string, payload: unknown): void {
  const p = path.join(SNAPSHOTS_DIR, `${name}.json`);
  const update = process.env.EVAL_UPDATE_SNAPSHOTS === '1';
  if (update) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    return;
  }

  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing eval snapshot: ${p}. Run 'pnpm -r test:eval:update' to generate/update baselines.`
    );
  }

  const baseline = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
  expect(payload).toEqual(baseline);
}
