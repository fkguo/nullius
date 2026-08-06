import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBytesAtomicDurable } from '@nullius/shared';
import { readValidityLedger, type ValidityLedgerView } from './validity-ledger.js';
import { effectiveCodeIdentity } from './run-origin.js';
import type { RunOriginV1 } from '@nullius/shared';

/** Current-results registry: the project's answer to "what is the current
 *  best result", as a marker-delimited block in project_index.md with the
 *  same contract strength as the proven manuscript registry — result ids
 *  unique, exactly one current row per supersession chain, artifact present
 *  and hash-matched, and the named run stamped and valid in the ledger.
 *
 *  Selection is research judgment (made at milestone convergence); the
 *  machine guards structure and liveness, never picks "best". This module
 *  is the ONE parser/writer for the block — a second implementation
 *  elsewhere would be the dual-parser drift the design forbids.
 */

export const RESULT_REGISTRY_START = '<!-- RESULT_REGISTRY_START -->';
export const RESULT_REGISTRY_END = '<!-- RESULT_REGISTRY_END -->';
const SAFE_RESULT_ID = /^[a-z0-9][a-z0-9._-]*$/;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESULT_TABLE_COLUMNS = 6;

export type ResultRegistryRow = {
  result_id: string;
  description: string;
  artifact_target: string | null;
  artifact_sha256: string;
  run_id: string;
  effective_commit: string | null;
  has_snapshot: boolean;
  supersedes: string;
  superseded_by: string;
};

/** Characters that would break the markdown table round-trip: a cell
 *  containing them writes a row the parser could not see again, and a
 *  silently-unseen row makes the acceptance surface state a falsehood
 *  ("no result registered") — the exact silent-false-precision failure the
 *  design forbids. The writer refuses them up front. */
const CELL_BREAKERS = /[|\r\n]/;

function assertCellSafe(label: string, value: string): void {
  if (CELL_BREAKERS.test(value)) {
    throw new Error(`${label} must not contain '|' or newlines (they would break the registry table round-trip)`);
  }
}

export type ResultRegistryIssue = { code: string; message: string; path: string };

export type ResultRegistryState = {
  block_found: boolean;
  rows: ResultRegistryRow[];
  /** Rows with superseded_by === 'none' — the current results. */
  current: ResultRegistryRow[];
  issues: ResultRegistryIssue[];
};

function issue(code: string, message: string): ResultRegistryIssue {
  return { code, message, path: 'project_index.md' };
}

function blockBounds(text: string): { start: number; end: number } | null {
  if (text.split(RESULT_REGISTRY_START).length !== 2) return null;
  if (text.split(RESULT_REGISTRY_END).length !== 2) return null;
  const start = text.indexOf(RESULT_REGISTRY_START) + RESULT_REGISTRY_START.length;
  const end = text.indexOf(RESULT_REGISTRY_END);
  return start < end ? { start, end } : null;
}

/** Parse the "run_id @ shortsha[+snapshot]" current-run cell. When the tail
 *  after the last " @ " is not a commit, the WHOLE cell is the run id —
 *  never silently truncate an exotic id at a separator that happened to
 *  match. */
function parseRunCell(cell: string): { run_id: string; effective_commit: string | null; has_snapshot: boolean } {
  const trimmed = cell.replace(/`/g, '').trim();
  const at = trimmed.lastIndexOf(' @ ');
  if (at < 0) return { run_id: trimmed, effective_commit: null, has_snapshot: false };
  const tail = trimmed.slice(at + 3).trim();
  const hasSnapshot = tail.endsWith('+snapshot');
  const commit = hasSnapshot ? tail.slice(0, -'+snapshot'.length) : tail;
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    return { run_id: trimmed, effective_commit: null, has_snapshot: false };
  }
  return { run_id: trimmed.slice(0, at).trim(), effective_commit: commit, has_snapshot: hasSnapshot };
}

export function parseResultRegistry(projectRoot: string): ResultRegistryState {
  const issues: ResultRegistryIssue[] = [];
  const state: ResultRegistryState = { block_found: false, rows: [], current: [], issues };
  const indexPath = path.join(projectRoot, 'project_index.md');
  if (!fs.existsSync(indexPath)) return state;
  const text = fs.readFileSync(indexPath, 'utf-8');
  const bounds = blockBounds(text);
  if (!bounds) return state;
  state.block_found = true;
  const block = text.slice(bounds.start, bounds.end);
  const seen = new Set<string>();
  for (const line of block.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    if (cells.length !== RESULT_TABLE_COLUMNS) {
      // A pipe-prefixed line inside the block with the wrong cell count is a
      // row the registry cannot see — reported, never silently skipped
      // (silent skipping turned a written row into "no result registered").
      issues.push(issue('malformed_result_row', `table line has ${cells.length} cells, expected ${RESULT_TABLE_COLUMNS}: ${line.trim().slice(0, 80)}`));
      continue;
    }
    if (cells[0] === 'Result ID' || /^-+$/.test(cells[0]!.replace(/\s/g, '')) || cells[0] === '') continue;
    const resultId = cells[0]!.replace(/`/g, '');
    if (!SAFE_RESULT_ID.test(resultId)) {
      issues.push(issue('invalid_result_id', `result id ${JSON.stringify(resultId)} is not a safe id`));
      continue;
    }
    if (seen.has(resultId)) {
      issues.push(issue('duplicate_result_id', `duplicate registry row for ${resultId}`));
      continue;
    }
    seen.add(resultId);
    const link = MARKDOWN_LINK.exec(cells[1]!);
    const runCell = parseRunCell(cells[3]!);
    state.rows.push({
      result_id: resultId,
      description: cells[1]!,
      artifact_target: link ? link[1]!.trim() : null,
      artifact_sha256: cells[2]!.replace(/`/g, ''),
      run_id: runCell.run_id,
      effective_commit: runCell.effective_commit,
      has_snapshot: runCell.has_snapshot,
      supersedes: cells[4]!.replace(/`/g, '') || 'none',
      superseded_by: cells[5]!.replace(/`/g, '') || 'none',
    });
  }
  state.current = state.rows.filter(row => row.superseded_by === 'none');
  return state;
}

/** Chain-shape validation, mirroring the report registry's head/acyclicity
 *  checks: every supersession component must be one acyclic chain with
 *  exactly one head (superseded_by = none). A hand-edited cycle otherwise
 *  validates with zero issues, zero current rows, and the surface saying
 *  "no result registered" — a misdiagnosis. */
function checkChains(rows: ResultRegistryRow[], issues: ResultRegistryIssue[], defective?: Set<string>): void {
  const byId = new Map(rows.map(row => [row.result_id, row]));
  const visitedGlobal = new Set<string>();
  for (const row of rows) {
    if (visitedGlobal.has(row.result_id)) continue;
    // Walk back to the oldest ancestor, cycle-guarded.
    const seen = new Set<string>();
    let cursor: ResultRegistryRow | undefined = row;
    while (cursor && cursor.supersedes !== 'none' && byId.has(cursor.supersedes)) {
      if (seen.has(cursor.result_id)) break;
      seen.add(cursor.result_id);
      cursor = byId.get(cursor.supersedes);
    }
    // Walk forward from the oldest ancestor collecting the component.
    const component: string[] = [];
    const forwardSeen = new Set<string>();
    let node: ResultRegistryRow | undefined = cursor;
    let cyclic = false;
    while (node) {
      if (forwardSeen.has(node.result_id)) {
        cyclic = true;
        break;
      }
      forwardSeen.add(node.result_id);
      component.push(node.result_id);
      node = node.superseded_by !== 'none' ? byId.get(node.superseded_by) : undefined;
    }
    for (const id of component) visitedGlobal.add(id);
    if (cyclic) {
      issues.push(issue('cyclic_result_supersession', `supersession cycle through ${component.join(' → ')}`));
      for (const id of component) defective?.add(id);
      continue;
    }
    const heads = component.filter(id => byId.get(id)!.superseded_by === 'none');
    if (heads.length !== 1) {
      issues.push(issue('result_chain_head_not_unique', `chain ${component.join(' → ')} has ${heads.length} current head(s); exactly one expected`));
      for (const id of component) defective?.add(id);
    }
  }
}

/** Resolve an artifact target with the SAME containment strength as the
 *  report registry's resolver: project-relative, no traversal, no symlink
 *  component or leaf anywhere between root and file, and realpath contained
 *  in the project. A symlink would let a registry row hash — and claim
 *  "present and SHA-256-matched" for — mutable content physically outside
 *  the project. Shared by the validator AND the writer (one rule, no
 *  writer/validator asymmetry). */
export function resolveResultArtifact(
  projectRoot: string,
  resultId: string,
  target: string | null,
  issues: ResultRegistryIssue[],
): string | null {
  if (!target) {
    issues.push(issue('result_artifact_link_missing', `${resultId} has no artifact Markdown link`));
    return null;
  }
  if (target.startsWith('/') || /^[a-z]+:/i.test(target)) {
    issues.push(issue('invalid_result_artifact_target', `${resultId} must use a project-relative link`));
    return null;
  }
  const relative = target.split('#')[0]!;
  const parts = relative.split('/').filter(part => part.length > 0);
  if (parts.includes('..')) {
    issues.push(issue('invalid_result_artifact_target', `${resultId} target cannot contain parent traversal`));
    return null;
  }
  const rootReal = fs.existsSync(projectRoot) ? fs.realpathSync(projectRoot) : projectRoot;
  let cursor = rootReal;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      issues.push(issue('result_artifact_missing', `${resultId} artifact ${relative} does not exist`));
      return null;
    }
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      issues.push(issue('invalid_result_artifact_target', `${resultId} target passes through a symlink (${part}); artifacts must be regular files inside the project`));
      return null;
    }
  }
  if (!fs.statSync(cursor).isFile()) {
    issues.push(issue('result_artifact_missing', `${resultId} artifact ${relative} is not a regular file`));
    return null;
  }
  const real = fs.realpathSync(cursor);
  if (real !== cursor && !real.startsWith(rootReal + path.sep)) {
    issues.push(issue('result_artifact_escapes_project', `${resultId} artifact escapes the project root`));
    return null;
  }
  return cursor;
}

/** Full validation: structure + artifact hashes + chain shape + run
 *  liveness against the validity ledger. Every row is checked — a
 *  historical (superseded) row still needs its stamp and honest fields;
 *  only the ACTIVE-validity requirement is specific to current rows (a
 *  superseded row's run is legitimately superseded/void in the ledger).
 *  `defective_result_ids` lets renderers mark rows instead of presenting a
 *  defective row as a clean current result. */
export function validateResultRegistry(
  projectRoot: string,
  ledgerView?: ValidityLedgerView,
): ResultRegistryState & { defective_result_ids: Set<string> } {
  const state = parseResultRegistry(projectRoot);
  const defective = new Set<string>();
  const out = Object.assign(state, { defective_result_ids: defective });
  if (!state.block_found) return out;
  const issuesBefore = (): number => state.issues.length;
  const markIfGrew = (row: ResultRegistryRow, before: number): void => {
    if (state.issues.length > before) defective.add(row.result_id);
  };
  const byId = new Map(state.rows.map(row => [row.result_id, row]));
  const ledger = ledgerView ?? readValidityLedger(projectRoot);
  checkChains(state.rows, state.issues, defective);
  for (const row of state.rows) {
    const before = issuesBefore();
    if (!SHA256_HEX.test(row.artifact_sha256)) {
      state.issues.push(issue('invalid_result_sha256', `${row.result_id} SHA-256 cell is not a 64-hex digest`));
    } else {
      const artifactPath = resolveResultArtifact(projectRoot, row.result_id, row.artifact_target, state.issues);
      if (artifactPath) {
        const digest = createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
        if (digest !== row.artifact_sha256) {
          state.issues.push(issue('result_artifact_mutated', `${row.result_id} artifact no longer matches its registered SHA-256`));
        }
      }
    }
    // Both direction columns must agree, like the report registry.
    if (row.supersedes !== 'none') {
      const older = byId.get(row.supersedes);
      if (!older || older.superseded_by !== row.result_id) {
        state.issues.push(issue('broken_result_supersession', `${row.result_id} and ${row.supersedes} do not record both relation directions`));
      }
    }
    if (row.superseded_by !== 'none' && (!byId.get(row.superseded_by) || byId.get(row.superseded_by)!.supersedes !== row.result_id)) {
      state.issues.push(issue('broken_result_supersession', `${row.result_id} and ${row.superseded_by} do not record both relation directions`));
    }
    // Run liveness: EVERY row needs its stamp; current rows additionally
    // need an active, unquarantined run with a consistent exact identity.
    const known = ledger.runs.get(row.run_id);
    if (!known || !known.stamped) {
      state.issues.push(issue('result_run_unstamped', `${row.result_id} names run ${row.run_id}, which carries no origin stamp`));
    } else {
      if (known.no_authoritative_identity) {
        state.issues.push(issue('result_run_no_identity', `${row.result_id} names run ${row.run_id}, which is quarantined by a ledger-integrity defect`));
      }
      const effective = known.origin ? effectiveCodeIdentity(known.origin as RunOriginV1) : null;
      if (row.superseded_by === 'none') {
        if (known.validity !== 'active') {
          state.issues.push(issue('result_run_not_active', `${row.result_id} names run ${row.run_id}, whose ledger state is ${known.validity}`));
        }
        if (!effective) {
          state.issues.push(issue('result_run_not_exact', `${row.result_id} names run ${row.run_id}, whose stamp has no exact code identity (aligned/unbound bindings cannot back a current result)`));
        }
      }
      if (row.effective_commit && effective && !effective.startsWith(row.effective_commit)) {
        state.issues.push(issue('result_run_commit_mismatch', `${row.result_id} records commit ${row.effective_commit} but the run's stamp says ${effective.slice(0, 12)}`));
      }
    }
    markIfGrew(row, before);
  }
  return out;
}

/** Write/update one registry row and maintain both direction columns.
 *  Hand edits stay legal — this writer just makes the common flow one
 *  command. The block must already exist (scaffolded, or added by hand). */
export function setCurrentResult(
  projectRoot: string,
  input: { resultId: string; runId: string; artifactRelPath: string; description?: string; supersedes?: string },
): { row: ResultRegistryRow } {
  if (!SAFE_RESULT_ID.test(input.resultId)) {
    throw new Error(`result id ${JSON.stringify(input.resultId)} must match ${SAFE_RESULT_ID}`);
  }
  // Round-trip safety first: refuse any field a markdown cell cannot carry,
  // instead of writing a row the parser would silently un-see.
  assertCellSafe('run id', input.runId);
  assertCellSafe('artifact path', input.artifactRelPath);
  if (input.description !== undefined) assertCellSafe('description', input.description);
  if (input.runId.includes('`')) {
    throw new Error('run id must not contain backticks (the registry cell is backtick-wrapped)');
  }
  const indexPath = path.join(projectRoot, 'project_index.md');
  if (!fs.existsSync(indexPath)) throw new Error('project_index.md not found; run nullius init first');
  const text = fs.readFileSync(indexPath, 'utf-8');
  const bounds = blockBounds(text);
  if (!bounds) {
    throw new Error(
      `project_index.md has no ${RESULT_REGISTRY_START} block; paste the Current results section from the `
      + 'scaffold template once (a plain `nullius init` writes it for a NEW project; refresh never rewrites '
      + 'user-owned project_index.md)',
    );
  }
  // Same containment rule as the validator — no writer/validator asymmetry:
  // a row the validator would flag must not be mintable with exit 0.
  const preflight: ResultRegistryIssue[] = [];
  const artifactAbsolute = resolveResultArtifact(projectRoot, input.resultId, input.artifactRelPath, preflight);
  if (!artifactAbsolute) {
    throw new Error(preflight.map(entry => entry.message).join('; ') || `artifact ${input.artifactRelPath} is not registrable`);
  }
  const digest = createHash('sha256').update(fs.readFileSync(artifactAbsolute)).digest('hex');
  const ledger = readValidityLedger(projectRoot);
  const known = ledger.runs.get(input.runId);
  if (!known || !known.stamped) {
    throw new Error(`run ${input.runId} carries no origin stamp; run \`nullius trace stamp\` first`);
  }
  if (known.validity !== 'active') {
    throw new Error(`run ${input.runId} is ${known.validity} in the validity ledger; a current result must name an active run`);
  }
  if (known.no_authoritative_identity) {
    throw new Error(`run ${input.runId} is quarantined by a ledger-integrity defect; repair the ledger first`);
  }
  const effective = known.origin ? effectiveCodeIdentity(known.origin as RunOriginV1) : null;
  if (!effective) {
    throw new Error(
      `run ${input.runId} has no exact code identity (its stamp is aligned_heuristic or unbound); `
      + 'a current result must name an exactly-bound run',
    );
  }
  const originRecord = known.origin as unknown as Record<string, unknown> | null;
  const snapshotMarker = originRecord && typeof originRecord.snapshot_commit === 'string' ? '+snapshot' : '';
  const runCell = `${input.runId} @ ${effective.slice(0, 12)}${snapshotMarker}`;

  const state = parseResultRegistry(projectRoot);
  const existing = state.rows.find(row => row.result_id === input.resultId);
  // Chain protection at the writer (the validator would catch all of these
  // later, but a one-command flow must not mint a defective row with exit 0):
  if (existing && existing.superseded_by !== 'none') {
    throw new Error(
      `${input.resultId} is already superseded by ${existing.superseded_by}; register the new value as a `
      + 'NEW result id superseding that head instead of re-currenting a superseded row',
    );
  }
  const supersedes = input.supersedes ?? existing?.supersedes ?? 'none';
  if (supersedes === input.resultId) {
    throw new Error('a result cannot supersede itself');
  }
  if (supersedes !== 'none') {
    const older = state.rows.find(row => row.result_id === supersedes);
    if (!older) {
      throw new Error(`--supersedes names ${supersedes}, which is not a registered result id`);
    }
    if (older.superseded_by !== 'none' && older.superseded_by !== input.resultId) {
      throw new Error(
        `${supersedes} is already superseded by ${older.superseded_by}; supersede the chain head instead`,
      );
    }
  }
  // Description: a provided plain-text description keeps its text and gains
  // the artifact link; a provided linked description must link the SAME
  // artifact (the hash column hashes that path — a divergent link would
  // describe one file and hash another).
  let description: string;
  if (input.description !== undefined) {
    const linked = MARKDOWN_LINK.exec(input.description);
    if (linked) {
      if (linked[1]!.trim() !== input.artifactRelPath) {
        throw new Error(
          `--description links ${linked[1]} but --artifact is ${input.artifactRelPath}; `
          + 'the description link must name the hashed artifact',
        );
      }
      description = input.description;
    } else {
      description = `${input.description} — [artifact](${input.artifactRelPath})`;
    }
  } else if (existing) {
    description = existing.description.replace(/\]\([^)]*\)/, `](${input.artifactRelPath})`);
  } else {
    description = `[${input.resultId}](${input.artifactRelPath})`;
  }
  const newLine = `| \`${input.resultId}\` | ${description} | \`${digest}\` | \`${runCell}\` | \`${supersedes}\` | \`none\` |`;

  const block = text.slice(bounds.start, bounds.end);
  const lines = block.split('\n');
  let replaced = false;
  const updated = lines.map((line) => {
    if (!line.trim().startsWith('|')) return line;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    if (cells.length !== RESULT_TABLE_COLUMNS) return line;
    const rowId = cells[0]!.replace(/`/g, '');
    if (rowId === input.resultId) {
      replaced = true;
      return newLine;
    }
    if (rowId === supersedes && supersedes !== 'none') {
      cells[5] = `\`${input.resultId}\``;
      return `| ${cells.join(' | ')} |`;
    }
    return line;
  });
  let newBlock = updated.join('\n');
  if (!replaced) {
    newBlock = `${newBlock.replace(/\n$/, '')}\n${newLine}\n`;
  }
  // Atomic durable write: this file also carries the manuscript registry —
  // a crash mid-write must not truncate it, and the rename gives concurrent
  // readers a consistent before-or-after view.
  writeBytesAtomicDurable(indexPath, text.slice(0, bounds.start) + newBlock + text.slice(bounds.end));
  return {
    row: {
      result_id: input.resultId,
      description,
      artifact_target: input.artifactRelPath,
      artifact_sha256: digest,
      run_id: input.runId,
      effective_commit: effective.slice(0, 12),
      has_snapshot: snapshotMarker.length > 0,
      supersedes,
      superseded_by: 'none',
    },
  };
}
