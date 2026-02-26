/**
 * Structured Logger (P3-1)
 * Unified logging with debug categories
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogCategory =
  | 'rate_limiter'
  | 'cache'
  | 'downloads'
  | 'circuit_breaker'
  | 'api'
  | 'tools';

export interface LogContext {
  tool?: string;
  recid?: string;
  query_hash?: string;
  retry_count?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[hep-mcp]';

/** Parse HEP_DEBUG env var to get enabled categories */
function getEnabledCategories(): Set<LogCategory> {
  const debugEnv = process.env.HEP_DEBUG || '';
  if (!debugEnv) return new Set();

  const categories = debugEnv.split(',').map(s => s.trim()) as LogCategory[];
  return new Set(categories);
}

const enabledCategories = getEnabledCategories();

// ─────────────────────────────────────────────────────────────────────────────
// Logger Implementation
// ─────────────────────────────────────────────────────────────────────────────

function formatContext(ctx?: LogContext): string {
  if (!ctx || Object.keys(ctx).length === 0) return '';

  const parts: string[] = [];
  if (ctx.tool) parts.push(`tool=${ctx.tool}`);
  if (ctx.recid) parts.push(`recid=${ctx.recid}`);
  if (ctx.query_hash) parts.push(`query=${ctx.query_hash.slice(0, 8)}`);
  if (ctx.retry_count !== undefined) parts.push(`retry=${ctx.retry_count}`);
  if (ctx.duration_ms !== undefined) parts.push(`${ctx.duration_ms}ms`);

  // Add any extra fields
  for (const [key, value] of Object.entries(ctx)) {
    if (!['tool', 'recid', 'query_hash', 'retry_count', 'duration_ms'].includes(key)) {
      parts.push(`${key}=${value}`);
    }
  }

  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

export const logger = {
  debug(category: LogCategory, message: string, ctx?: LogContext): void {
    if (enabledCategories.has(category) || process.env.DEBUG) {
      console.error(`${LOG_PREFIX} [${category}]${formatContext(ctx)} ${message}`);
    }
  },

  info(message: string, ctx?: LogContext): void {
    console.error(`${LOG_PREFIX}${formatContext(ctx)} ${message}`);
  },

  warn(message: string, ctx?: LogContext): void {
    console.warn(`${LOG_PREFIX}${formatContext(ctx)} ${message}`);
  },

  error(message: string, ctx?: LogContext): void {
    console.error(`${LOG_PREFIX}${formatContext(ctx)} ${message}`);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a short hash for query strings */
export function hashQuery(query: string): string {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    const char = query.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/** Check if a category is enabled for debug logging */
export function isDebugEnabled(category: LogCategory): boolean {
  return enabledCategories.has(category) || !!process.env.DEBUG;
}
