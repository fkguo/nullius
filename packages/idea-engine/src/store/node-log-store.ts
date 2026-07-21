import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync } from 'fs';

export type NodeLogCorruptionKind = 'interior_corruption' | 'torn_final';

/** Distinguishes a potentially torn final append from persistent corruption. */
export class NodeLogCorruptionError extends Error {
  readonly kind: NodeLogCorruptionKind;
  readonly lineNumber: number;

  constructor(kind: NodeLogCorruptionKind, lineNumber: number, message: string) {
    super(message);
    this.name = 'NodeLogCorruptionError';
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

/** Parse every non-empty ledger line and classify the first invalid value. */
export function loadNodeLogEntriesStrict(path: string): Array<Record<string, unknown>> {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const lines = contents.split('\n');
  const finalSegmentIndex = lines.length - 1;
  const hasTrailingNewline = contents.endsWith('\n');
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSONL value is not an object');
      }
      entries.push(parsed as Record<string, unknown>);
    } catch (error) {
      const kind: NodeLogCorruptionKind = !hasTrailingNewline && index === finalSegmentIndex
        ? 'torn_final'
        : 'interior_corruption';
      throw new NodeLogCorruptionError(
        kind,
        index + 1,
        `node log ${kind} at line ${index + 1}: ${String((error as Error).message)}`,
      );
    }
  }
  return entries;
}

/** Truncate only an exact strict prefix of the prepared final event. */
export function repairTornFinalNodeLogEntry(path: string, expectedEntry: Record<string, unknown>): boolean {
  const contents = readFileSync(path);
  if (contents.length === 0 || contents[contents.length - 1] === 0x0a) return false;
  const lastNewline = contents.lastIndexOf(0x0a);
  const fragmentStart = lastNewline + 1;
  const fragment = contents.subarray(fragmentStart);
  const expected = Buffer.from(JSON.stringify(expectedEntry), 'utf8');
  if (fragment.length === 0 || fragment.length >= expected.length || !expected.subarray(0, fragment.length).equals(fragment)) {
    throw new NodeLogCorruptionError(
      'torn_final',
      contents.subarray(0, fragmentStart).toString('utf8').split('\n').length,
      'final node-log fragment is not a strict byte prefix of the prepared event',
    );
  }

  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, fragmentStart);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}
