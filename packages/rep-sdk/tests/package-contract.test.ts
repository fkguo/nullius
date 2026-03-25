import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package contract', () => {
  it('keeps runtime dependencies free of internal autoresearch packages', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      exports: Record<string, unknown>;
    };

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContainEqual(
      expect.stringMatching(/^@autoresearch\//),
    );
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './client',
      './discovery',
      './server',
      './transport',
      './validation',
    ]);
  });

  it('loads the source entrypoints for the bounded public surface', async () => {
    await expect(import('../src/index.js')).resolves.toBeTruthy();
    await expect(import('../src/client/index.js')).resolves.toBeTruthy();
    await expect(import('../src/discovery/index.js')).resolves.toBeTruthy();
    await expect(import('../src/server/index.js')).resolves.toBeTruthy();
    await expect(import('../src/transport/index.js')).resolves.toBeTruthy();
    await expect(import('../src/validation/index.js')).resolves.toBeTruthy();
  });
});
