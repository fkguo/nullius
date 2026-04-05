import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { runLegacyPythonSubcommand } from '../src/cli-python.js';

afterEach(() => {
  spawnSyncMock.mockClear();
  delete process.env.HEP_AUTORESEARCH_PYTHON;
});

describe('legacy TS->Python CLI bridge', () => {
  it('passes --project-root before the python subcommand', () => {
    process.env.HEP_AUTORESEARCH_PYTHON = 'python3';

    const code = runLegacyPythonSubcommand('init', ['--project-root', '/tmp/project-root', '--force']);

    expect(code).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    const [python, argv] = spawnSyncMock.mock.calls[0] as unknown as [string, string[]];
    expect(python).toBe('python3');
    expect(argv).toEqual(['-m', 'hep_autoresearch', '--project-root', '/tmp/project-root', 'init', '--force']);
  });
});

