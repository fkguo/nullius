// @autoresearch/orchestrator — LedgerWriter (NEW-05a Stage 1)
// Append-only ledger for audit trail. Compatible with Python ledger.jsonl format.
// Python uses json.dumps(event, sort_keys=True) — we use recursive key sorting.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LedgerEvent } from './types.js';

const AUTORESEARCH_DIRNAME = '.autoresearch';
const AUTORESEARCH_CONTROL_DIR_ENV = 'AUTORESEARCH_CONTROL_DIR';
const LEDGER_FILENAME = 'ledger.jsonl';

function ledgerPath(repoRoot: string): string {
  const override = process.env[AUTORESEARCH_CONTROL_DIR_ENV];
  const dir = override
    ? (path.isAbsolute(override) ? override : path.join(repoRoot, override))
    : path.join(repoRoot, AUTORESEARCH_DIRNAME);
  return path.join(dir, LEDGER_FILENAME);
}

import { sortKeysRecursive } from './util.js';

export class LedgerWriter {
  private readonly filePath: string;

  constructor(repoRoot: string) {
    this.filePath = ledgerPath(repoRoot);
  }

  /** Append an event to the ledger. Creates the file if it doesn't exist.
   *  Keys are sorted recursively to match Python json.dumps(sort_keys=True). */
  append(event: LedgerEvent): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(sortKeysRecursive(event)) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf-8');
  }

  /** Convenience: append an event with auto-timestamp. */
  log(
    eventType: string,
    options?: {
      run_id?: string | null;
      workflow_id?: string | null;
      step_id?: string | null;
      details?: Record<string, unknown>;
    },
  ): void {
    this.append({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      event_type: eventType,
      run_id: options?.run_id ?? null,
      workflow_id: options?.workflow_id ?? null,
      step_id: options?.step_id ?? null,
      details: options?.details ?? {},
    });
  }

  /** Read the last N events from the ledger. */
  tail(n: number): LedgerEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const result: LedgerEvent[] = [];
    for (const line of lines.slice(-n)) {
      try {
        result.push(JSON.parse(line) as LedgerEvent);
      } catch {
        // Skip malformed ledger lines (CONTRACT-EXEMPT: CODE-01.5 skip malformed ledger lines)
      }
    }
    return result;
  }
}
