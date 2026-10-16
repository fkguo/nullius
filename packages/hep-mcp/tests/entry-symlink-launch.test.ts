import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hep-mcp's package.json `bin` points straight at dist/index.js, so a bin link made by a package
// manager is a symlink start. CI runs `pnpm -r build` before `pnpm -r test`, so a missing dist
// is a build failure, not a reason to skip.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(packageDir, 'dist', 'index.js');
const STARTED = '[hep-mcp] Server started';

function launch(entry: string, dataDir: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HEP_DATA_DIR: dataDir },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.on('data', () => {});
    // stdin closed at once: the server starts, sees EOF, and exits on its own.
    child.stdin.end();
    // Kill well inside the test's own time limit so a hung start fails on the launch that hung.
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
}

describe('hep-mcp entry guard', () => {
  it('has a built entry to launch', () => {
    expect(existsSync(dist)).toBe(true);
  });

  it('starts the server when launched through a symlink to dist/index.js and through a symlinked package directory', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hep-entry-'));
    const dataDir = path.join(root, 'data');
    const fileLink = path.join(root, 'hep-mcp');
    symlinkSync(dist, fileLink);
    const dirLink = path.join(root, 'pkg');
    symlinkSync(packageDir, dirLink, 'dir');
    const viaDirLink = path.join(dirLink, 'dist', 'index.js');

    // The comparison the old guard made is false for both symlinked starts; that is the defect.
    expect(path.resolve(fileLink)).not.toBe(realpathSync(dist));
    expect(path.resolve(viaDirLink)).not.toBe(realpathSync(dist));

    for (const entry of [dist, fileLink, viaDirLink]) {
      const result = await launch(entry, dataDir);
      expect(result.stderr, `start through ${entry}`).toContain(STARTED);
      expect(result.signal, `start through ${entry}`).toBeNull();
      expect(result.code, `start through ${entry}`).toBe(0);
    }
  }, 40_000);
});
