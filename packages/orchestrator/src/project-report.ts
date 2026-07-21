import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type ReportIo = {
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

function projectContractsEnv(): NodeJS.ProcessEnv {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const addition = path.resolve(moduleDir, '../../project-contracts/src');
  const existing = process.env.PYTHONPATH?.trim();
  return {
    ...process.env,
    PYTHONPATH: existing ? `${addition}${path.delimiter}${existing}` : addition,
  };
}

export function runReportValidateCommand(projectRoot: string, io: ReportIo): number {
  const python = process.env.NULLIUS_PYTHON || 'python3';
  const result = spawnSync(
    python,
    ['-m', 'project_contracts.main_research_report_cli', '--project-root', projectRoot],
    { encoding: 'utf-8', env: projectContractsEnv() },
  );
  if (result.error) throw new Error(`failed to launch main research report validator: ${result.error.message}`);
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  return result.status ?? 2;
}
