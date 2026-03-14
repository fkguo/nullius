import { cpSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdeaEngineReadService } from '../src/service/read-service.js';
import { handleJsonRpcRequest, parseJsonRpcLine } from '../src/rpc/jsonrpc.js';

interface GoldenCase {
  name: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

interface GoldenFixture {
  store_dir: string;
  cases: GoldenCase[];
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePath = resolve(repoRoot, 'packages/idea-engine/tests/fixtures/read-rpc-golden.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture;

describe('read-side RPC parity', () => {
  let tempRootDir = '';
  let service: IdeaEngineReadService;

  beforeEach(() => {
    tempRootDir = mkdtempSync(join(tmpdir(), 'idea-engine-rpc-'));
    const copiedStoreDir = resolve(tempRootDir, 'store');
    cpSync(resolve(repoRoot, fixture.store_dir), copiedStoreDir, { recursive: true });
    service = new IdeaEngineReadService({ rootDir: copiedStoreDir });
  });

  afterEach(() => {
    rmSync(tempRootDir, { recursive: true, force: true });
  });

  for (const goldenCase of fixture.cases) {
    it(goldenCase.name, () => {
      expect(handleJsonRpcRequest(service, goldenCase.request)).toEqual(goldenCase.response);
    });
  }

  it('matches Python parse_error envelope for invalid JSON lines', () => {
    expect(parseJsonRpcLine('{')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'parse_error',
        data: { reason: 'parse_error' },
      },
    });
  });
});
