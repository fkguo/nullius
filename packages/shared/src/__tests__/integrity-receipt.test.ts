/**
 * P3-A followup-4: integrity receipt primitive tests.
 *
 * Covers:
 *   - skip semantics (NODE_ENV=test, NULLIUS_INTEGRITY_VERIFY env values)
 *   - writeIntegrityReceipt input validation (empty modes, invalid mode names,
 *     malformed modes_skipped, notes too long, non-string notes)
 *   - verifyIntegrityReceipt happy path: receipt for approval_id matches
 *   - verifyIntegrityReceipt rejection: log missing, receipt missing for
 *     this approval_id, malformed log lines
 *   - multiple receipts for same approval_id: latest wins (re-record after
 *     fixing a caught issue)
 *   - readIntegrityReceipts skips malformed lines without throwing
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTEGRITY_LOG_FILE,
  INTEGRITY_MODES,
  integrityLogPath,
  isIntegrityVerifySkipped,
  readIntegrityReceipts,
  verifyIntegrityReceipt,
  writeIntegrityReceipt,
  type IntegrityMode,
} from '../integrity-receipt.js';
import { McpError } from '../errors.js';

const FORCE_ON_ENV = { NULLIUS_INTEGRITY_VERIFY: 'on' } as NodeJS.ProcessEnv;

function makeProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-receipt-'));
}

describe('isIntegrityVerifySkipped', () => {
  it('skips when NULLIUS_INTEGRITY_VERIFY=skip regardless of NODE_ENV', () => {
    expect(isIntegrityVerifySkipped({ NULLIUS_INTEGRITY_VERIFY: 'skip' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isIntegrityVerifySkipped({
      NULLIUS_INTEGRITY_VERIFY: 'skip',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('force-on when NULLIUS_INTEGRITY_VERIFY=on even in test', () => {
    expect(isIntegrityVerifySkipped({
      NULLIUS_INTEGRITY_VERIFY: 'on',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('defaults to skip in NODE_ENV=test', () => {
    expect(isIntegrityVerifySkipped({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defaults to verify when nothing forces skip', () => {
    expect(isIntegrityVerifySkipped({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isIntegrityVerifySkipped({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('treats unknown explicit values as default (no skip) when NODE_ENV is not test', () => {
    expect(isIntegrityVerifySkipped({
      NULLIUS_INTEGRITY_VERIFY: 'maybe',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('integrityLogPath', () => {
  it('joins INTEGRITY_LOG_FILE under projectRoot', () => {
    expect(integrityLogPath('/proj')).toBe(path.join('/proj', INTEGRITY_LOG_FILE));
  });
});

describe('writeIntegrityReceipt input validation', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('rejects empty approval_id', () => {
    expect(() =>
      writeIntegrityReceipt(project, '', ['M1'], 'notes', []),
    ).toThrow(/approval_id must be a non-empty string/);
  });

  it('rejects non-string approval_id', () => {
    expect(() =>
      writeIntegrityReceipt(project, undefined as unknown as string, ['M1'], 'notes', []),
    ).toThrow(/approval_id must be a non-empty string/);
  });

  it('rejects empty modes_checked', () => {
    expect(() =>
      writeIntegrityReceipt(project, 'A1-test', [], 'notes', []),
    ).toThrow(McpError);
    expect(() =>
      writeIntegrityReceipt(project, 'A1-test', [], 'notes', []),
    ).toThrow(/modes_checked must be non-empty/);
  });

  it('rejects invalid mode names in modes_checked', () => {
    expect(() =>
      writeIntegrityReceipt(project, 'A1-test', ['M8' as IntegrityMode], 'notes', []),
    ).toThrow(/invalid mode/);
  });

  it('rejects invalid mode names in modes_skipped', () => {
    expect(() =>
      writeIntegrityReceipt(
        project,
        'A1-test',
        ['M1'],
        'notes',
        [{ mode: 'M9' as IntegrityMode, reason: 'n/a' }],
      ),
    ).toThrow(/modes_skipped contains invalid mode/);
  });

  it('rejects empty reason in modes_skipped entries', () => {
    expect(() =>
      writeIntegrityReceipt(
        project,
        'A1-test',
        ['M1'],
        'notes',
        [{ mode: 'M2', reason: '' }],
      ),
    ).toThrow(/non-empty string/);
  });

  it('rejects non-string notes', () => {
    expect(() =>
      writeIntegrityReceipt(project, 'A1-test', ['M1'], undefined as unknown as string, []),
    ).toThrow(/notes must be a string/);
  });

  it('rejects notes longer than 500 chars', () => {
    const longNotes = 'x'.repeat(501);
    expect(() =>
      writeIntegrityReceipt(project, 'A1-test', ['M1'], longNotes, []),
    ).toThrow(/max 500/);
  });

  it('accepts notes exactly 500 chars (boundary)', () => {
    const exactlyMax = 'y'.repeat(500);
    expect(() =>
      writeIntegrityReceipt(project, 'A1-test', ['M1'], exactlyMax, []),
    ).not.toThrow();
  });

  it('accepts all 7 modes as a valid modes_checked value', () => {
    expect(() =>
      writeIntegrityReceipt(project, 'A5-final', [...INTEGRITY_MODES], 'full pass', []),
    ).not.toThrow();
  });
});

describe('writeIntegrityReceipt happy path', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('writes a receipt that round-trips through verifyIntegrityReceipt', () => {
    const written = writeIntegrityReceipt(
      project,
      'A3-2026',
      ['M3', 'M5', 'M6'],
      'PDG mass verified; clean rerun; manifest pointers checked',
      [{ mode: 'M1', reason: 'no code change' }],
    );
    expect(written.approval_id).toBe('A3-2026');
    expect(written.kind).toBe('nullius_integrity_receipt');
    expect(written.schema_version).toBe(1);
    expect(written.modes_checked).toEqual(['M3', 'M5', 'M6']);
    expect(written.modes_skipped).toEqual([{ mode: 'M1', reason: 'no code change' }]);

    const verified = verifyIntegrityReceipt(project, 'A3-2026', { env: FORCE_ON_ENV });
    expect(verified.approval_id).toBe('A3-2026');
    expect(verified.modes_checked).toEqual(['M3', 'M5', 'M6']);
  });

  it('omits modes_skipped from the file when none provided', () => {
    writeIntegrityReceipt(project, 'A1-pool', ['M2', 'M4'], 'lit pool reviewed', []);
    const raw = fs.readFileSync(integrityLogPath(project), 'utf-8');
    expect(raw).not.toContain('modes_skipped');
  });

  it('appends to existing log without overwriting prior entries', () => {
    writeIntegrityReceipt(project, 'A1-pool', ['M2', 'M4'], 'lit pool reviewed', []);
    writeIntegrityReceipt(project, 'A3-comp', ['M3', 'M5'], 'compute approved', []);
    const all = readIntegrityReceipts(project);
    expect(all.map((r) => r.approval_id)).toEqual(['A1-pool', 'A3-comp']);
  });
});

describe('verifyIntegrityReceipt rejection paths', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('LOG_MISSING when integrity log does not exist', () => {
    try {
      verifyIntegrityReceipt(project, 'A1-test', { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const m = err as McpError;
      expect(m.code).toBe('INTEGRITY_RECEIPT_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('LOG_MISSING');
    }
  });

  it('RECEIPT_MISSING when log exists but has no receipt for this approval', () => {
    writeIntegrityReceipt(project, 'A1-other', ['M2'], 'other gate', []);
    try {
      verifyIntegrityReceipt(project, 'A3-target', { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect(m.code).toBe('INTEGRITY_RECEIPT_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('RECEIPT_MISSING');
    }
  });

  it('RECEIPT_INVALID when log lines are present but malformed', () => {
    const logPath = integrityLogPath(project);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'not-valid-json\n{"schema_version": 2}\n');
    try {
      verifyIntegrityReceipt(project, 'A3-target', { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect(m.code).toBe('INTEGRITY_RECEIPT_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('RECEIPT_INVALID');
    }
  });

  it('a single malformed line does not poison valid receipts for other approval_ids', () => {
    writeIntegrityReceipt(project, 'A1-good', ['M2'], 'pool ok', []);
    fs.appendFileSync(integrityLogPath(project), 'corrupted-line\n');
    writeIntegrityReceipt(project, 'A3-good', ['M3'], 'compute ok', []);
    const verified = verifyIntegrityReceipt(project, 'A1-good', { env: FORCE_ON_ENV });
    expect(verified.approval_id).toBe('A1-good');
    const verified2 = verifyIntegrityReceipt(project, 'A3-good', { env: FORCE_ON_ENV });
    expect(verified2.approval_id).toBe('A3-good');
  });
});

describe('verifyIntegrityReceipt latest-wins semantics', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('returns the latest receipt when an approval_id appears multiple times', () => {
    writeIntegrityReceipt(project, 'A4-paper', ['M2'], 'first pass; M3 caught issue', []);
    writeIntegrityReceipt(project, 'A4-paper', ['M2', 'M3', 'M4'], 'second pass after fix', []);
    const v = verifyIntegrityReceipt(project, 'A4-paper', { env: FORCE_ON_ENV });
    expect(v.modes_checked).toEqual(['M2', 'M3', 'M4']);
    expect(v.notes).toContain('second pass');
  });
});

describe('verifyIntegrityReceipt skip semantics', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('returns a synthetic receipt without touching disk when skipped', () => {
    const v = verifyIntegrityReceipt(project, 'A1-noop', {
      env: { NULLIUS_INTEGRITY_VERIFY: 'skip' } as NodeJS.ProcessEnv,
    });
    expect(v.approval_id).toBe('A1-noop');
    expect(v.notes).toContain('skip-mode');
    expect(fs.existsSync(integrityLogPath(project))).toBe(false);
  });

  it('NODE_ENV=test default also returns synthetic receipt', () => {
    const v = verifyIntegrityReceipt(project, 'A1-noop', {
      env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
    });
    expect(v.notes).toContain('skip-mode');
  });
});

describe('readIntegrityReceipts', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('returns empty array when log does not exist', () => {
    expect(readIntegrityReceipts(project)).toEqual([]);
  });

  it('returns all receipts in order, skipping malformed lines silently', () => {
    writeIntegrityReceipt(project, 'A1-a', ['M2'], 'a', []);
    fs.appendFileSync(integrityLogPath(project), 'garbage\n');
    writeIntegrityReceipt(project, 'A3-b', ['M3'], 'b', []);
    fs.appendFileSync(integrityLogPath(project), '{"schema_version":99}\n');
    writeIntegrityReceipt(project, 'A5-c', ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'], 'c', []);
    const all = readIntegrityReceipts(project);
    expect(all.map((r) => r.approval_id)).toEqual(['A1-a', 'A3-b', 'A5-c']);
  });
});
