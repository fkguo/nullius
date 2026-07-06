import { ContractRuntimeError } from '../contracts/catalog.js';
import { StoreLockedError } from '../store/file-lock.js';
import { RpcError, schemaValidationError } from './errors.js';

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function toSchemaError(error: unknown, detailPrefix = ''): RpcError {
  if (error instanceof RpcError) {
    return error;
  }
  if (error instanceof StoreLockedError) {
    // A held mutation lock is a concurrency condition, not a request-schema
    // problem: surface it as store_locked so callers retry instead of
    // re-editing a valid request.
    return new RpcError(-32603, 'internal_error', {
      reason: 'store_locked',
      details: {
        holder_pid: error.holderPid,
        lock_path: error.lockFilePath,
        message: error.message,
      },
    });
  }
  if (error instanceof ContractRuntimeError) {
    return schemaValidationError(`${detailPrefix}${error.message}`);
  }
  return schemaValidationError(`${detailPrefix}${error instanceof Error ? error.message : String(error)}`);
}
