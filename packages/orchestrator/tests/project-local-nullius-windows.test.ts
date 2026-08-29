import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  nulliusHarnessSentinelPayload,
  readNulliusHarnessSentinelHealth,
} from '../src/nullius-harness-sentinel.js';
import {
  ensureProjectLocalNulliusLauncher,
  readProjectLocalNulliusLauncherHealth,
} from '../src/project-local-nullius.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stderr,
    stdout,
  };
}

function runBatch(batchPath: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', batchPath, ...args], {
    encoding: 'utf-8',
    env,
    timeout: 20_000,
  });
}

function runBatchAsync(batchPath: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', batchPath, ...args], {
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`launcher exited ${String(code)}: ${stderr}`));
    });
  });
}

function batchLiteral(value: string): string {
  return `"${value.replace(/%/g, '%%')}"`;
}

function replaceBakedArgv(script: string, nextArgv: string[]): string {
  const prefix = 'rem nullius-baked-argv-base64 ';
  const metadata = script.split(/\r?\n/u).find(line => line.startsWith(prefix));
  if (!metadata) throw new Error('missing baked argv metadata');
  const previousArgv = JSON.parse(
    Buffer.from(metadata.slice(prefix.length), 'base64').toString('utf-8'),
  ) as string[];
  const nextMetadata = `${prefix}${Buffer.from(JSON.stringify(nextArgv), 'utf-8').toString('base64')}`;
  return previousArgv.reduce(
    (nextScript, previousArg, index) => nextScript.replaceAll(
      batchLiteral(previousArg),
      batchLiteral(nextArgv[index]!),
    ),
    script.replace(metadata, nextMetadata),
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('native Windows project-local launcher', () => {
  windowsIt('runtime-only init creates, advertises, and runs the preferred .cmd launcher', async () => {
    const parent = tempRoot('nullius windows launcher ');
    const projectRoot = path.join(parent, '项目 root');
    const { io, stdout } = makeIo(parent);

    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], io)).toBe(0);

    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'bin', 'nullius'))).toBe(true);
    expect(fs.existsSync(launcherPath)).toBe(true);
    expect(stdout.join('')).toContain('.nullius\\bin\\nullius.cmd');
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, '.nullius', 'HARNESS'), 'utf-8')))
      .toMatchObject({ project_local_status_command: '.nullius/bin/nullius.cmd status --json' });
    expect(readProjectLocalNulliusLauncherHealth(projectRoot)).toMatchObject({
      path: '.nullius/bin/nullius.cmd',
      exists: true,
      executable: true,
      healthy: true,
    });

    const payload = JSON.parse(runBatch(launcherPath, process.env, 'status', '--json')) as {
      run_status: string;
      recovery_context: { status_commands: Record<string, string> };
    };
    expect(payload.run_status).toBe('idle');
    expect(payload.recovery_context.status_commands).toMatchObject({
      project_local_fallback: '.nullius/bin/nullius.cmd status --json',
      harness_entrypoint: '.nullius/bin/nullius.cmd status --json',
    });
  });

  windowsIt('accepts the POSIX current-protocol HARNESS spelling after a project moves hosts', async () => {
    const projectRoot = path.join(tempRoot('nullius-harness-portable-'), 'project');
    expect(await runCli(
      [`--project-root=${projectRoot}`, 'init', '--runtime-only'],
      makeIo(path.dirname(projectRoot)).io,
    )).toBe(0);
    const portablePayload = {
      ...nulliusHarnessSentinelPayload(),
      project_local_status_command: '.nullius/bin/nullius status --json' as const,
    };
    fs.writeFileSync(
      path.join(projectRoot, '.nullius', 'HARNESS'),
      `${JSON.stringify(portablePayload, null, 2)}\n`,
      'utf-8',
    );

    expect(readNulliusHarnessSentinelHealth(projectRoot)).toMatchObject({
      exists: true,
      valid: true,
      payload: portablePayload,
    });
  });

  windowsIt('reports a launcher with deleted protocol guards as unparseable', async () => {
    const parent = tempRoot('nullius-windows-guard-health-');
    const projectRoot = path.join(parent, 'project');
    expect(await runCli(
      [`--project-root=${projectRoot}`, 'init', '--runtime-only'],
      makeIo(parent).io,
    )).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
    const original = fs.readFileSync(launcherPath, 'utf-8');
    const requiredGuards = [
      'if not "%NULLIUS_PROBE_STATUS%"=="0" goto nullius_try_path',
      'if not "%NULLIUS_BANNER%"=="nullius-launcher-protocol 2" goto nullius_fail',
    ];

    for (const guard of requiredGuards) {
      const mutated = original.replace(`${guard}\r\n`, '');
      expect(mutated).not.toBe(original);
      fs.writeFileSync(launcherPath, mutated, 'utf-8');
      expect(readProjectLocalNulliusLauncherHealth(projectRoot)).toMatchObject({
        healthy: false,
        issue_code: 'PROJECT_LOCAL_LAUNCHER_UNPARSEABLE',
      });
    }
  });

  windowsIt('uses only a protocol-2 PATH fallback and forwards percent/metacharacter args without CALL re-expansion', async () => {
    const parent = tempRoot('nullius-windows-fallback-');
    const projectRoot = path.join(parent, 'project');
    expect(await runCli(
      [`--project-root=${projectRoot}`, 'init', '--runtime-only'],
      makeIo(parent).io,
    )).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
    const original = fs.readFileSync(launcherPath, 'utf-8');
    const prefix = 'rem nullius-baked-argv-base64 ';
    const metadata = original.split(/\r?\n/u).find(line => line.startsWith(prefix))!;
    const bakedArgv = JSON.parse(Buffer.from(metadata.slice(prefix.length), 'base64').toString('utf-8')) as string[];
    const missingArgv = [...bakedArgv];
    missingArgv[missingArgv.length - 1] = `${missingArgv.at(-1)!}.missing`;
    const fallbackScript = replaceBakedArgv(original, missingArgv);
    fs.writeFileSync(launcherPath, fallbackScript, 'utf-8');
    expect(fallbackScript).not.toContain(
      'call "%RESOLVED_NULLIUS%" --launcher-generation=2 --project-root "%PROJECT_ROOT%" %*',
    );
    expect(fallbackScript).toContain(
      '"%RESOLVED_NULLIUS%" --launcher-generation=2 --project-root "%PROJECT_ROOT%" %*',
    );

    const fallbackBin = path.join(parent, 'fallback bin');
    fs.mkdirSync(fallbackBin, { recursive: true });
    const argvLog = path.join(parent, 'argv.json');
    const recorder = path.join(parent, 'record-argv.mjs');
    fs.writeFileSync(
      recorder,
      "import fs from 'node:fs';\nfs.writeFileSync(process.env.NULLIUS_WINDOWS_ARGV_LOG, JSON.stringify(process.argv.slice(2)));\n",
      'utf-8',
    );
    fs.writeFileSync(path.join(fallbackBin, 'nullius.cmd'), [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'if not "%~1"=="--launcher-generation=2" goto dispatch',
      'if not "%~2"=="--launcher-protocol" goto dispatch',
      'if not "%~3"=="" goto dispatch',
      'echo nullius-launcher-protocol 2',
      'exit /b 0',
      ':dispatch',
      `${batchLiteral(process.execPath)} ${batchLiteral(recorder)} %*`,
      '',
    ].join('\r\n'), 'utf-8');

    const driver = path.join(parent, 'driver.cmd');
    fs.writeFileSync(driver, [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `${batchLiteral(launcherPath)} "percent=%%NULLIUS_DOUBLE_EXPANSION%%" "meta=a&b"`,
      '',
    ].join('\r\n'), 'utf-8');
    const env = {
      ...process.env,
      PATH: `${path.dirname(launcherPath)};${fallbackBin};${process.env.PATH ?? ''}`,
      PATHEXT: '.CMD;.EXE;.COM;.BAT',
      NULLIUS_DOUBLE_EXPANSION: 'EXPANDED_BY_CALL',
      NULLIUS_WINDOWS_ARGV_LOG: argvLog,
    };
    const previousPath = process.env.PATH;
    const previousPathExt = process.env.PATHEXT;
    process.env.PATH = env.PATH;
    process.env.PATHEXT = env.PATHEXT;
    try {
      expect(readProjectLocalNulliusLauncherHealth(projectRoot)).toMatchObject({ healthy: true });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousPathExt;
    }
    runBatch(driver, env);

    expect(JSON.parse(fs.readFileSync(argvLog, 'utf-8'))).toEqual([
      '--launcher-generation=2',
      '--project-root',
      projectRoot,
      'percent=%NULLIUS_DOUBLE_EXPANSION%',
      'meta=a&b',
    ]);
  });

  windowsIt('refuses PATH shims with non-newline output after the protocol banner', async () => {
    const parent = tempRoot('nullius-windows-probe-extra-');
    const projectRoot = path.join(parent, 'project');
    expect(await runCli(
      [`--project-root=${projectRoot}`, 'init', '--runtime-only'],
      makeIo(parent).io,
    )).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
    const original = fs.readFileSync(launcherPath, 'utf-8');
    const prefix = 'rem nullius-baked-argv-base64 ';
    const metadata = original.split(/\r?\n/u).find(line => line.startsWith(prefix))!;
    const bakedArgv = JSON.parse(
      Buffer.from(metadata.slice(prefix.length), 'base64').toString('utf-8'),
    ) as string[];
    const missingArgv = [...bakedArgv];
    missingArgv[missingArgv.length - 1] = `${missingArgv.at(-1)!}.missing`;
    fs.writeFileSync(launcherPath, replaceBakedArgv(original, missingArgv), 'utf-8');

    const malformedExtras = [
      ['semicolon', 'echo ;extra'],
      ['whitespace', 'echo(   '],
    ] as const;
    for (const [name, extraCommand] of malformedExtras) {
      const fallbackBin = path.join(parent, `fallback-${name}`);
      fs.mkdirSync(fallbackBin, { recursive: true });
      const dispatchMarker = path.join(parent, `dispatched-${name}.txt`);
      fs.writeFileSync(path.join(fallbackBin, 'nullius.cmd'), [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'if not "%~1"=="--launcher-generation=2" goto dispatch',
        'if not "%~2"=="--launcher-protocol" goto dispatch',
        'if not "%~3"=="" goto dispatch',
        'echo nullius-launcher-protocol 2',
        extraCommand,
        'exit /b 0',
        ':dispatch',
        `echo dispatched>${batchLiteral(dispatchMarker)}`,
        'exit /b 0',
        '',
      ].join('\r\n'), 'utf-8');
      const env = {
        ...process.env,
        PATH: `${path.dirname(launcherPath)};${fallbackBin};${process.env.PATH ?? ''}`,
        PATHEXT: '.CMD;.EXE;.COM;.BAT',
      };
      const previousPath = process.env.PATH;
      const previousPathExt = process.env.PATHEXT;
      process.env.PATH = env.PATH;
      process.env.PATHEXT = env.PATHEXT;
      try {
        expect(readProjectLocalNulliusLauncherHealth(projectRoot).healthy, name).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousPathExt === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = previousPathExt;
      }
      expect(() => runBatch(launcherPath, env, 'status', '--json')).toThrow();
      expect(fs.existsSync(dispatchMarker)).toBe(false);
    }
  });

  windowsIt('escapes a percent-bearing embedded Node path in the baked launcher command', async () => {
    const parent = tempRoot('nullius-windows-percent-baked-');
    const projectRoot = path.join(parent, 'project');
    expect(await runCli(
      [`--project-root=${projectRoot}`, 'init', '--runtime-only'],
      makeIo(parent).io,
    )).toBe(0);
    const percentNode = path.join(parent, 'node-%NULLIUS_EMBEDDED_PATH%.exe');
    fs.copyFileSync(process.execPath, percentNode, fs.constants.COPYFILE_FICLONE);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
    if (!descriptor) throw new Error('process.execPath descriptor unavailable');
    Object.defineProperty(process, 'execPath', { ...descriptor, value: percentNode });
    try {
      ensureProjectLocalNulliusLauncher(projectRoot);
    } finally {
      Object.defineProperty(process, 'execPath', descriptor);
    }

    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
    expect(fs.readFileSync(launcherPath, 'utf-8')).toContain(batchLiteral(percentNode));
    const output = runBatch(launcherPath, {
      ...process.env,
      PATH: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
      NULLIUS_EMBEDDED_PATH: 'EXPANDED_AND_WRONG',
    }, 'status', '--json');
    expect(JSON.parse(output)).toMatchObject({ run_status: 'idle' });
  });

  windowsIt('isolates protocol capture across concurrent launcher processes', async () => {
    const parent = tempRoot('nullius-windows-concurrent-probe-');
    const projectRoot = path.join(parent, 'project');
    expect(await runCli(
      [`--project-root=${projectRoot}`, 'init', '--runtime-only'],
      makeIo(parent).io,
    )).toBe(0);

    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
    const slowCli = path.join(parent, 'slow-cli.mjs');
    fs.writeFileSync(slowCli, [
      "const args = process.argv.slice(2);",
      "if (args.includes('--launcher-protocol')) {",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);",
      "  process.stdout.write('nullius-launcher-protocol 2\\n');",
      "} else {",
      "  process.stdout.write('{\"run_status\":\"idle\"}\\n');",
      "}",
      '',
    ].join('\n'), 'utf-8');
    const original = fs.readFileSync(launcherPath, 'utf-8');
    fs.writeFileSync(
      launcherPath,
      replaceBakedArgv(original, [process.execPath, slowCli]),
      'utf-8',
    );

    // An explicit RANDOM variable makes every cmd.exe start with the same two
    // values. The exclusive probe directory plus retry suffix must still let
    // all overlapping launches complete without sharing an output file.
    const env = { ...process.env, RANDOM: '7' };
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () => runBatchAsync(launcherPath, env, 'status', '--json')),
    );
    expect(outputs.map(output => JSON.parse(output).run_status)).toEqual(
      Array.from({ length: 8 }, () => 'idle'),
    );
  });
});
