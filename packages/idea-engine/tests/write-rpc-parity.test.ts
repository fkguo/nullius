import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { handleJsonRpcRequest, parseJsonRpcLine } from '../src/rpc/jsonrpc.js';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';

interface WriteRpcCase {
  expected_store: Record<string, unknown>;
  initial_store: Record<string, unknown>;
  name: string;
  now: string;
  steps: Array<{ request: Record<string, unknown>; response: Record<string, unknown> }>;
  uuid_sequence: string[];
}

interface WriteRpcFixture {
  cases: WriteRpcCase[];
  parse_cases: Array<{ line: string; name: string; response: Record<string, unknown> }>;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePath = resolve(repoRoot, 'packages/idea-engine/tests/fixtures/write-rpc-golden.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as WriteRpcFixture;

function materializeSnapshot(rootDir: string, snapshot: Record<string, unknown>): void {
  for (const [relativePath, payload] of Object.entries(snapshot)) {
    const fullPath = resolve(rootDir, relativePath);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    if (relativePath.endsWith('.jsonl')) {
      const lines = (payload as unknown[]).map(item => JSON.stringify(item)).join('\n');
      writeFileSync(fullPath, lines ? `${lines}\n` : '', 'utf8');
      continue;
    }
    writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

function collectSnapshot(rootDir: string): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const relativePath = fullPath.slice(rootDir.length + 1);
      if (relativePath.endsWith('.jsonl')) {
        snapshot[relativePath] = readFileSync(fullPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as unknown);
        continue;
      }
      snapshot[relativePath] = JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
    }
  }
  return snapshot;
}

function collectTransientFiles(rootDir: string): string[] {
  const transient: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.name.includes('.tmp') || entry.name.endsWith('.lck')) {
        transient.push(fullPath);
      }
    }
  }
  return transient.sort();
}

describe('write-side RPC parity', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-write-rpc-'));
      tempDirs.push(rootDir);
      materializeSnapshot(rootDir, testCase.initial_store);
      const uuidSequence = [...testCase.uuid_sequence];
      const service = new IdeaEngineRpcService({
        rootDir,
        now: () => testCase.now,
        createId: () => {
          const next = uuidSequence.shift();
          if (!next) {
            throw new Error('uuid sequence exhausted');
          }
          return next;
        },
      });

      for (const step of testCase.steps) {
        expect(handleJsonRpcRequest(service, step.request)).toEqual(step.response);
      }
      expect(collectSnapshot(rootDir)).toEqual(testCase.expected_store);
      expect(collectTransientFiles(rootDir)).toEqual([]);
    });
  }

  for (const parseCase of fixture.parse_cases) {
    it(parseCase.name, () => {
      expect(parseJsonRpcLine(parseCase.line)).toEqual(parseCase.response);
    });
  }
});
