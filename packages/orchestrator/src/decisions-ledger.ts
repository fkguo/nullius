import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendJsonlDurable } from '@nullius/shared';
import { utcNowIso } from './util.js';

/** Append-only ledger of human decisions made in conversation.
 *
 *  Real projects resolve most questions conversationally ("use option 2",
 *  "confirmed, no change") and the outcome historically landed in hand-built
 *  markdown ledgers the engine never saw. This file is the engine-visible
 *  bookkeeping stratum of those decisions: one JSON line per event, sequential
 *  ids matching the D1, D2, ... convention those ledgers already used. The
 *  free-prose question documents stay project-owned; nothing here parses them.
 *
 *  Recording never gates anything: open decisions surface in the status
 *  receipt as information, not as a blocking state. */

export type DecisionKind = 'decided' | 'pending';

export type DecisionRecord = {
  /** Sequential "D<n>" id; never reused, survives interleaved kinds. */
  id: string;
  /** UTC ISO timestamp. */
  ts: string;
  kind: DecisionKind;
  /** What was decided (kind=decided) or what awaits a decision (kind=pending). */
  text: string;
  /** Who decided / who is being asked. Defaults to "user" at the CLI. */
  by: string;
  /** For kind=decided: id of the pending entry this decision closes. */
  resolves: string | null;
};

export type DecisionsLedgerSnapshot = {
  /** Project-relative POSIX path of the ledger file. */
  path: string;
  exists: boolean;
  records: DecisionRecord[];
  /** Lines that failed to parse or lacked required fields; never fatal. */
  invalid_lines: number;
};

const DECISION_ID_PATTERN = /^D(\d+)$/;

export function decisionsLedgerRelativePath(): string {
  return path.join('.nullius', 'decisions.jsonl').split(path.sep).join('/');
}

export function decisionsLedgerPath(projectRoot: string): string {
  return path.join(projectRoot, '.nullius', 'decisions.jsonl');
}

function parseDecisionLine(line: string): DecisionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || !DECISION_ID_PATTERN.test(record.id)) return null;
  if (typeof record.ts !== 'string') return null;
  if (record.kind !== 'decided' && record.kind !== 'pending') return null;
  if (typeof record.text !== 'string' || record.text.length === 0) return null;
  return {
    id: record.id,
    ts: record.ts,
    kind: record.kind,
    text: record.text,
    by: typeof record.by === 'string' && record.by.length > 0 ? record.by : 'user',
    resolves: typeof record.resolves === 'string' && DECISION_ID_PATTERN.test(record.resolves)
      ? record.resolves
      : null,
  };
}

export function readDecisionsLedger(projectRoot: string): DecisionsLedgerSnapshot {
  const filePath = decisionsLedgerPath(projectRoot);
  const relativePath = decisionsLedgerRelativePath();
  if (!fs.existsSync(filePath)) {
    return { path: relativePath, exists: false, records: [], invalid_lines: 0 };
  }
  const records: DecisionRecord[] = [];
  let invalidLines = 0;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = parseDecisionLine(line);
    if (record) {
      records.push(record);
    } else {
      invalidLines += 1;
    }
  }
  return { path: relativePath, exists: true, records, invalid_lines: invalidLines };
}

/** Pending entries not closed by any later decided entry. Oldest first. */
export function openDecisions(records: DecisionRecord[]): DecisionRecord[] {
  const resolved = new Set(
    records
      .filter((record) => record.kind === 'decided' && record.resolves !== null)
      .map((record) => record.resolves as string),
  );
  return records.filter((record) => record.kind === 'pending' && !resolved.has(record.id));
}

function nextDecisionId(records: DecisionRecord[]): string {
  let highest = 0;
  for (const record of records) {
    const match = DECISION_ID_PATTERN.exec(record.id);
    if (!match) continue;
    const value = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return `D${highest + 1}`;
}

export function appendDecision(
  projectRoot: string,
  params: { kind: DecisionKind; text: string; by?: string | null; resolves?: string | null },
): DecisionRecord {
  const trimmed = params.text.trim();
  if (trimmed.length === 0) {
    throw new Error('decision text must not be empty');
  }
  const runtimeDir = path.join(projectRoot, '.nullius');
  if (!fs.existsSync(runtimeDir)) {
    throw new Error('project is not initialized (missing .nullius/); run nullius init first');
  }
  const snapshot = readDecisionsLedger(projectRoot);
  let resolves: string | null = null;
  if (params.resolves) {
    if (params.kind !== 'decided') {
      throw new Error('--resolves is only valid when recording a decision');
    }
    const target = snapshot.records.find((record) => record.id === params.resolves);
    if (!target) {
      throw new Error(`--resolves ${params.resolves} does not match any recorded decision id`);
    }
    if (target.kind !== 'pending') {
      throw new Error(`--resolves ${params.resolves} points at a decided entry; only pending entries can be resolved`);
    }
    resolves = target.id;
  }
  const record: DecisionRecord = {
    id: nextDecisionId(snapshot.records),
    ts: utcNowIso(),
    kind: params.kind,
    text: trimmed,
    by: params.by && params.by.trim().length > 0 ? params.by.trim() : 'user',
    resolves,
  };
  appendJsonlDurable(decisionsLedgerPath(projectRoot), record);
  return record;
}
