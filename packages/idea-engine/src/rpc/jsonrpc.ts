import { RpcError } from '../service/errors.js';

interface RpcMethodService {
  handle(method: string, params: unknown): Record<string, unknown>;
}

export function buildJsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

export function buildJsonRpcResult(
  id: unknown,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function handleJsonRpcRequest(
  service: RpcMethodService,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const id = request.id;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return buildJsonRpcError(id, -32600, 'invalid_request', { reason: 'invalid_request' });
  }

  if (
    request.params !== undefined
    && (request.params === null || typeof request.params !== 'object' || Array.isArray(request.params))
  ) {
    return buildJsonRpcError(id, -32602, 'invalid_params', {
      reason: 'schema_invalid',
      details: { message: 'params must be an object' },
    });
  }

  try {
    const result = service.handle(request.method, request.params ?? {});
    return buildJsonRpcResult(id, result);
  } catch (error) {
    if (error instanceof RpcError) {
      return buildJsonRpcError(id, error.code, error.message, error.data);
    }
    return buildJsonRpcError(id, -32603, 'internal_error', {
      reason: 'internal_error',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function parseJsonRpcLine(raw: string): Record<string, unknown> | null {
  const line = raw.trim();
  if (!line) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    return buildJsonRpcError(null, -32700, 'parse_error', { reason: 'parse_error' });
  }
}
