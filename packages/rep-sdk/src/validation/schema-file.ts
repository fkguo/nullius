import { readFileSync } from 'node:fs';

const schemaFiles = {
  artifact_ref_v1: 'artifact_ref_v1.schema.json',
  integrity_report_v1: 'integrity_report_v1.schema.json',
  rep_envelope_v1: 'rep_envelope_v1.schema.json',
  research_event_v1: 'research_event_v1.schema.json',
  research_outcome_v1: 'research_outcome_v1.schema.json',
  research_strategy_v1: 'research_strategy_v1.schema.json',
} as const;

const schemaCache = new Map<SchemaName, Record<string, unknown>>();

export type SchemaName = keyof typeof schemaFiles;
export const REP_SCHEMA_NAMES = Object.freeze(Object.keys(schemaFiles) as SchemaName[]);

export function getSchemaFileName(name: SchemaName): string {
  return schemaFiles[name];
}

export function getSchemaId(name: SchemaName): string {
  return `https://autoresearch.dev/schemas/${getSchemaFileName(name)}`;
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  const cached = schemaCache.get(name);
  if (cached) {
    return cached;
  }

  const fileUrl = new URL(`../../schemas/${getSchemaFileName(name)}`, import.meta.url);
  const parsed = JSON.parse(readFileSync(fileUrl, 'utf8')) as Record<string, unknown>;
  schemaCache.set(name, parsed);
  return parsed;
}
