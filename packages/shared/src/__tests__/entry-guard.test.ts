import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../entry-guard.js';

// A real entry file, a symlink to it, and a symlinked directory that contains it. The temp root
// is realpath'd first so that `real` is the canonical path even where os.tmpdir() is itself a
// symlink (macOS /var -> /private/var).
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entry-guard-')));
const real = path.join(root, 'entry.mjs');
writeFileSync(real, '');
const other = path.join(root, 'other.mjs');
writeFileSync(other, '');
const fileLink = path.join(root, 'entry-link.mjs');
symlinkSync(real, fileLink);
const dirLink = path.join(root, 'dir-link');
symlinkSync(root, dirLink, 'dir');
const viaDirLink = path.join(dirLink, 'entry.mjs');
const moduleUrl = pathToFileURL(real).href;

describe('isMainModule', () => {
  it('is true when argv[1] is the module itself', () => {
    expect(isMainModule(moduleUrl, real)).toBe(true);
  });

  it('is true when argv[1] reaches the module through a file symlink or a symlinked directory', () => {
    expect(isMainModule(moduleUrl, fileLink)).toBe(true);
    expect(isMainModule(moduleUrl, viaDirLink)).toBe(true);
  });

  it('is true for a relative argv[1], resolved against the working directory', () => {
    expect(isMainModule(moduleUrl, path.relative(process.cwd(), real))).toBe(true);
  });

  it('documents the defect it fixes: plain path resolution does not see through the symlinks', () => {
    expect(path.resolve(fileLink)).not.toBe(real);
    expect(path.resolve(viaDirLink)).not.toBe(real);
  });

  it('is false for another file, even one beside the module', () => {
    expect(isMainModule(moduleUrl, other)).toBe(false);
  });

  it('is false when argv[1] names no file (realpath fails, plain comparison is the fallback)', () => {
    expect(isMainModule(moduleUrl, path.join(root, 'missing.mjs'))).toBe(false);
  });

  it('falls back to the plain comparison when the module itself cannot be realpath-resolved', () => {
    // The module URL names no file, so realpath throws on that side; the fallback still
    // accepts an argv[1] that resolves to the same (nonexistent) path, and nothing else.
    const missingUrl = pathToFileURL(path.join(root, 'ghost.mjs')).href;
    expect(isMainModule(missingUrl, path.join(root, 'ghost.mjs'))).toBe(true);
    expect(isMainModule(missingUrl, real)).toBe(false);
  });

  it('is false without argv[1] (REPL, -e); a --import preload has argv[1] pointing elsewhere', () => {
    expect(isMainModule(moduleUrl, undefined)).toBe(false);
    expect(isMainModule(moduleUrl, '')).toBe(false);
  });

  it('is false for a module URL that is not a file: URL', () => {
    expect(isMainModule('data:text/javascript,export%20default%201', real)).toBe(false);
    expect(isMainModule('node:fs', real)).toBe(false);
  });
});
