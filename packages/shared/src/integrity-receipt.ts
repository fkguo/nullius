/**
 * P3-A followup-4: Integrity receipt for approval-gate machine check.
 *
 * Mirrors the {@link ./harness-invocation.ts} pattern but for the agent-side
 * M1-M7 discipline defined by the `research-integrity` skill: every A1-A5
 * approval must be preceded by an integrity receipt that records which modes
 * the agent walked. The receipt's *existence* and *schema* are machine-checked
 * inside `handleOrchRunApprove`; the *content* of the receipt is agent-judged
 * and not validated by code.
 *
 * The point is to close the same long-conversation drift gap that
 * `HARNESS_INVOCATION_REQUIRED` closes for tool dispatch: an agent whose
 * context has evicted `research-integrity` SKILL.md cannot silently approve
 * across an A1-A5 boundary without leaving a trace the next reader can
 * verify.
 *
 * ## File format
 *
 * Append-only JSONL at `.autoresearch/integrity_log.jsonl`. Each line is one
 * receipt, written via `appendJsonlDurable` to survive crash between
 * syscalls. We never rewrite past lines; the file grows monotonically with
 * approval history.
 *
 * ## Schema (v1)
 *
 * ```jsonc
 * {
 *   "schema_version": 1,
 *   "kind": "autoresearch_integrity_receipt",
 *   "approval_id": "A3-20260522T080000Z-...",
 *   "timestamp_utc": "2026-05-22T08:30:00Z",
 *   "modes_checked": ["M3", "M5", "M6"],          // at least one
 *   "modes_skipped": [                            // optional, per-mode reason
 *     { "mode": "M1", "reason": "no code change in this gate" }
 *   ],
 *   "notes": "freeform agent prose, <500 chars; not schema-validated"
 * }
 * ```
 *
 * `modes_checked` must be non-empty; an agent claiming to have approved
 * across an integrity boundary while checking zero modes is exactly the
 * failure mode this gate exists to catch. Empty checks must be expressed by
 * listing all 7 modes in `modes_skipped` with explicit reasons.
 *
 * ## Skip semantics
 *
 *   - `process.env.AUTORESEARCH_INTEGRITY_VERIFY === 'skip'` → skip
 *   - `process.env.AUTORESEARCH_INTEGRITY_VERIFY === 'on'`   → force verify
 *   - else `process.env.NODE_ENV === 'test'`                 → skip (vitest)
 *   - else                                                   → verify
 *
 * The NODE_ENV=test default keeps the existing approval test suite green
 * without per-test setup; the explicit `on` override lets the regression test
 * exercise the rejection path.
 *
 * ## Why not enforce specific mode coverage?
 *
 * The mapping from gate (A1-A5) to *which* modes most likely apply is
 * documented in `skills/research-integrity/SKILL.md` (the "Pre-approval
 * ritual" table). Encoding that mapping in code would force the agent to
 * skip-with-reason every irrelevant mode for every gate, producing noise
 * without signal. The contract here is the cheaper one: *some* deliberate
 * mode walk happened, recorded in agent prose, and the next reader can
 * audit `modes_checked` + `notes` to judge whether it was substantive.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError, type ErrorCode } from './errors.js';
import { appendJsonlDurable } from './atomic-write.js';

export const INTEGRITY_LOG_FILE = '.autoresearch/integrity_log.jsonl';
const INTEGRITY_RECEIPT_KIND = 'autoresearch_integrity_receipt' as const;

const INTEGRITY_RECEIPT_REQUIRED_CODE = 'INTEGRITY_RECEIPT_REQUIRED' satisfies ErrorCode;

export const INTEGRITY_MODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] as const;
export type IntegrityMode = (typeof INTEGRITY_MODES)[number];

export type IntegrityReceipt = {
  schema_version: 1;
  kind: typeof INTEGRITY_RECEIPT_KIND;
  approval_id: string;
  timestamp_utc: string;
  modes_checked: IntegrityMode[];
  modes_skipped?: Array<{ mode: IntegrityMode; reason: string }>;
  notes: string;
};

export type IntegrityReceiptReason =
  | 'LOG_MISSING'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_INVALID';

export type IntegrityVerifyOptions = {
  /** Override env for skip-mode detection in tests. */
  env?: NodeJS.ProcessEnv;
};

export type IntegrityWriteOptions = {
  /** Override timestamp written into the receipt. Tests use this. */
  now?: Date;
};

const NOTES_MAX_LEN = 500;

export function isIntegrityVerifySkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = typeof env.AUTORESEARCH_INTEGRITY_VERIFY === 'string'
    ? env.AUTORESEARCH_INTEGRITY_VERIFY.trim().toLowerCase()
    : '';
  if (explicit === 'skip') return true;
  if (explicit === 'on') return false;
  return env.NODE_ENV === 'test';
}

export function integrityLogPath(projectRoot: string): string {
  return path.join(projectRoot, INTEGRITY_LOG_FILE);
}

function integrityReceiptError(
  reason: IntegrityReceiptReason,
  projectRoot: string,
  approvalId: string,
  extra: Record<string, unknown> = {},
): McpError {
  const message = (() => {
    switch (reason) {
      case 'LOG_MISSING':
        return `No integrity receipt log found for project (.autoresearch/integrity_log.jsonl). Run \`autoresearch integrity-record\` for approval ${approvalId} before approving.`;
      case 'RECEIPT_MISSING':
        return `No integrity receipt found for approval ${approvalId}. Walk the M1-M7 ritual from skills/research-integrity/SKILL.md and record it via \`autoresearch integrity-record\` before approving.`;
      case 'RECEIPT_INVALID':
        return `Integrity receipt for approval ${approvalId} is malformed; re-record before approving.`;
    }
  })();
  return new McpError(INTEGRITY_RECEIPT_REQUIRED_CODE, message, {
    reason,
    project_root: projectRoot,
    approval_id: approvalId,
    log_path: INTEGRITY_LOG_FILE,
    remediation:
      'Run `autoresearch integrity-record --approval-id <id> --modes <Mx,My,...> --notes "<summary>"` after walking the M1-M7 ritual; see skills/research-integrity/SKILL.md.',
    ...extra,
  });
}

function isIntegrityMode(value: unknown): value is IntegrityMode {
  return typeof value === 'string'
    && (INTEGRITY_MODES as readonly string[]).includes(value);
}

function isIntegrityReceipt(value: unknown): value is IntegrityReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.schema_version !== 1) return false;
  if (r.kind !== INTEGRITY_RECEIPT_KIND) return false;
  if (typeof r.approval_id !== 'string' || r.approval_id.length === 0) return false;
  if (typeof r.timestamp_utc !== 'string' || r.timestamp_utc.length === 0) return false;
  if (typeof r.notes !== 'string') return false;
  if (r.notes.length > NOTES_MAX_LEN) return false;
  if (!Array.isArray(r.modes_checked) || r.modes_checked.length === 0) return false;
  if (!r.modes_checked.every(isIntegrityMode)) return false;
  if (r.modes_skipped !== undefined) {
    if (!Array.isArray(r.modes_skipped)) return false;
    for (const s of r.modes_skipped) {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) return false;
      const skip = s as Record<string, unknown>;
      if (!isIntegrityMode(skip.mode)) return false;
      if (typeof skip.reason !== 'string' || skip.reason.length === 0) return false;
    }
  }
  return true;
}

/**
 * Append an integrity receipt to the project's integrity log.
 *
 * @throws McpError(INVALID_PARAMS) if the candidate receipt does not match
 *   the schema — refuse to persist bad data even from a trusted caller.
 */
export function writeIntegrityReceipt(
  projectRoot: string,
  approvalId: string,
  modesChecked: readonly IntegrityMode[],
  notes: string,
  modesSkipped: ReadonlyArray<{ mode: IntegrityMode; reason: string }> = [],
  opts: IntegrityWriteOptions = {},
): IntegrityReceipt {
  // approvalId must be a non-empty string at the primitive layer too — the
  // CLI parser already enforces this, but a programmatic caller writing an
  // empty approval_id would persist a receipt that verifyIntegrityReceipt
  // could never match (round-trip broken at the wrong layer).
  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    throw new McpError('INVALID_PARAMS',
      'approval_id must be a non-empty string.',
      { approval_id: approvalId },
    );
  }
  if (modesChecked.length === 0) {
    throw new McpError('INVALID_PARAMS',
      'modes_checked must be non-empty — record explicit skips via modes_skipped if no mode applied.',
      { approval_id: approvalId },
    );
  }
  for (const m of modesChecked) {
    if (!isIntegrityMode(m)) {
      throw new McpError('INVALID_PARAMS',
        `modes_checked contains invalid mode ${JSON.stringify(m)}; allowed: ${INTEGRITY_MODES.join(',')}`,
        { approval_id: approvalId },
      );
    }
  }
  for (const s of modesSkipped) {
    if (!isIntegrityMode(s.mode)) {
      throw new McpError('INVALID_PARAMS',
        `modes_skipped contains invalid mode ${JSON.stringify(s.mode)}`,
        { approval_id: approvalId },
      );
    }
    if (typeof s.reason !== 'string' || s.reason.length === 0) {
      throw new McpError('INVALID_PARAMS',
        `modes_skipped[${s.mode}].reason must be a non-empty string`,
        { approval_id: approvalId },
      );
    }
  }
  if (typeof notes !== 'string') {
    throw new McpError('INVALID_PARAMS', 'notes must be a string', { approval_id: approvalId });
  }
  if (notes.length > NOTES_MAX_LEN) {
    throw new McpError('INVALID_PARAMS',
      `notes is ${notes.length} chars; max ${NOTES_MAX_LEN}. Keep the receipt summary terse — durable detail belongs in research_notebook.md.`,
      { approval_id: approvalId, notes_length: notes.length },
    );
  }
  const now = opts.now ?? new Date();
  const receipt: IntegrityReceipt = {
    schema_version: 1,
    kind: INTEGRITY_RECEIPT_KIND,
    approval_id: approvalId,
    timestamp_utc: now.toISOString(),
    modes_checked: [...modesChecked],
    ...(modesSkipped.length > 0 ? { modes_skipped: modesSkipped.map((s) => ({ ...s })) } : {}),
    notes,
  };
  appendJsonlDurable(integrityLogPath(projectRoot), receipt);
  return receipt;
}

/**
 * Verify that an integrity receipt exists for the given approval_id. Throws
 * `INTEGRITY_RECEIPT_REQUIRED` if the log is missing, the receipt is absent,
 * or the receipt is malformed.
 *
 * Honors the skip semantics documented in the module header — production
 * callers do not need to handle skip themselves.
 *
 * The append-only JSONL is scanned forward; the *latest* matching receipt
 * wins. An agent that re-records (e.g. after fixing an M5 catch) gets the
 * new entry honored, and the older entry is preserved for audit but does
 * not gate the approval.
 */
export function verifyIntegrityReceipt(
  projectRoot: string,
  approvalId: string,
  opts: IntegrityVerifyOptions = {},
): IntegrityReceipt {
  const env = opts.env ?? process.env;
  if (isIntegrityVerifySkipped(env)) {
    // Skip path: still return a synthetic receipt so callers that want to
    // log "skipped" can do so. This receipt is NOT persisted.
    return {
      schema_version: 1,
      kind: INTEGRITY_RECEIPT_KIND,
      approval_id: approvalId,
      timestamp_utc: new Date(0).toISOString(),
      modes_checked: ['M1'],
      notes: 'skip-mode (verify disabled by env)',
    };
  }

  const logPath = integrityLogPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch (err) {
    throw integrityReceiptError('LOG_MISSING', projectRoot, approvalId, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  let lastMatching: IntegrityReceipt | null = null;
  let lastInvalidReason: string | null = null;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A single malformed line does not poison the whole log — keep
      // scanning so older valid receipts still validate.
      lastInvalidReason = 'a log line is not valid JSON';
      continue;
    }
    if (!isIntegrityReceipt(parsed)) {
      lastInvalidReason = 'a log line does not match the receipt contract';
      continue;
    }
    if (parsed.approval_id === approvalId) {
      lastMatching = parsed;
    }
  }

  if (lastMatching) return lastMatching;

  if (lastInvalidReason !== null && lines.length > 0) {
    // Receipt for THIS approval_id was not found, but at least one line was
    // invalid. Report the more informative reason.
    throw integrityReceiptError('RECEIPT_INVALID', projectRoot, approvalId, {
      detail: lastInvalidReason,
    });
  }
  throw integrityReceiptError('RECEIPT_MISSING', projectRoot, approvalId);
}

/**
 * Read all receipts in the log without enforcing freshness or matching. Used
 * by diagnostic surfaces (e.g. `autoresearch status`) that want to report
 * the integrity history without forcing a rejection.
 *
 * Malformed lines are skipped (not thrown) so a corrupted line cannot make
 * the diagnostic view unreadable.
 */
export function readIntegrityReceipts(projectRoot: string): IntegrityReceipt[] {
  const logPath = integrityLogPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const out: IntegrityReceipt[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isIntegrityReceipt(parsed)) out.push(parsed);
  }
  return out;
}
