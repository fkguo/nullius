import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';


function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}


function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    io: {
      cwd,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}


describe('main research report scaffold migration', () => {
  it('creates the report template for a fresh external project', async () => {
    const parentDir = makeTempDir('nullius-cli-report-template-');
    const projectRoot = path.join(parentDir, 'project-root');

    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);

    expect(fs.existsSync(path.join(projectRoot, 'reports', 'main_research_report_template.md'))).toBe(true);
  });

  it('--refresh reports a missing user-owned report template without creating it', async () => {
    const parentDir = makeTempDir('nullius-cli-refresh-report-migration-');
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);
    const templatePath = path.join(projectRoot, 'reports', 'main_research_report_template.md');
    fs.unlinkSync(templatePath);

    const { io, stdout } = makeIo(parentDir);
    const code = await runCli([`--project-root=${projectRoot}`, 'init', '--refresh'], io);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(
      'missing (user-owned; migrate explicitly, refresh will not create): reports/main_research_report_template.md',
    );
    expect(fs.existsSync(templatePath)).toBe(false);
  });
});
