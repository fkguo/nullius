// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR'
  | 'UNSAFE_FS';

// ─────────────────────────────────────────────────────────────────────────────
// MCP Error Class
// ─────────────────────────────────────────────────────────────────────────────

export class McpError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public data?: unknown
  ) {
    super(message);
    this.name = 'McpError';
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

export function invalidParams(message: string, data?: unknown): McpError {
  return new McpError('INVALID_PARAMS', message, data);
}

export function notFound(message: string, data?: unknown): McpError {
  return new McpError('NOT_FOUND', message, data);
}

export function rateLimit(message: string, retryAfter?: number): McpError {
  return new McpError('RATE_LIMIT', message, { retryAfter });
}

export function upstreamError(message: string, data?: unknown): McpError {
  return new McpError('UPSTREAM_ERROR', message, data);
}

export function internalError(message: string, data?: unknown): McpError {
  return new McpError('INTERNAL_ERROR', message, data);
}

export function unsafeFs(message: string, data?: unknown): McpError {
  return new McpError('UNSAFE_FS', message, data);
}
