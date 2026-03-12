import { internalError, invalidParams, notFound } from '@autoresearch/shared';

const INVALID_PARAMS_RPC_CODES = new Set([
  -32602,
  -32001,
  -32002,
  -32010,
  -32011,
  -32013,
  -32015,
  -32016,
]);
const NOT_FOUND_RPC_CODES = new Set([-32003, -32004, -32014]);
const INTERNAL_RPC_CODES = new Set([-32700, -32600, -32601, -32603, -32000]);

function withRpcContext(code: number, message: string, data?: unknown): Record<string, unknown> {
  const rpc = { code, message, data };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), rpc };
  }
  return data === undefined ? { rpc } : { rpc, rpc_data: data };
}

export function mapRpcError(code: number, message: string, data?: unknown): Error {
  const errorData = withRpcContext(code, message, data);
  if (NOT_FOUND_RPC_CODES.has(code)) return notFound(message, errorData);
  if (INVALID_PARAMS_RPC_CODES.has(code)) return invalidParams(message, errorData);
  if (INTERNAL_RPC_CODES.has(code)) return internalError(`JSON-RPC error ${code}: ${message}`, errorData);
  return internalError(`JSON-RPC error ${code}: ${message}`, errorData);
}
