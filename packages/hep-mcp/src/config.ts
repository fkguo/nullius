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
