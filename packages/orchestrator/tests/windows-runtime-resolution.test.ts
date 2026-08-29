import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runtimeTokenForTool } from '../src/computation/path-safety.js';
import { resolveCanonicalNativeRuntime } from '../src/computation/runtime-identity.js';
import { defaultPythonRuntime } from '../src/python-runtime.js';

describe('platform-native Python resolution', () => {
  it('uses the native Windows command name without changing POSIX defaults', () => {
    expect(defaultPythonRuntime({}, 'win32')).toBe('python');
    expect(defaultPythonRuntime({}, 'darwin')).toBe('python3');
    expect(defaultPythonRuntime({ NULLIUS_PYTHON: 'custom-python' }, 'win32')).toBe('custom-python');
    expect(runtimeTokenForTool('python')).toBe(process.platform === 'win32' ? 'python' : 'python3');
  });

  it.runIf(process.platform === 'win32')('resolves PATHEXT executables to canonical PE bytes', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-runtime-project-'));
    const runDir = path.join(projectRoot, 'artifacts', 'runs', 'runtime-test');
    fs.mkdirSync(runDir, { recursive: true });

    const identity = resolveCanonicalNativeRuntime({ projectRoot, runDir, token: 'python' });
    expect(path.extname(identity.canonical_path).toLowerCase()).toBe('.exe');
    expect(identity.executable_format).toBe('pe');
    expect(identity.requested_token).toBe('python');
  });
});
