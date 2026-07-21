import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { renderHelp } from '../src/cli-help.js';


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


describe('nullius report-validate', () => {
  it('fails closed when no main research report is promoted', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-report-'));
    fs.writeFileSync(
      path.join(projectRoot, 'project_index.md'),
      [
        '# project_index.md',
        '<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->',
        '- Current report ID: `(none yet)`',
        '- Current report: `(none yet)`',
        '| Report ID | Report | SHA-256 | Supersedes | Superseded by |',
        '|---|---|---|---|---|',
        '<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->',
        '',
      ].join('\n'),
      'utf-8',
    );
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([`--project-root=${projectRoot}`, 'report-validate'], io);
    const result = JSON.parse(stdout.join('')) as { status: string; errors: Array<{ code: string }> };

    expect(code).toBe(3);
    expect(result.status).toBe('fail');
    expect(result.errors.map(item => item.code)).toContain('no_current_report');
  });

  it('documents the structural and judgment boundary', () => {
    const help = renderHelp('report-validate');
    expect(help).toContain('same implementation plus same input');
    expect(help).toContain('Environment differences do not make that replay independent.');
    expect(help).toContain('authoring instructions');
    expect(help).toContain('Report and registry structure counts only when it is visible Markdown;');
    expect(help).toContain('fields must occur exactly once in their authoritative section.');
    expect(help).toContain('A pass does not establish scientific sufficiency.');
  });

  it('documents the fail-closed existing-project migration boundary', () => {
    const help = renderHelp('init');
    expect(help).toContain('Existing-project main-report migration:');
    expect(help).toContain('separate temporary external root');
    expect(help).toContain('Refresh does not perform either step.');
    expect(help).toContain('invalid_registry_markers');
    expect(help).toContain('no_current_report');
  });
});
