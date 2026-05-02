import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';
import { runCli } from '../src/cli.js';
import { ensureProjectScaffold } from '../src/project-scaffold.js';

const CANONICAL_SCAFFOLD_FILES = [
  'AGENTS.md',
  'project_charter.md',
  'project_index.md',
  'research_plan.md',
  'research_notebook.md',
  'research_contract.md',
  'docs/APPROVAL_GATES.md',
  'docs/ARTIFACT_CONTRACT.md',
  'docs/EVAL_GATE_CONTRACT.md',
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

describe('autoresearch CLI init/export', () => {
  it('rejects repo-internal init before writing runtime state', async () => {
    const projectRoot = path.join(process.cwd(), '.tmp', `repo-internal-init-denied-${Date.now()}`);

    await expect(runCli([`--project-root=${projectRoot}`, 'init'], makeIo(process.cwd()).io)).rejects.toThrow(
      'project root must resolve outside the autoresearch-lab dev repo for real projects',
    );

    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  it('applies real-project policy before runtime-only init writes state', async () => {
    const projectRoot = path.join(process.cwd(), '.tmp', `repo-internal-runtime-only-denied-${Date.now()}`);

    await expect(runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(process.cwd()).io)).rejects.toThrow(
      'project root must resolve outside the autoresearch-lab dev repo for real projects',
    );

    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  it('initializes a real project root with the neutral scaffold', async () => {
    const parentDir = makeTempDir('autoresearch-cli-parent-');
    const projectRoot = path.join(parentDir, 'project-root');
    const { io, stdout } = makeIo(parentDir);

    const code = await runCli([`--project-root=${projectRoot}`, 'init'], io);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('[ok] runtime dir:');
    expect(fs.existsSync(path.join(projectRoot, '.autoresearch', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.autoresearch', 'approval_policy.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.autoresearch', '.initialized'))).toBe(true);
    const launcherPath = path.join(projectRoot, '.autoresearch', 'bin', 'autoresearch');
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
          canonical: 'autoresearch status --json',
          project_local_fallback: '.autoresearch/bin/autoresearch status --json',
        },
        recommended_files: [
          'project_index.md',
          'AGENTS.md',
          'project_charter.md',
          'research_plan.md',
          'research_contract.md',
          'research_notebook.md',
        ],
      },
    });
  });

  it('calls the project-contracts scaffold authority without a variant argument', () => {
    const parentDir = makeTempDir('autoresearch-scaffold-spawn-');
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
    const previous = process.env.AUTORESEARCH_PYTHON;
    process.env.AUTORESEARCH_PYTHON = fakePython;
    try {
      ensureProjectScaffold(projectRoot);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTORESEARCH_PYTHON;
      } else {
        process.env.AUTORESEARCH_PYTHON = previous;
      }
    }

    const argv = fs.readFileSync(argvLog, 'utf-8').trim().split('\n');
    expect(argv).not.toContain('--' + 'variant');
    expect(argv).not.toContain('minimal');
  });

  it('writes the project-local fallback launcher even for runtime-only init', async () => {
    const parentDir = makeTempDir('autoresearch-cli-runtime-only-');
    const projectRoot = path.join(parentDir, 'project-root');
    const { io } = makeIo(parentDir);

    const code = await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], io);

    expect(code).toBe(0);
    const launcherPath = path.join(projectRoot, '.autoresearch', 'bin', 'autoresearch');
    expect(fs.existsSync(launcherPath)).toBe(true);
    const launcherScript = fs.readFileSync(launcherPath, 'utf-8');
    expect(launcherScript).toContain('project-local autoresearch launcher target is missing');
    expect(launcherScript).toContain('autoresearch init --runtime-only');
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
          canonical: 'autoresearch status --json',
          project_local_fallback: '.autoresearch/bin/autoresearch status --json',
        },
        recommended_files: [],
      },
    });
    expect(payload.recovery_context.derivation_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECOVERY_GUIDANCE_FILES_UNAVAILABLE' }),
    ]));
  });

  it('exports run artifacts and optional kb profile files into a zip bundle', async () => {
    const projectRoot = makeTempDir('autoresearch-cli-export-');
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
    const projectRoot = makeTempDir('autoresearch-cli-export-empty-');
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
