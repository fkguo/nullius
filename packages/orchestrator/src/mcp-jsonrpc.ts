import type { Writable } from 'node:stream';

export interface McpToolResult {
  ok: boolean;
  isError: boolean;
  rawText: string;
  json: unknown | null;
  errorCode: string | null;
}

export type JsonRpcId = number | string;

export interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export function writeJsonRpcMessage(
  stdin: Pick<Writable, 'write'> | null | undefined,
  message: Record<string, unknown>,
): void {
  if (!stdin) {
    throw new Error('McpClient not started');
  }
  stdin.write(JSON.stringify(message) + '\n');
}

export function consumeJsonRpcLine(params: {
  line: string;
  pending: Map<JsonRpcId, PendingRequest>;
  onServerRequest: (message: Record<string, unknown>) => Promise<void> | void;
}): void {
  try {
    const message = JSON.parse(params.line) as Record<string, unknown>;
    if (typeof message.method === 'string' && message.id !== undefined) {
      void params.onServerRequest(message);
      return;
    }
    const id = message.id as JsonRpcId | undefined;
    if (id === undefined) {
      return;
    }
    const pending = params.pending.get(id);
    if (!pending) {
      return;
    }
    params.pending.delete(id);
    pending.resolve(message);
  } catch {
    // CONTRACT-EXEMPT: CODE-01.5 skip non-JSON stdout noise
  }
}

export function toMcpToolResult(response: Record<string, unknown>): McpToolResult {
  const result = response.result as Record<string, unknown> | undefined;
  const error = response.error as Record<string, unknown> | undefined;
  if (error) {
    return {
      ok: false,
      isError: true,
      rawText: String(error.message ?? ''),
      json: null,
      errorCode: String(error.code ?? ''),
    };
  }

  const content = (result?.content as Array<Record<string, unknown>> | undefined) ?? [];
  const rawText = content
    .filter(part => part.type === 'text')
    .map(part => String(part.text ?? ''))
    .join('\n');

  let json: unknown = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    // Keep rawText when payload is not JSON.
  }

  return {
    ok: !result?.isError,
    isError: Boolean(result?.isError),
    rawText,
    json,
    errorCode: null,
  };
}
