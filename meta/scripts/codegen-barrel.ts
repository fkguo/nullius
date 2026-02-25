/**
 * codegen-barrel.ts — Generate barrel export (index.ts) for generated TS types.
 *
 * Handles cross-file name conflicts by tracking exported names and using
 * named re-exports instead of export * when conflicts exist.
 *
 * Usage: npx tsx meta/scripts/codegen-barrel.ts <generated-ts-dir>
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';

const [tsDir] = process.argv.slice(2);
if (!tsDir) {
  console.error('Usage: codegen-barrel.ts <generated-ts-dir>');
  process.exit(1);
}

const BANNER = '/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */\n';

/** Extract all exported type/interface names from TS source */
function extractExportedNames(ts: string): string[] {
  const names: string[] = [];
  const pattern = /export\s+(?:type|interface)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(ts))) {
    names.push(m[1]);
  }
  return names;
}

const tsFiles = readdirSync(tsDir)
  .filter(f => f.endsWith('.ts') && f !== 'index.ts')
  .sort();

// Build a map of file -> exported names
const fileExports = new Map<string, string[]>();
for (const file of tsFiles) {
  const content = readFileSync(path.join(tsDir, file), 'utf-8');
  fileExports.set(file, extractExportedNames(content));
}

// Track seen names to detect conflicts
const seen = new Map<string, string>(); // name -> first file
const conflicts = new Set<string>();

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
    // Has conflicts — only export names that this file "owns" (first occurrence)
    const ownedNames = names.filter(
      n => !conflicts.has(n) || seen.get(n) === file,
    );
    if (ownedNames.length > 0) {
      lines.push(`export type { ${ownedNames.join(', ')} } from '${modulePath}';`);
    }
  }
}

lines.push('');
writeFileSync(path.join(tsDir, 'index.ts'), lines.join('\n'));
console.log(
  `codegen-barrel: generated index.ts with ${tsFiles.length} modules (${conflicts.size} name conflicts resolved)`,
);
