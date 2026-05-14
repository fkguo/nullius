#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type ToolCounts = {
  standard: number;
  full: number;
};

type SyncTarget = {
  relPath: string;
  transform: (source: string) => string;
};

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

function parseCountsFromStdout(stdout: string, mode: string): ToolCounts {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    throw new Error(`Failed to read tool counts (${mode}): empty stdout`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error(`Failed to parse tool counts (${mode}): ${lastLine}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { standard?: unknown }).standard !== 'number' ||
    typeof (parsed as { full?: unknown }).full !== 'number'
  ) {
    throw new Error(`Invalid tool counts payload (${mode}): ${lastLine}`);
  }

  return {
    standard: (parsed as { standard: number }).standard,
    full: (parsed as { full: number }).full,
  };
}

function getToolCounts(hepEnableZotero: '0' | '1'): ToolCounts {
  const stdout = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import('./packages/hep-mcp/dist/tools/index.js').then(({getTools})=>console.log(JSON.stringify({standard:getTools('standard').length,full:getTools('full').length})))",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HEP_ENABLE_ZOTERO: hepEnableZotero },
      encoding: 'utf-8',
    }
  );

  return parseCountsFromStdout(stdout, `HEP_ENABLE_ZOTERO=${hepEnableZotero}`);
}

function replaceOrThrow(source: string, pattern: RegExp, replacement: string, label: string): string {
  if (!pattern.test(source)) {
    throw new Error(`Pattern not found for ${label}: ${String(pattern)}`);
  }
  return source.replace(pattern, replacement);
}

function syncToolCategories(source: string, counts: ToolCounts): string {
  return replaceOrThrow(
    source,
    /^# Tool Categories（standard=\d+\s*\/\s*full=\d+）/m,
    `# Tool Categories（standard=${counts.standard} / full=${counts.full}）`,
    'TOOL_CATEGORIES header'
  );
}

function syncProjectStatus(source: string, zoteroOn: ToolCounts, zoteroOff: ToolCounts): string {
  let out = source;
  out = replaceOrThrow(
    out,
    /-\s*`standard=\d+`,\s*`full=\d+`/m,
    `- \`standard=${zoteroOn.standard}\`, \`full=${zoteroOn.full}\``,
    'PROJECT_STATUS default counts'
  );
  out = replaceOrThrow(
    out,
    /-\s*`HEP_ENABLE_ZOTERO=0`\s*→\s*`standard=\d+`,\s*`full=\d+`/m,
    `- \`HEP_ENABLE_ZOTERO=0\` → \`standard=${zoteroOff.standard}\`, \`full=${zoteroOff.full}\``,
    'PROJECT_STATUS zotero-off counts'
  );
  return out;
}

function syncTarget(target: SyncTarget, checkOnly: boolean): boolean {
  const filePath = resolve(REPO_ROOT, target.relPath);
  const before = readFileSync(filePath, 'utf-8');
  const after = target.transform(before);
  const changed = before !== after;

  if (changed && !checkOnly) {
    writeFileSync(filePath, after, 'utf-8');
  }

  return changed;
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const zoteroOn = getToolCounts('1');
  const zoteroOff = getToolCounts('0');

  const targets: SyncTarget[] = [
    { relPath: 'docs/TOOL_CATEGORIES.md', transform: source => syncToolCategories(source, zoteroOn) },
    { relPath: 'docs/PROJECT_STATUS.md', transform: source => syncProjectStatus(source, zoteroOn, zoteroOff) },
  ];

  const changedFiles = targets.filter(target => syncTarget(target, checkOnly)).map(target => target.relPath);
  if (checkOnly && changedFiles.length > 0) {
    console.error('[drift] Tool count docs are out of sync:');
    for (const file of changedFiles) {
      console.error(`  - ${file}`);
    }
    console.error('Run: pnpm --filter @autoresearch/hep-mcp docs:tool-counts:sync');
    process.exit(1);
  }

  if (checkOnly) {
    console.log('[ok] Tool count docs are in sync.');
    return;
  }

  if (changedFiles.length === 0) {
    console.log('[ok] No tool count updates needed.');
    return;
  }

  for (const file of changedFiles) {
    console.log(`[updated] ${file}`);
  }
}

main();
