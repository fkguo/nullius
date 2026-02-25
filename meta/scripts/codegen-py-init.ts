/**
 * codegen-py-init.ts — Generate __init__.py for generated Python types.
 *
 * Usage: npx tsx meta/scripts/codegen-py-init.ts <generated-py-dir>
 */
import { readdirSync, writeFileSync } from 'fs';
import path from 'path';

const [pyDir] = process.argv.slice(2);
if (!pyDir) {
  console.error('Usage: codegen-py-init.ts <generated-py-dir>');
  process.exit(1);
}

const BANNER = '# AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/\n';

const pyFiles = readdirSync(pyDir)
  .filter(f => f.endsWith('.py') && f !== '__init__.py')
  .sort();

const lines = [BANNER];
for (const file of pyFiles) {
  const moduleName = file.replace('.py', '');
  lines.push(`from .${moduleName} import *  # noqa: F401,F403`);
}
lines.push('');

writeFileSync(path.join(pyDir, '__init__.py'), lines.join('\n'));
console.log(`codegen-py-init: generated __init__.py with ${pyFiles.length} imports`);
