export class RpcError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown>;

  constructor(code: number, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
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
