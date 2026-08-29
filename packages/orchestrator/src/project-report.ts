import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPythonRuntime } from './python-runtime.js';

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
  const python = defaultPythonRuntime();
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
