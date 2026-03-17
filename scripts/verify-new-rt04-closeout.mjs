import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const coldArtifacts = [
  'packages/shared/dist',
  'packages/shared/tsconfig.tsbuildinfo',
  'packages/orchestrator/dist',
  'packages/orchestrator/tsconfig.tsbuildinfo',
  'packages/zotero-mcp/dist',
  'packages/zotero-mcp/tsconfig.tsbuildinfo',
  'packages/pdg-mcp/dist',
  'packages/pdg-mcp/tsconfig.tsbuildinfo',
  'packages/arxiv-mcp/dist',
  'packages/arxiv-mcp/tsconfig.tsbuildinfo',
  'packages/openalex-mcp/dist',
  'packages/openalex-mcp/tsconfig.tsbuildinfo',
  'packages/hepdata-mcp/dist',
  'packages/hepdata-mcp/tsconfig.tsbuildinfo',
  'packages/hep-mcp/dist',
  'packages/hep-mcp/tsconfig.tsbuildinfo',
];

const steps = [
  ['pnpm', ['--filter', '@autoresearch/shared', 'build']],
  ['pnpm', ['--filter', '@autoresearch/orchestrator', 'build']],
  ['pnpm', ['--filter', '@autoresearch/zotero-mcp', 'build']],
  ['pnpm', ['--filter', '@autoresearch/pdg-mcp', 'build']],
  ['pnpm', ['--filter', '@autoresearch/arxiv-mcp', 'build']],
  ['pnpm', ['--filter', '@autoresearch/openalex-mcp', 'build']],
  ['pnpm', ['--filter', '@autoresearch/hepdata-mcp', 'build']],
  ['pnpm', ['--filter', '@autoresearch/hep-mcp', 'test', '--',
    'tests/contracts/sharedOrchestratorPackageExports.test.ts',
    'tests/contracts/orchRunExecuteAgent.test.ts',
    'tests/contracts/orchRunApprove.test.ts',
    'tests/toolContracts.test.ts',
    'tests/docs/docToolDrift.test.ts',
  ]],
  ['pnpm', ['--filter', '@autoresearch/hep-mcp', 'build']],
  ['pnpm', ['--filter', '@autoresearch/hep-mcp', 'docs:tool-counts:check']],
  ['git', ['diff', '--check']],
];

for (const relPath of coldArtifacts) {
  rmSync(path.join(repoRoot, relPath), { force: true, recursive: true });
}

for (const [cmd, args] of steps) {
  process.stdout.write(`\n> ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
