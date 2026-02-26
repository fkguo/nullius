/**
 * M-06: SQLite WAL + connection pool — shared interface + constants.
 *
 * packages/shared is platform-agnostic (no @types/node, no better-sqlite3).
 * This module defines the interface and configuration constants that concrete
 * implementations (in pdg-mcp, future EVO-20/19/21 consumers) will use.
 *
 * Configuration notes:
 *   - busy_timeout should be ≥ expected max write duration
 *   - WAL mode allows concurrent readers during writes
 *   - journal_mode=WAL must be set on a writable connection
 */

/** Configuration for SQLite WAL mode connections */
export interface SqliteWalConfig {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Journal mode — always 'wal' for concurrent read/write support */
  journalMode: 'wal';
  /** Busy timeout in milliseconds (default: 5000) */
  busyTimeoutMs: number;
  /** Whether to open in readonly mode (WAL cannot be set on readonly connections) */
  readonly: boolean;
}

/** Default WAL configuration values */
export const SQLITE_WAL_DEFAULTS = {
  journalMode: 'wal' as const,
  busyTimeoutMs: 5_000,
  readonly: false,
} satisfies Omit<SqliteWalConfig, 'dbPath'>;

/**
 * PRAGMA statements to configure WAL mode on a writable SQLite connection.
 * Apply these immediately after opening the connection.
 */
export const SQLITE_WAL_PRAGMAS = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA busy_timeout=5000',
] as const;

/**
 * Verify that WAL mode is active on a connection.
 * Consumer should run `PRAGMA journal_mode` and compare against this value.
 */
export const EXPECTED_WAL_JOURNAL_MODE = 'wal';
