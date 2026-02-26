import { describe, expect, it } from 'vitest';

import {
  SQLITE_WAL_DEFAULTS,
  SQLITE_WAL_PRAGMAS,
  EXPECTED_WAL_JOURNAL_MODE,
} from '../db/sqlite-utils.js';

describe('M-06: SQLite WAL configuration', () => {
  it('SQLITE_WAL_DEFAULTS has correct values', () => {
    expect(SQLITE_WAL_DEFAULTS.journalMode).toBe('wal');
    expect(SQLITE_WAL_DEFAULTS.busyTimeoutMs).toBe(5_000);
    expect(SQLITE_WAL_DEFAULTS.readonly).toBe(false);
  });

  it('SQLITE_WAL_PRAGMAS contains journal_mode and busy_timeout', () => {
    expect(SQLITE_WAL_PRAGMAS).toContain('PRAGMA journal_mode=WAL');
    expect(SQLITE_WAL_PRAGMAS).toContain('PRAGMA busy_timeout=5000');
  });

  it('EXPECTED_WAL_JOURNAL_MODE is "wal"', () => {
    expect(EXPECTED_WAL_JOURNAL_MODE).toBe('wal');
  });
});
