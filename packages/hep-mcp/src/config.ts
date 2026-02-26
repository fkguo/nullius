/**
 * Unified Configuration
 * Centralized configuration for cache TTL, rate limits, etc.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Cache TTL Configuration (P2-2)
// ─────────────────────────────────────────────────────────────────────────────

export const CACHE_TTL = {
  /** Paper metadata - stable, long TTL */
  METADATA: 24 * 60 * 60 * 1000,      // 24h
  /** References list - moderately stable */
  REFERENCES: 6 * 60 * 60 * 1000,     // 6h
  /** Search results - may change frequently */
  SEARCH: 30 * 60 * 1000,             // 30m
  /** LaTeX source - very stable */
  SOURCE: 7 * 24 * 60 * 60 * 1000,    // 7d
  /** Author info - stable */
  AUTHOR: 24 * 60 * 60 * 1000,        // 24h
  /** Citations - moderately stable */
  CITATIONS: 6 * 60 * 60 * 1000,      // 6h
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Cache Size Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const CACHE_SIZE = {
  SEARCH: 100,
  PAPER: 500,
  PAPER_SUMMARY: 1000,
  REFERENCES: 200,
  AUTHOR: 100,
  SOURCE: 50,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const RATE_LIMIT = {
  /** INSPIRE API: 15 requests per 5s window */
  INSPIRE_MAX_REQUESTS: 15,
  INSPIRE_WINDOW_MS: 5000,
  /** arXiv API: at least 3 seconds between requests */
  ARXIV_MIN_INTERVAL_MS: 3000,
  /** Request timeout */
  REQUEST_TIMEOUT_MS: 30000,
  /** Backoff settings */
  BACKOFF_BASE_DELAY_MS: 5000,
  BACKOFF_MAX_DELAY_MS: 30000,
  MAX_RETRY_ATTEMPTS: 3,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const CIRCUIT_BREAKER = {
  FAILURE_THRESHOLD: 5,
  RESET_TIMEOUT_MS: 60000,  // 60s
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// M-18: Config Summary (logged to stderr on startup)
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigEntry {
  key: string;
  defaultValue: string;
}

const CONFIG_KEYS: ConfigEntry[] = [
  { key: 'HEP_DATA_DIR', defaultValue: '~/.hep-research-mcp' },
  { key: 'HEP_TOOL_MODE', defaultValue: 'standard' },
  { key: 'HEP_DOWNLOAD_DIR', defaultValue: '<HEP_DATA_DIR>/downloads' },
  { key: 'HEP_ENABLE_ZOTERO', defaultValue: 'true' },
  { key: 'ZOTERO_BASE_URL', defaultValue: 'http://127.0.0.1:23119' },
  { key: 'ZOTERO_DATA_DIR', defaultValue: '(none)' },
  { key: 'PDG_DB_PATH', defaultValue: '(none)' },
  { key: 'PDG_DATA_DIR', defaultValue: '<HEP_DATA_DIR>/pdg' },
  { key: 'PDG_TOOL_MODE', defaultValue: 'standard' },
  { key: 'WRITING_LLM_PROVIDER', defaultValue: '(none)' },
  { key: 'WRITING_LLM_MODE', defaultValue: '(derived)' },
  { key: 'HEP_DEBUG', defaultValue: '(none)' },
];

/**
 * Log a summary of current configuration to stderr.
 * Safe to call at MCP server startup (does not touch stdout / stdio transport).
 */
export function logConfigSummary(): void {
  for (const { key, defaultValue } of CONFIG_KEYS) {
    const envVal = process.env[key];
    const source = envVal !== undefined ? 'env' : 'default';
    const display = envVal !== undefined ? envVal : defaultValue;
    console.error(`[config] ${key}=${display} (${source})`);
  }
}
