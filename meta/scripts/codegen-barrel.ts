/**
 * codegen-barrel.ts — Generate barrel export (index.ts) for generated TS types.
 *
 * Handles cross-file name conflicts by tracking exported names and using
 * named re-exports instead of export * when conflicts exist.
 * Also checks against sibling directories (e.g. ../types/) to avoid
 * duplicating exports already provided by hand-written modules.
 *
 * Usage: npx tsx meta/scripts/codegen-barrel.ts <generated-ts-dir> [--external-dir <dir>]...
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const tsDir = args[0];
if (!tsDir) {
  console.error('Usage: codegen-barrel.ts <generated-ts-dir> [--external-dir <dir>]...');
  process.exit(1);
}

// Parse --external-dir flags
const externalDirs: string[] = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--external-dir' && i + 1 < args.length) {
    externalDirs.push(args[++i]);
  }
}

// Default: always check the sibling types/ directory
const siblingTypes = path.resolve(tsDir, '..', 'types');
if (existsSync(siblingTypes) && !externalDirs.includes(siblingTypes)) {
  externalDirs.push(siblingTypes);
}

const BANNER = '/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */\n';

/** Extract all exported type/interface/const names from TS source */
function extractExportedNames(ts: string): string[] {
  const names: string[] = [];
  const pattern = /export\s+(?:type|interface|const|function|enum)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(ts))) {
    names.push(m[1]);
  }
  return names;
}

const tsFiles = readdirSync(tsDir)
  .filter(f => f.endsWith('.ts') && f !== 'index.ts')
  .sort();

// Build a map of file -> exported names (within generated dir)
const fileExports = new Map<string, string[]>();
for (const file of tsFiles) {
  const content = readFileSync(path.join(tsDir, file), 'utf-8');
  fileExports.set(file, extractExportedNames(content));
}

// Collect names exported from external directories (hand-written modules)
const externalNames = new Set<string>();
for (const extDir of externalDirs) {
  if (!existsSync(extDir)) continue;
  const extFiles = readdirSync(extDir).filter(f => f.endsWith('.ts'));
  for (const file of extFiles) {
    const content = readFileSync(path.join(extDir, file), 'utf-8');
    for (const name of extractExportedNames(content)) {
      externalNames.add(name);
    }
  }
}

// Track seen names to detect conflicts (within generated + external)
const seen = new Map<string, string>(); // name -> first file
const conflicts = new Set<string>();

// Mark external names as pre-seen (they take priority)
for (const name of externalNames) {
  seen.set(name, '__external__');
}

for (const [file, names] of fileExports) {
  for (const name of names) {
    if (seen.has(name)) {
      conflicts.add(name);
    } else {
      seen.set(name, file);
    }
  }
}

// Generate barrel: for files with conflicts, use named exports excluding duplicates
const lines = [BANNER];

for (const file of tsFiles) {
  const modulePath = './' + file.replace('.ts', '.js');
  const names = fileExports.get(file)!;
  const conflicting = names.filter(n => conflicts.has(n));

  if (conflicting.length === 0) {
    // No conflicts — use export *
    lines.push(`export * from '${modulePath}';`);
  } else {
    // Has conflicts — only export names that this file "owns" (first occurrence, not external)
    const ownedNames = names.filter(
      n => !conflicts.has(n) || (seen.get(n) === file),
    );
    if (ownedNames.length > 0) {
      lines.push(`export type { ${ownedNames.join(', ')} } from '${modulePath}';`);
    }
  }
}

lines.push('');
writeFileSync(path.join(tsDir, 'index.ts'), lines.join('\n'));
const externalConflicts = [...conflicts].filter(n => externalNames.has(n));
console.log(
  `codegen-barrel: generated index.ts with ${tsFiles.length} modules ` +
  `(${conflicts.size} name conflicts resolved, ${externalConflicts.length} suppressed by external types)`,
);
