/**
 * codegen-ts.ts — Generate TypeScript types from resolved JSON Schemas.
 *
 * Handles if-then-allOf conditional schemas by stripping allOf entries that
 * contain if-then (prevents index signature pollution from the intersection).
 * With declareExternallyReferenced=true, $defs are emitted by the base compile.
 *
 * Usage: npx tsx meta/scripts/codegen-ts.ts <resolved-schema-dir> <output-dir>
 */
import { compile } from 'json-schema-to-typescript';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';

const [schemaDir, outputDir] = process.argv.slice(2);
if (!schemaDir || !outputDir) {
  console.error('Usage: codegen-ts.ts <resolved-schema-dir> <output-dir>');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const BANNER = '/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */\n';

const compileOptions = {
  bannerComment: '',
  style: { singleQuote: true, semi: true, tabWidth: 2 },
  declareExternallyReferenced: true,
  unreachableDefinitions: true,
  enableConstEnums: false,
  cwd: path.resolve(schemaDir),
};

/** Convert schema filename to output TS filename: foo_bar_v1.schema.json -> foo-bar-v1.ts */
function toOutputName(schemaFile: string): string {
  return schemaFile.replace('.schema.json', '').replace(/_/g, '-') + '.ts';
}

/** Check if an allOf entry is an if-then conditional */
function isIfThenEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  return 'if' in obj && 'then' in obj;
}

/** Post-process TS output: remove {[k: string]: unknown} & intersections */
function cleanIndexSignatures(ts: string): string {
  return ts
    .replace(/\{\s*\[k:\s*string\]:\s*unknown;?\s*\}\s*&\s*/g, '')
    .replace(/\s*&\s*\{\s*\[k:\s*string\]:\s*unknown;?\s*\}/g, '');
}

async function processSchema(schemaFile: string): Promise<string> {
  const raw = readFileSync(path.join(schemaDir, schemaFile), 'utf-8');
  const schema = JSON.parse(raw);

  const hasIfThenAllOf =
    Array.isArray(schema.allOf) && schema.allOf.some(isIfThenEntry);

  let targetSchema = schema;
  if (hasIfThenAllOf) {
    // Strip only if-then entries from allOf (keep non-conditional allOf entries)
    targetSchema = { ...schema };
    const nonConditional = schema.allOf.filter(
      (entry: unknown) => !isIfThenEntry(entry),
    );
    if (nonConditional.length > 0) {
      targetSchema.allOf = nonConditional;
    } else {
      delete targetSchema.allOf;
    }
  }

  const ts = await compile(targetSchema, schemaFile, compileOptions);
  return BANNER + cleanIndexSignatures(ts);
}

async function main() {
  const schemaFiles = readdirSync(schemaDir).filter(f =>
    f.endsWith('.schema.json'),
  );
  let count = 0;

  for (const file of schemaFiles) {
    const outName = toOutputName(file);
    try {
      const ts = await processSchema(file);
      writeFileSync(path.join(outputDir, outName), ts);
      count++;
      console.log(`  TS: ${file} → ${outName}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL: ${file}: ${errMsg}`);
      process.exit(1);
    }
  }

  console.log(`codegen-ts: generated ${count} TypeScript files → ${outputDir}`);
}

main();
