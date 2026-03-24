import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ValidationIssue } from './result.js';
import { getSchemaId, loadSchema, REP_SCHEMA_NAMES, type SchemaName } from './schema-file.js';

interface SchemaRegistry {
  addSchema(schema: unknown): void;
  getSchema(id: string): ValidateFunction | undefined;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => SchemaRegistry;
const addFormats = require('ajv-formats') as (registry: SchemaRegistry) => void;
const ajv = createSchemaRegistry();

function createSchemaRegistry(): SchemaRegistry {
  const registry = new Ajv2020({
    allErrors: true,
    strict: false,
  });
  addFormats(registry);

  for (const schemaName of REP_SCHEMA_NAMES) {
    registry.addSchema(loadSchema(schemaName));
  }

  return registry;
}

export function getSchemaValidator(schemaName: SchemaName): ValidateFunction {
  const validator = ajv.getSchema(getSchemaId(schemaName));
  if (!validator) {
    throw new Error(`Missing REP schema validator for ${schemaName}.`);
  }
  return validator;
}

export function toValidationIssues(errors?: readonly ErrorObject[] | null): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    message: error.message ?? 'Schema validation failed.',
    keyword: error.keyword,
  }));
}
