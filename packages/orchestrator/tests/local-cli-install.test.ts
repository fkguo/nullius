import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const installerPath = path.join(repoRoot, 'scripts', 'install-local-cli.mjs');

function executeWrapper(wrapperPath: string, args: string[]): string {
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', wrapperPath, ...args], {
      encoding: 'utf8',
    });
  }
  return execFileSync(wrapperPath, args, { encoding: 'utf8' });
}

describe('source-checkout CLI installer', () => {
  it('installs a runnable user-local wrapper, including into a path with spaces', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-cli-install-'));
    const binDir = path.join(root, 'bin with spaces');
    const output = execFileSync(process.execPath, [installerPath, '--bin-dir', binDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const wrapperPath = path.join(binDir, process.platform === 'win32' ? 'nullius.cmd' : 'nullius');

    expect(output).toContain(`[ok] installed: ${wrapperPath}`);
    expect(fs.readFileSync(wrapperPath, 'utf8')).toContain('Nullius source-checkout CLI wrapper. Managed by pnpm install:cli.');
    expect(executeWrapper(wrapperPath, ['--help'])).toContain('Canonical generic lifecycle and workflow-plan entrypoint');
  });

  it('refuses to overwrite an unmanaged command unless --force is explicit', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-cli-collision-'));
    const wrapperPath = path.join(binDir, process.platform === 'win32' ? 'nullius.cmd' : 'nullius');
    fs.writeFileSync(wrapperPath, 'unmanaged command\n', 'utf8');

    const refused = spawnSync(process.execPath, [installerPath, '--bin-dir', binDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refusing to replace unmanaged command');
    expect(fs.readFileSync(wrapperPath, 'utf8')).toBe('unmanaged command\n');

    execFileSync(process.execPath, [installerPath, '--bin-dir', binDir, '--force'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(executeWrapper(wrapperPath, ['--help'])).toContain('Canonical generic lifecycle and workflow-plan entrypoint');
  });

  it('does not follow a pre-existing symlink when --force replaces it', () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-cli-symlink-'));
    const binDir = path.join(root, 'bin');
    const targetPath = path.join(root, 'existing-target');
    const wrapperPath = path.join(binDir, 'nullius');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(targetPath, 'preserve this target\n', 'utf8');
    fs.symlinkSync(targetPath, wrapperPath);

    execFileSync(process.execPath, [installerPath, '--bin-dir', binDir, '--force'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(fs.lstatSync(wrapperPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('preserve this target\n');
    expect(executeWrapper(wrapperPath, ['--help'])).toContain('Canonical generic lifecycle and workflow-plan entrypoint');
  });
});
