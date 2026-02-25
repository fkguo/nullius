/**
 * codegen-resolve-refs.ts — Shared $ref pre-resolution for codegen pipeline.
 *
 * Resolves absolute URI $refs to local paths and strips $id fields so that
 * downstream generators (json-schema-to-typescript, datamodel-code-generator)
 * consume fully self-contained schemas.
 *
 * Usage: npx tsx meta/scripts/codegen-resolve-refs.ts <schema-dir> <output-dir>
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';

const [schemaDir, outputDir] = process.argv.slice(2);
if (!schemaDir || !outputDir) {
  console.error('Usage: codegen-resolve-refs.ts <schema-dir> <output-dir>');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

// Build a map of $id → local filename for cross-file $ref resolution
const schemaFiles = readdirSync(schemaDir).filter(f => f.endsWith('.schema.json'));
const idToFile = new Map<string, string>();

for (const file of schemaFiles) {
  const raw = readFileSync(path.join(schemaDir, file), 'utf-8');
  const schema = JSON.parse(raw);
  if (schema.$id) {
    idToFile.set(schema.$id, file);
  }
}

function resolveRefs(obj: unknown, currentFile: string): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => resolveRefs(item, currentFile));

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === '$id') {
      // Strip $id — downstream tools don't need it and it can confuse resolution
      continue;
    }

    if (key === '$ref' && typeof value === 'string') {
      // Local $ref (#/$defs/...) — keep as-is
      if (value.startsWith('#')) {
        result[key] = value;
        continue;
      }

      // Absolute URI $ref — resolve to local file
      const [baseUri, fragment] = value.split('#');
      const localFile = idToFile.get(baseUri);
      if (!localFile) {
        throw new Error(
          `Cannot resolve $ref "${value}" in ${currentFile}: no local schema has $id "${baseUri}"`
        );
      }

      if (localFile === currentFile) {
        // Self-reference — convert to local $ref
        result[key] = fragment ? `#${fragment}` : '#';
      } else {
        // Cross-file reference — inline the referenced definition
        const refSchema = JSON.parse(
          readFileSync(path.join(schemaDir, localFile), 'utf-8')
        );
        if (fragment) {
          // Navigate JSON Pointer (e.g., /$defs/Foo)
          const parts = fragment.replace(/^\//, '').split('/');
          let target: unknown = refSchema;
          for (const part of parts) {
            if (target && typeof target === 'object' && !Array.isArray(target)) {
              target = (target as Record<string, unknown>)[part];
            } else {
              throw new Error(
                `Cannot resolve fragment "${fragment}" in ${localFile} (referenced from ${currentFile})`
              );
            }
          }
          return resolveRefs(target, localFile);
        }
        return resolveRefs(refSchema, localFile);
      }
      continue;
    }

    result[key] = resolveRefs(value, currentFile);
  }

  return result;
}

let resolved = 0;
for (const file of schemaFiles) {
  const raw = readFileSync(path.join(schemaDir, file), 'utf-8');
  const schema = JSON.parse(raw);
  const resolvedSchema = resolveRefs(schema, file);
  writeFileSync(
    path.join(outputDir, file),
    JSON.stringify(resolvedSchema, null, 2) + '\n'
  );
  resolved++;
}

console.log(`codegen-resolve-refs: resolved ${resolved} schemas → ${outputDir}`);
