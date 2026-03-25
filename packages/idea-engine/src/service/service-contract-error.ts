import { ContractRuntimeError } from '../contracts/catalog.js';
import { RpcError, schemaValidationError } from './errors.js';

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function toSchemaError(error: unknown, detailPrefix = ''): RpcError {
  if (error instanceof RpcError) {
    return error;
  }
  if (error instanceof ContractRuntimeError) {
    return schemaValidationError(`${detailPrefix}${error.message}`);
  }
  return schemaValidationError(`${detailPrefix}${error instanceof Error ? error.message : String(error)}`);
}
