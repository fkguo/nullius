import { describe, expect, it } from 'vitest';
import { RpcError, schemaValidationError } from '../src/service/errors.js';

describe('rpc errors', () => {
  it('sets the error name for debugging and parity-friendly inspection', () => {
    expect(new RpcError(-32002, 'schema_validation_failed', {}).name).toBe('RpcError');
    expect(schemaValidationError('bad input')).toBeInstanceOf(RpcError);
  });
});
