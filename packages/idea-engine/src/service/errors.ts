export class RpcError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown>;

  constructor(code: number, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  /**
   * Rehydrate an already-validated, durably stored response without inventing
   * a new error reason. The original construction site remains covered by the
   * error-reason registry; this path only reproduces its exact bytes.
   */
  static fromStored(code: number, message: string, data: Record<string, unknown>): RpcError {
    return Reflect.construct(RpcError, [code, message, data]) as RpcError;
  }
}

export function schemaValidationError(
  detail: string,
  extra: Record<string, unknown> = {},
): RpcError {
  return new RpcError(-32002, 'schema_validation_failed', {
    reason: 'schema_invalid',
    details: { message: detail },
    ...extra,
  });
}
