import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpError } from '@autoresearch/shared';

import { assertSafePathSegment, resolvePathWithinParent } from '../src/data/pathGuard.js';

describe('pathGuard (M0)', () => {
  it('blocks parent traversal', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-pathguard-'));
    expect(() => resolvePathWithinParent(base, '../escape.txt', 'test')).toThrowError(McpError);
  });

  it('blocks symlink escapes', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-pathguard-'));
    const parent = path.join(base, 'parent');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    const escape = path.join(parent, 'escape');
    fs.symlinkSync(outside, escape, 'dir');

    expect(() => resolvePathWithinParent(parent, 'escape/file.txt', 'test')).toThrowError(McpError);
  });

  it('enforces safe path segments', () => {
    expect(() => assertSafePathSegment('ok-name_1', 'artifact')).not.toThrow();
    expect(() => assertSafePathSegment('a/b', 'artifact')).toThrowError(McpError);
    expect(() => assertSafePathSegment('..', 'artifact')).toThrowError(McpError);
    expect(() => assertSafePathSegment('a..b', 'artifact')).toThrowError(McpError);
    expect(() => assertSafePathSegment('', 'artifact')).toThrowError(McpError);
  });
});

