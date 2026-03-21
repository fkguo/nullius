import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function freshnessScriptPath(): string {
  return path.join(repoRootFromThisFile(), 'scripts', 'check-orchestrator-package-freshness.mjs');
}

function makeTempRoots() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orchestrator-freshness-'));
  return {
    root,
    srcRoot: path.join(root, 'src'),
    distRoot: path.join(root, 'dist'),
  };
}

function writeFileWithMtime(targetPath: string, content: string, when: Date): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf-8');
  utimesSync(targetPath, when, when);
}

function runFreshnessCheck(args: string[]) {
  return spawnSync(process.execPath, [freshnessScriptPath(), ...args], {
    encoding: 'utf-8',
  });
}

describe('orchestrator package freshness gate', () => {
  it('passes when emitted js is fresh and the declaration output exists', () => {
    const { root, srcRoot, distRoot } = makeTempRoots();
    try {
      const sourceTime = new Date('2026-03-21T09:00:00.000Z');
      const artifactTime = new Date('2026-03-21T09:05:00.000Z');
      writeFileWithMtime(path.join(srcRoot, 'index.ts'), 'export const value = 1;\n', sourceTime);
      writeFileWithMtime(path.join(distRoot, 'index.js'), 'export const value = 1;\n', artifactTime);
      writeFileWithMtime(path.join(distRoot, 'index.d.ts'), 'export declare const value = 1;\n', artifactTime);

      const result = runFreshnessCheck([
        '--src-root',
        srcRoot,
        '--dist-root',
        distRoot,
        '--package-label',
        'temp-orchestrator',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[ok] temp-orchestrator package output is fresh.');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('passes when the declaration file is older than the source but still present', () => {
    const { root, srcRoot, distRoot } = makeTempRoots();
    try {
      const declarationTime = new Date('2026-03-21T09:00:00.000Z');
      const sourceTime = new Date('2026-03-21T09:05:00.000Z');
      const jsTime = new Date('2026-03-21T09:06:00.000Z');
      writeFileWithMtime(path.join(srcRoot, 'index.ts'), 'export const value = 1;\n', sourceTime);
      writeFileWithMtime(path.join(distRoot, 'index.js'), 'export const value = 1;\n', jsTime);
      writeFileWithMtime(path.join(distRoot, 'index.d.ts'), 'export declare const value = 1;\n', declarationTime);

      const result = runFreshnessCheck([
        '--src-root',
        srcRoot,
        '--dist-root',
        distRoot,
        '--package-label',
        'temp-orchestrator',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[ok] temp-orchestrator package output is fresh.');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('fails when a required emitted artifact is missing', () => {
    const { root, srcRoot, distRoot } = makeTempRoots();
    try {
      const sourceTime = new Date('2026-03-21T09:00:00.000Z');
      const artifactTime = new Date('2026-03-21T09:05:00.000Z');
      writeFileWithMtime(path.join(srcRoot, 'index.ts'), 'export const value = 1;\n', sourceTime);
      writeFileWithMtime(path.join(distRoot, 'index.js'), 'export const value = 1;\n', artifactTime);

      const result = runFreshnessCheck([
        '--src-root',
        srcRoot,
        '--dist-root',
        distRoot,
        '--package-label',
        'temp-orchestrator',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('missing emitted artifact');
      expect(result.stderr).toContain('src/index.ts');
      expect(result.stderr).toContain('dist/index.d.ts');
      expect(result.stderr).toContain('pnpm --filter temp-orchestrator build');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('fails when a source file is newer than its emitted artifacts', () => {
    const { root, srcRoot, distRoot } = makeTempRoots();
    try {
      const artifactTime = new Date('2026-03-21T09:00:00.000Z');
      const sourceTime = new Date('2026-03-21T09:05:00.000Z');
      writeFileWithMtime(path.join(srcRoot, 'orch-tools', 'index.ts'), 'export const value = 1;\n', sourceTime);
      writeFileWithMtime(path.join(distRoot, 'orch-tools', 'index.js'), 'export const value = 1;\n', artifactTime);
      writeFileWithMtime(path.join(distRoot, 'orch-tools', 'index.d.ts'), 'export declare const value = 1;\n', artifactTime);

      const result = runFreshnessCheck([
        '--src-root',
        srcRoot,
        '--dist-root',
        distRoot,
        '--package-label',
        'temp-orchestrator',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('stale emitted artifact');
      expect(result.stderr).toContain('src/orch-tools/index.ts');
      expect(result.stderr).toContain('dist/orch-tools/index.js');
      expect(result.stderr).not.toContain('dist/orch-tools/index.d.ts');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('ignores declaration files in the source tree when checking freshness', () => {
    const { root, srcRoot, distRoot } = makeTempRoots();
    try {
      const sourceTime = new Date('2026-03-21T09:00:00.000Z');
      const artifactTime = new Date('2026-03-21T09:05:00.000Z');
      writeFileWithMtime(path.join(srcRoot, 'index.ts'), 'export const value = 1;\n', sourceTime);
      writeFileWithMtime(path.join(srcRoot, 'ambient.d.ts'), 'declare const ambient: string;\n', sourceTime);
      writeFileWithMtime(path.join(distRoot, 'index.js'), 'export const value = 1;\n', artifactTime);
      writeFileWithMtime(path.join(distRoot, 'index.d.ts'), 'export declare const value = 1;\n', artifactTime);

      const result = runFreshnessCheck([
        '--src-root',
        srcRoot,
        '--dist-root',
        distRoot,
        '--package-label',
        'temp-orchestrator',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[ok] temp-orchestrator package output is fresh.');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('passes on the real worktree after orchestrator build has refreshed the package output', () => {
    const result = runFreshnessCheck([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[ok] @autoresearch/orchestrator package output is fresh.');
    expect(result.stderr).toBe('');
  });
});
