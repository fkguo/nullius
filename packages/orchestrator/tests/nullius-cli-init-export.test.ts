import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';
import { runCli } from '../src/cli.js';
import { readProjectLocalNulliusLauncherHealth } from '../src/project-local-nullius.js';
import { ensureProjectScaffold } from '../src/project-scaffold.js';

const CANONICAL_SCAFFOLD_FILES = [
  'AGENTS.md',
  'project_charter.md',
  'project_index.md',
  'research_plan.md',
  'research_notebook.md',
  'research_contract.md',
] as const;

const ABSENT_DEFAULT_SURFACES = [
  '.mcp.template.json',
  'specs/plan.schema.json',
  'research_preflight.md',
  'project_brief.md',
  'idea_log.md',
  'prompts',
  'team',
  'research_team_config.json',
  '.hep',
  'knowledge_base',
] as const;

const TOO_SPECIFIC_SCAFFOLD_TOKENS = [
  'INSPIRE recid',
  'Citekey',
  'research_team_config.json',
  'idea_log.md',
  'Fourier convention',
  'physical interpretation',
  'linear response',
  'path integral',
  'perturbation theory',
  'propagators',
  'vertices',
  'LO/NLO',
  'power counting',
  'Julia',
  'numpy',
  'scipy',
  'KB delta',
  'knowledge_base/methodology_traces',
  'team packet',
  '~/.codex/skills/research-team',
] as const;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

describe('nullius CLI init/export', () => {
  it('rejects repo-internal init before writing runtime state', async () => {
    const projectRoot = path.join(process.cwd(), '.tmp', `repo-internal-init-denied-${Date.now()}`);

    await expect(runCli([`--project-root=${projectRoot}`, 'init'], makeIo(process.cwd()).io)).rejects.toThrow(
      'project root must resolve outside the nullius dev repo for real projects',
    );

    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  it('applies real-project policy before runtime-only init writes state', async () => {
    const projectRoot = path.join(process.cwd(), '.tmp', `repo-internal-runtime-only-denied-${Date.now()}`);

    await expect(runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(process.cwd()).io)).rejects.toThrow(
      'project root must resolve outside the nullius dev repo for real projects',
    );

    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  it('initializes a real project root with the neutral scaffold', async () => {
    const parentDir = makeTempDir('nullius-cli-parent-');
    const projectRoot = path.join(parentDir, 'project-root');
    const { io, stdout } = makeIo(parentDir);

    const code = await runCli([`--project-root=${projectRoot}`, 'init'], io);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('[ok] runtime dir:');
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'approval_policy.json'))).toBe(true);
    // A3 (compute_runs) is opt-out by default; A1/A2/A4 advisory + A5 stay on.
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, '.nullius', 'approval_policy.json'), 'utf-8'))).toMatchObject({
      require_approval_for: { mass_search: true, code_changes: true, compute_runs: false, paper_edits: true, final_conclusions: true },
    });
    expect(fs.existsSync(path.join(projectRoot, '.nullius', '.initialized'))).toBe(true);
    const harnessPath = path.join(projectRoot, '.nullius', 'HARNESS');
    expect(fs.existsSync(harnessPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(harnessPath, 'utf-8'))).toMatchObject({
      schema_version: 1,
      kind: 'nullius_project_harness',
      status_receipt_required: true,
      project_local_status_command: '.nullius/bin/nullius status --json',
      fallback_status_command: 'nullius status --json',
      host_skill: 'research-harness',
      lifecycle_authority: 'nullius',
      milestone_executor: 'research-team',
    });
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');
    expect(fs.existsSync(launcherPath)).toBe(true);
    expect((fs.statSync(launcherPath).mode & 0o111) !== 0).toBe(true);
    for (const rel of CANONICAL_SCAFFOLD_FILES) {
      expect(fs.existsSync(path.join(projectRoot, rel))).toBe(true);
    }
    for (const rel of ABSENT_DEFAULT_SURFACES) {
      expect(fs.existsSync(path.join(projectRoot, rel))).toBe(false);
    }
    const generatedText = CANONICAL_SCAFFOLD_FILES
      .map(rel => fs.readFileSync(path.join(projectRoot, rel), 'utf-8'))
      .join('\n');
    expect(generatedText).toContain('Source notebook: [research_notebook.md](research_notebook.md)');
    for (const token of TOO_SPECIFIC_SCAFFOLD_TOKENS) {
      expect(generatedText).not.toContain(token);
    }

    const statusJson = execFileSync(launcherPath, ['status', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
      },
    });
    expect(JSON.parse(statusJson)).toMatchObject({
      run_status: 'idle',
      recovery_context: {
        status_commands: {
          canonical: 'nullius status --json',
          project_local_fallback: '.nullius/bin/nullius status --json',
          harness_entrypoint: '.nullius/bin/nullius status --json',
        },
        control_files: {
          harness: {
            path: '.nullius/HARNESS',
            exists: true,
            valid: true,
          },
        },
        recommended_files: [
          'project_index.md',
          'AGENTS.md',
          'project_charter.md',
          'research_plan.md',
          'research_contract.md',
        ],
      },
    });
  });

  it('calls the project-contracts scaffold authority without a variant argument', () => {
    const parentDir = makeTempDir('nullius-scaffold-spawn-');
    const projectRoot = path.join(parentDir, 'project-root');
    const argvLog = path.join(parentDir, 'argv.log');
    const fakePython = path.join(parentDir, 'fake-python.sh');
    fs.writeFileSync(
      fakePython,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
        'printf \'{"created":[],"skipped":[]}\\n\'',
      ].join('\n') + '\n',
      'utf-8',
    );
    fs.chmodSync(fakePython, 0o755);
    const previous = process.env.NULLIUS_PYTHON;
    process.env.NULLIUS_PYTHON = fakePython;
    try {
      ensureProjectScaffold(projectRoot);
    } finally {
      if (previous === undefined) {
        delete process.env.NULLIUS_PYTHON;
      } else {
        process.env.NULLIUS_PYTHON = previous;
      }
    }

    const argv = fs.readFileSync(argvLog, 'utf-8').trim().split('\n');
    expect(argv).not.toContain('--' + 'variant');
    expect(argv).not.toContain('minimal');
  });

  it('writes the project-local fallback launcher even for runtime-only init', async () => {
    const parentDir = makeTempDir('nullius-cli-runtime-only-');
    const projectRoot = path.join(parentDir, 'project-root');
    const { io } = makeIo(parentDir);

    const code = await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], io);

    expect(code).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');
    expect(fs.existsSync(launcherPath)).toBe(true);
    const harnessPath = path.join(projectRoot, '.nullius', 'HARNESS');
    expect(fs.existsSync(harnessPath)).toBe(true);
    const launcherScript = fs.readFileSync(launcherPath, 'utf-8');
    // Portable launcher: self-derives the project root and prefers an nullius
    // on PATH — but never itself — so the project works on another machine.
    expect(launcherScript).toContain('PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)');
    expect(launcherScript).toContain('command -v nullius');
    expect(launcherScript).toContain('-ef "$0"');
    expect(launcherScript).toContain('exec "$RESOLVED_NULLIUS" --launcher-generation=2 --project-root "$PROJECT_ROOT" "$@"');
    expect(launcherScript).toContain('--launcher-protocol');
    expect(launcherScript).not.toContain("PROJECT_ROOT='");
    expect(launcherScript).toContain('nullius init --runtime-only');
    expect(fs.existsSync(path.join(projectRoot, 'project_charter.md'))).toBe(false);

    const statusJson = execFileSync(launcherPath, ['status', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
      },
    });
    const payload = JSON.parse(statusJson);
    expect(payload).toMatchObject({
      run_status: 'idle',
      recovery_context: {
        status_commands: {
          canonical: 'nullius status --json',
          project_local_fallback: '.nullius/bin/nullius status --json',
          harness_entrypoint: '.nullius/bin/nullius status --json',
        },
        control_files: {
          harness: {
            path: '.nullius/HARNESS',
            exists: true,
            valid: true,
          },
        },
        recommended_files: [],
      },
    });
    expect(payload.recovery_context.derivation_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECOVERY_GUIDANCE_FILES_UNAVAILABLE' }),
    ]));
  });

  it('answers the launcher-protocol handshake with the exact banner', async () => {
    const { io, stdout } = makeIo(process.cwd());
    expect(await runCli(['--launcher-protocol'], io)).toBe(0);
    expect(stdout.join('')).toBe('nullius-launcher-protocol 2\n');
  });

  it('prefers the baked CLI and gates PATH fallback on the protocol handshake', async () => {
    const parentDir = makeTempDir('nullius-cli-protocol-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(parentDir).io)).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');

    // An impostor on PATH that answers commands but NOT the handshake (the
    // shape of an older-generation CLI whose root handling differs). It logs
    // every argv line it ever receives.
    const impostorDir = path.join(parentDir, 'impostorbin');
    fs.mkdirSync(impostorDir, { recursive: true });
    const impostorLog = path.join(parentDir, 'impostor-argv.log');
    fs.writeFileSync(
      path.join(impostorDir, 'nullius'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${impostorLog}\nexit 0\n`,
      'utf-8',
    );
    fs.chmodSync(path.join(impostorDir, 'nullius'), 0o755);
    const pathWithImpostor = `${impostorDir}${path.delimiter}/usr/bin:/bin`;

    // 1) Baked target present: the launcher execs the baked CLI and never
    //    consults the impostor at all.
    const statusJson = execFileSync(launcherPath, ['status', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, PATH: pathWithImpostor },
    });
    expect(JSON.parse(statusJson).run_status).toBe('idle');
    expect(fs.existsSync(impostorLog)).toBe(false);

    // 2) Baked target unavailable + non-protocol PATH candidate: the launcher
    //    refuses (exit 127) instead of executing a parser whose root handling
    //    it cannot trust — no cross-root write is possible.
    const script = fs.readFileSync(launcherPath, 'utf-8');
    const brokenScript = script.replaceAll('/dist/cli.js', '/dist/cli.js.gone');
    fs.writeFileSync(launcherPath, brokenScript, 'utf-8');
    fs.chmodSync(launcherPath, 0o755);
    let failed: { status: number | null } | null = null;
    try {
      execFileSync(launcherPath, ['status', '--json'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 20000,
        env: { ...process.env, PATH: pathWithImpostor },
      });
    } catch (error) {
      failed = error as { status: number | null };
    }
    expect(failed?.status).toBe(127);
    // The impostor was consulted only for the handshake probe — it never
    // received a real command, so no cross-root write was possible.
    const probeLines = fs.readFileSync(impostorLog, 'utf-8').split('\n').filter(line => line.length > 0);
    expect(new Set(probeLines)).toEqual(new Set(['--launcher-generation=2', '--launcher-protocol']));

    // 3) Baked target unavailable + protocol-answering PATH candidate: used,
    //    with the trusted root PREPENDED before user args.
    const argvLog = path.join(parentDir, 'protocol-argv.log');
    fs.writeFileSync(
      path.join(impostorDir, 'nullius'),
      [
        '#!/bin/sh',
        'if [ "${2:-}" = "--launcher-protocol" ] || [ "${1:-}" = "--launcher-protocol" ]; then',
        "  printf '%s\\n' 'nullius-launcher-protocol 2'",
        '  exit 0',
        'fi',
        `printf '%s\\n' "$@" > ${argvLog}`,
        'exit 0',
      ].join('\n') + '\n',
      'utf-8',
    );
    fs.chmodSync(path.join(impostorDir, 'nullius'), 0o755);
    execFileSync(launcherPath, ['status', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, PATH: pathWithImpostor },
    });
    const argvLines = fs.readFileSync(argvLog, 'utf-8').split('\n');
    expect(argvLines[0]).toBe('--launcher-generation=2');
    expect(argvLines[1]).toBe('--project-root');
    expect(argvLines[2]).toBe(projectRoot);
    expect(argvLines[3]).toBe('status');
  }, 30000);

  it('fails closed at dispatch when the probe passed but the parser generation is old', async () => {
    const parentDir = makeTempDir('nullius-cli-genswap-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(parentDir).io)).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');

    // The swap-after-probe / mixed-build shape: the target ANSWERS the
    // protocol probe, but its actual parser is an older generation that does
    // not know the in-dispatch token (it errors like any unknown argument).
    const trickLog = path.join(parentDir, 'trick-argv.log');
    const trickCli = path.join(parentDir, 'trick-cli.js');
    fs.writeFileSync(trickCli, [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(trickLog)}, process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv.includes('--launcher-protocol')) { console.log('nullius-launcher-protocol 2'); process.exit(0); }",
      "if (process.argv.some(arg => arg.startsWith('--launcher-generation='))) { console.error('unknown argument: --launcher-generation=2'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n') + '\n', 'utf-8');
    const script = fs.readFileSync(launcherPath, 'utf-8');
    const cliMatch = script.match(/'(\/[^']*dist\/cli\.js)'/u);
    expect(cliMatch).not.toBeNull();
    fs.writeFileSync(launcherPath, script.replaceAll(cliMatch![1]!, trickCli), 'utf-8');
    fs.chmodSync(launcherPath, 0o755);

    let failed: { status: number | null } | null = null;
    try {
      execFileSync(launcherPath, ['status', '--json'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 20000,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      });
    } catch (error) {
      failed = error as { status: number | null };
    }
    // The dispatch itself carried the generation token, so the old parser
    // failed closed instead of proceeding with different root semantics.
    expect(failed?.status).toBe(2);
    const dispatchLines = fs.readFileSync(trickLog, 'utf-8').split('\n').filter(line => line.length > 0);
    expect(dispatchLines.some(line => line.includes('--launcher-generation=2'))).toBe(true);
  }, 30000);

  it('strips the generation token in the current parser and rejects a mismatch', async () => {
    const parentDir = makeTempDir('nullius-cli-gen-token-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(parentDir).io)).toBe(0);

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli(['--launcher-generation=2', `--project-root=${projectRoot}`, 'status', '--json'], io)).toBe(0);
    expect((JSON.parse(stdout.join('')) as { run_status: string }).run_status).toBe('idle');

    await expect(
      runCli(['--launcher-generation=1', `--project-root=${projectRoot}`, 'status'], makeIo(projectRoot).io),
    ).rejects.toThrow('launcher generation mismatch');
  });

  it('refuses a present-but-older-generation baked target instead of trusting it with the root', async () => {
    const parentDir = makeTempDir('nullius-cli-stale-baked-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(parentDir).io)).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');

    // A baked target that EXISTS and answers commands, but speaks the WRONG
    // protocol generation (the shape of a checkout rebuilt to an older
    // commit). It logs every argv it receives.
    const staleLog = path.join(parentDir, 'stale-argv.log');
    const staleCli = path.join(parentDir, 'stale-cli.js');
    fs.writeFileSync(staleCli, [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(staleLog)}, process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv.includes('--launcher-protocol')) { console.log('nullius-launcher-protocol 1'); process.exit(0); }",
      'process.exit(0);',
    ].join('\n') + '\n', 'utf-8');
    const script = fs.readFileSync(launcherPath, 'utf-8');
    const cliMatch = script.match(/'(\/[^']*dist\/cli\.js)'/u);
    expect(cliMatch).not.toBeNull();
    fs.writeFileSync(launcherPath, script.replaceAll(cliMatch![1]!, staleCli), 'utf-8');
    fs.chmodSync(launcherPath, 0o755);

    let failed: { status: number | null } | null = null;
    try {
      execFileSync(launcherPath, ['status', '--json'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 20000,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      });
    } catch (error) {
      failed = error as { status: number | null };
    }
    // Refused outright: the stale parser is never trusted with the root, and
    // it only ever saw the handshake probe.
    expect(failed?.status).toBe(127);
    const staleLines = fs.readFileSync(staleLog, 'utf-8').split('\n').filter(line => line.length > 0);
    expect(new Set(staleLines)).toEqual(new Set(['--launcher-generation=2 --launcher-protocol']));
  }, 30000);

  it('reports a mixed-generation baked target as incompatible in launcher health', async () => {
    const parentDir = makeTempDir('nullius-cli-mixed-health-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(parentDir).io)).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');

    // Old-parser shape: it errors on the generation token BEFORE anything
    // else — exactly what a stale cli-args module does. The token-carrying
    // probe therefore fails, so health cannot advertise it.
    const oldParserCli = path.join(parentDir, 'old-parser-cli.js');
    fs.writeFileSync(oldParserCli, [
      "if (process.argv.some(arg => arg.startsWith('--launcher-generation='))) { console.error('unknown argument'); process.exit(2); }",
      "if (process.argv.includes('--launcher-protocol')) { console.log('nullius-launcher-protocol 2'); process.exit(0); }",
      'process.exit(0);',
    ].join('\n') + '\n', 'utf-8');
    const script = fs.readFileSync(launcherPath, 'utf-8');
    const cliMatch = script.match(/'(\/[^']*dist\/cli\.js)'/u);
    expect(cliMatch).not.toBeNull();
    fs.writeFileSync(launcherPath, script.replaceAll(cliMatch![1]!, oldParserCli), 'utf-8');
    fs.chmodSync(launcherPath, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const health = readProjectLocalNulliusLauncherHealth(projectRoot);
      expect(health.healthy).toBe(false);
      expect(health.issue_code).toBe('PROJECT_LOCAL_LAUNCHER_TARGET_INCOMPATIBLE');
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it('never advertises a cwd-relative PATH candidate the launcher guard would reject', async () => {
    const parentDir = makeTempDir('nullius-cli-empty-path-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(parentDir).io)).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');

    // Break the baked target so health must consult PATH; put a
    // protocol-answering nullius reachable only through the EMPTY leading
    // PATH component (cwd). The launcher's runtime guard accepts only an
    // ABSOLUTE regular file from command -v, so health must not advertise
    // this candidate either — health mirrors the runtime authority.
    const script = fs.readFileSync(launcherPath, 'utf-8');
    fs.writeFileSync(launcherPath, script.replaceAll('/dist/cli.js', '/dist/cli.js.gone'), 'utf-8');
    fs.chmodSync(launcherPath, 0o755);
    const cwdDir = path.join(parentDir, 'cwdbin');
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.writeFileSync(path.join(cwdDir, 'nullius'), [
      '#!/bin/sh',
      'if [ "${2:-}" = "--launcher-protocol" ] || [ "${1:-}" = "--launcher-protocol" ]; then',
      "  printf '%s\\n' 'nullius-launcher-protocol 2'",
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n', 'utf-8');
    fs.chmodSync(path.join(cwdDir, 'nullius'), 0o755);

    const prevPath = process.env.PATH;
    const prevCwd = process.cwd();
    process.env.PATH = `${path.delimiter}/usr/bin:/bin`;
    try {
      process.chdir(cwdDir);
      const health = readProjectLocalNulliusLauncherHealth(projectRoot);
      expect(health.healthy).toBe(false);
      expect(health.issue_code).toBe('PROJECT_LOCAL_LAUNCHER_TARGET_MISSING');
    } finally {
      process.chdir(prevCwd);
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it('detects its own bin dir on PATH and falls back to the baked CLI without recursing', async () => {
    const parentDir = makeTempDir('nullius-cli-self-path-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);
    const binDir = path.join(projectRoot, '.nullius', 'bin');
    const launcherPath = path.join(binDir, 'nullius');
    // Put the launcher's own dir first on PATH: the self-resolution guard must skip
    // itself and fall through to the baked CLI instead of recursing forever. The
    // 20s timeout fails the test (rather than hanging) if recursion regresses.
    const statusJson = execFileSync(launcherPath, ['status', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}/usr/bin:/bin` },
    });
    expect(JSON.parse(statusJson).run_status).toBe('idle');
  });

  it('treats a PATH symlink back to the launcher as itself and does not self-hop', async () => {
    const parentDir = makeTempDir('nullius-cli-symlink-path-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);
    const launcherPath = path.join(projectRoot, '.nullius', 'bin', 'nullius');
    // A symlink named `nullius` on PATH pointing back to the launcher must be
    // recognized as the launcher itself (real file identity via -ef), not exec'd as
    // an external CLI — otherwise it self-hops and appends a wrong --project-root.
    const symDir = path.join(parentDir, 'symbin');
    fs.mkdirSync(symDir, { recursive: true });
    fs.symlinkSync(launcherPath, path.join(symDir, 'nullius'));
    const statusJson = execFileSync(launcherPath, ['status', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, PATH: `${symDir}${path.delimiter}/usr/bin:/bin` },
    });
    const payload = JSON.parse(statusJson);
    expect(payload.run_status).toBe('idle');
    // Correct project root used: the real project's HARNESS is present. A self-hop
    // would have derived the wrong root (the symlink's parent), where no HARNESS exists.
    expect(payload.recovery_context.control_files.harness.exists).toBe(true);
  });

  it('exports run artifacts and optional kb profile files into a zip bundle', async () => {
    const projectRoot = makeTempDir('nullius-cli-export-');
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M1';
    state.workflow_id = 'ingest';
    manager.saveState(state);

    const artifactFile = path.join(projectRoot, 'artifacts', 'runs', 'M1', 'result.txt');
    const teamFile = path.join(projectRoot, 'team', 'runs', 'M1', 'summary.md');
    const kbFile = path.join(projectRoot, 'knowledge_base', 'literature', 'paper.md');
    const kbProfilePath = path.join(projectRoot, 'artifacts', 'runs', 'M1', 'kb_profile', 'kb_profile.json');
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
    fs.mkdirSync(path.dirname(teamFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbProfilePath), { recursive: true });
    fs.writeFileSync(artifactFile, 'artifact\n', 'utf-8');
    fs.writeFileSync(teamFile, 'team\n', 'utf-8');
    fs.writeFileSync(kbFile, 'kb\n', 'utf-8');
    fs.writeFileSync(
      kbProfilePath,
      JSON.stringify({ kb_index_path: 'knowledge_base/literature/paper.md', selected: [{ path: 'knowledge_base/literature/paper.md' }] }, null, 2),
      'utf-8',
    );

    const outPath = path.join(projectRoot, 'exports', 'bundle.zip');
    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['export', '--out', outPath, '--include-kb-profile'], io);

    expect(code).toBe(0);
    const output = stdout.join('');
    expect(output).toContain(`[ok] wrote: ${outPath}`);
    expect(output).not.toContain('Export summary generated');
    expect(output).not.toContain('no files copied');
    const archiveListing = execFileSync('unzip', ['-Z', '-1', outPath], { encoding: 'utf-8' }).trim().split('\n');
    expect(archiveListing).toContain('artifacts/runs/M1/result.txt');
    expect(archiveListing).toContain('team/runs/M1/summary.md');
    expect(archiveListing).toContain('knowledge_base/literature/paper.md');
  });

  it('fails closed when no exportable files exist for the requested run', async () => {
    const projectRoot = makeTempDir('nullius-cli-export-empty-');
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-EMPTY';
    state.workflow_id = 'ingest';
    manager.saveState(state);

    const outPath = path.join(projectRoot, 'exports', 'empty.zip');

    await expect(runCli(['export', '--out', outPath], makeIo(projectRoot).io)).rejects.toThrow(
      'EXPORT_PAYLOAD_UNAVAILABLE: no exportable files were found for run M-EMPTY',
    );
    expect(fs.existsSync(outPath)).toBe(false);
  });
});

describe('nullius CLI init --refresh', () => {
  it('refreshes changed managed docs with a backup and preserves user seed files', async () => {
    const parentDir = makeTempDir('nullius-cli-refresh-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);

    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    const planPath = path.join(projectRoot, 'research_plan.md');
    fs.writeFileSync(agentsPath, 'HACKED AGENTS\n', 'utf-8');
    const userPlan = '# research_plan.md\n\nUSER RESEARCH CONTENT\n'.repeat(20);
    fs.writeFileSync(planPath, userPlan, 'utf-8');

    const { io, stdout } = makeIo(parentDir);
    const code = await runCli([`--project-root=${projectRoot}`, 'init', '--refresh'], io);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('scaffold refresh');
    expect(out).toContain('refreshed: AGENTS.md');
    expect(out).toContain('backed up');
    const agentsNow = fs.readFileSync(agentsPath, 'utf-8');
    expect(agentsNow).toContain('This file anchors the workflow');
    expect(agentsNow).not.toContain('HACKED');
    expect(fs.readFileSync(planPath, 'utf-8')).toBe(userPlan);

    const backupsDir = path.join(projectRoot, '.nullius', 'backups');
    expect(fs.existsSync(backupsDir)).toBe(true);
    const stamp = fs.readdirSync(backupsDir)[0]!;
    expect(fs.readFileSync(path.join(backupsDir, stamp, 'AGENTS.md'), 'utf-8')).toBe('HACKED AGENTS\n');
  });

  it('--refresh --dry-run previews without writing anything', async () => {
    const parentDir = makeTempDir('nullius-cli-refresh-dry-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);

    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    fs.writeFileSync(agentsPath, 'HACKED AGENTS\n', 'utf-8');

    const { io, stdout } = makeIo(parentDir);
    const code = await runCli([`--project-root=${projectRoot}`, 'init', '--refresh', '--dry-run'], io);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('--dry-run, no files written');
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe('HACKED AGENTS\n');
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'backups'))).toBe(false);
  });

  it('--refresh --dry-run on an uninitialized root writes nothing at all', async () => {
    const parentDir = makeTempDir('nullius-cli-refresh-dry-fresh-');
    const projectRoot = path.join(parentDir, 'project-root');

    const code = await runCli([`--project-root=${projectRoot}`, 'init', '--refresh', '--dry-run'], makeIo(parentDir).io);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, '.nullius'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'artifacts'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'docs'))).toBe(false);
  });

  it('rejects --refresh --force before writing runtime state', async () => {
    const parentDir = makeTempDir('nullius-cli-refresh-force-');
    const projectRoot = path.join(parentDir, 'project-root');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'init', '--refresh', '--force'], makeIo(parentDir).io),
    ).rejects.toThrow('choose either --refresh or --force');
    expect(fs.existsSync(path.join(projectRoot, '.nullius'))).toBe(false);
  });

  it('rejects --refresh --runtime-only before writing runtime state', async () => {
    const parentDir = makeTempDir('nullius-cli-refresh-runtime-');
    const projectRoot = path.join(parentDir, 'project-root');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'init', '--refresh', '--runtime-only'], makeIo(parentDir).io),
    ).rejects.toThrow('--refresh cannot be combined with --runtime-only');
    expect(fs.existsSync(path.join(projectRoot, '.nullius'))).toBe(false);
  });

  it('rejects --dry-run without --refresh before writing runtime state', async () => {
    const parentDir = makeTempDir('nullius-cli-dry-only-');
    const projectRoot = path.join(parentDir, 'project-root');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'init', '--dry-run'], makeIo(parentDir).io),
    ).rejects.toThrow('--dry-run is only valid together with --refresh');
    expect(fs.existsSync(path.join(projectRoot, '.nullius'))).toBe(false);
  });

  it('threads --refresh and --dry-run to the scaffold authority and parses the enriched result', () => {
    const parentDir = makeTempDir('nullius-scaffold-refresh-spawn-');
    const projectRoot = path.join(parentDir, 'project-root');
    const argvLog = path.join(parentDir, 'argv.log');
    const fakePython = path.join(parentDir, 'fake-python.sh');
    fs.writeFileSync(
      fakePython,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
        'printf \'{"created":[],"skipped":[],"refreshed":["AGENTS.md"],"backed_up":["AGENTS.md"],"unchanged":[],"preserved":["research_plan.md"],"missing":[],"backup_dir":".nullius/backups/X","dry_run":true}\\n\'',
      ].join('\n') + '\n',
      'utf-8',
    );
    fs.chmodSync(fakePython, 0o755);
    const previous = process.env.NULLIUS_PYTHON;
    process.env.NULLIUS_PYTHON = fakePython;
    let result: ReturnType<typeof ensureProjectScaffold>;
    try {
      result = ensureProjectScaffold(projectRoot, { refresh: true, dryRun: true });
    } finally {
      if (previous === undefined) delete process.env.NULLIUS_PYTHON;
      else process.env.NULLIUS_PYTHON = previous;
    }

    const argv = fs.readFileSync(argvLog, 'utf-8').trim().split('\n');
    expect(argv).toContain('--refresh');
    expect(argv).toContain('--dry-run');
    expect(result.refreshed).toEqual(['AGENTS.md']);
    expect(result.backedUp).toEqual(['AGENTS.md']);
    expect(result.preserved).toEqual(['research_plan.md']);
    expect(result.backupDir).toBe('.nullius/backups/X');
    expect(result.dryRun).toBe(true);
  });
});
