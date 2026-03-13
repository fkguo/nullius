import Ajv2020 from 'ajv/dist/2020.js';
import { invalidParams, type ComputationResultV1 } from '@autoresearch/shared';
import artifactRefSchema from '../../../../meta/schemas/artifact_ref_v1.schema.json' with { type: 'json' };
import computationResultSchema from '../../../../meta/schemas/computation_result_v1.schema.json' with { type: 'json' };

type AjvConstructor = new (options: Record<string, unknown>) => {
  addSchema?: (schema: Record<string, unknown>, key?: string) => void;
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

const ajv = new (Ajv2020 as unknown as AjvConstructor)({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

ajv.addSchema?.(
  artifactRefSchema as Record<string, unknown>,
  'https://autoresearch.dev/schemas/artifact_ref_v1.schema.json',
);

const validator = ajv.compile(computationResultSchema as Record<string, unknown>);

export function assertComputationResultValid(raw: unknown): ComputationResultV1 {
  if (!validator(raw)) {
    throw invalidParams('computation_result_v1 validation failed', {
      validation_layer: 'computation_result',
      issues: validator.errors ?? [],
    });
  }
  return raw as ComputationResultV1;
}
