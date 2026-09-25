import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));
import { acquireExecution, releaseExecution } from '../src/execution-lock.js';

describe('pre-dispatch lock initialization', () => {
  it('cleans its own unhanded-off lock on fsync failure and allows another caller', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-lock-failure-')));
    try {
      const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected disk failure'); });
      expect(() => acquireExecution(root, 'first')).toThrow('injected disk failure');
      sync.mockRestore();
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
      acquireExecution(root, 'second');
      releaseExecution(root, 'second');
    } finally { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
