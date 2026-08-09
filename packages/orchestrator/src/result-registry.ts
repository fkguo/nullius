import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBytesAtomicDurable } from '@nullius/shared';
import { readValidityLedger, type RunValidity, type ValidityLedgerView } from './validity-ledger.js';
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
  /** The run cell's +untracked marker: the binding is head_plus_untracked
   *  — the tracked tree is exact but untracked files were present, so the
   *  commit alone over-claims what produced the artifact. */
  has_untracked: boolean;
  supersedes: string;
  superseded_by: string;
};

/** Characters that would break the markdown table round-trip: a cell
 *  containing them writes a row the parser could not see again, and a
 *  silently-unseen row makes the acceptance surface state a falsehood
 *  ("no result registered") — the exact silent-false-precision failure the
 *  design forbids. The writer refuses them up front. */
const CELL_BREAKERS = /[|\r\n]/;
const COMMENT_DELIMITERS = /<!--|-->/;

function assertCellSafe(label: string, value: string): void {
  if (CELL_BREAKERS.test(value)) {
    throw new Error(`${label} must not contain '|' or newlines (they would break the registry table round-trip)`);
  }
  // Only the two comment-delimiter substrings can poison the marker
  // locator; a bare '<' or '>' (inequality prose like "χ²/dof < 1") is
  // harmless and stays legal.
  if (COMMENT_DELIMITERS.test(value)) {
    throw new Error(
      `${label} must not contain '<!--' or '-->' — an HTML comment delimiter could smuggle a literal marker `
      + 'into the very file whose markers delimit this registry',
    );
  }
}

export type ResultRegistryIssue = { code: string; message: string; path: string };

export type ResultRegistryState = {
  block_found: boolean;
  rows: ResultRegistryRow[];
  /** Rows with superseded_by === 'none' — the current results. */
  current: ResultRegistryRow[];
  issues: ResultRegistryIssue[];
  /** Ids that appeared more than once — the KEPT twin is untrustworthy too
   *  (which of the two lines the human meant is undecidable), so validation
   *  marks it defective. */
  duplicate_ids: Set<string>;
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
function parseRunCell(cell: string): { run_id: string; effective_commit: string | null; has_snapshot: boolean; has_untracked: boolean } {
  const trimmed = cell.replace(/`/g, '').trim();
  const at = trimmed.lastIndexOf(' @ ');
  if (at < 0) return { run_id: trimmed, effective_commit: null, has_snapshot: false, has_untracked: false };
  let tail = trimmed.slice(at + 3).trim();
  // Render order is <sha>[+snapshot][+untracked]; strip outermost first.
  const hasUntracked = tail.endsWith('+untracked');
  if (hasUntracked) tail = tail.slice(0, -'+untracked'.length);
  const hasSnapshot = tail.endsWith('+snapshot');
  if (hasSnapshot) tail = tail.slice(0, -'+snapshot'.length);
  if (!/^[0-9a-f]{7,40}$/.test(tail)) {
    return { run_id: trimmed, effective_commit: null, has_snapshot: false, has_untracked: false };
  }
  return { run_id: trimmed.slice(0, at).trim(), effective_commit: tail, has_snapshot: hasSnapshot, has_untracked: hasUntracked };
}

export function parseResultRegistry(projectRoot: string): ResultRegistryState {
  const issues: ResultRegistryIssue[] = [];
  const duplicateIds = new Set<string>();
  const state: ResultRegistryState = { block_found: false, rows: [], current: [], issues, duplicate_ids: duplicateIds };
  const indexPath = path.join(projectRoot, 'project_index.md');
  if (!fs.existsSync(indexPath)) return state;
  const text = fs.readFileSync(indexPath, 'utf-8');
  const bounds = blockBounds(text);
  if (!bounds) return state;
  state.block_found = true;
  const block = text.slice(bounds.start, bounds.end);
  const seen = new Set<string>();
  for (const line of block.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('|')) {
      // A non-empty, non-comment line inside the block that is not a table
      // row renders as content on GitHub while being invisible here — the
      // written-row-unseen misdiagnosis. Reported, never silently skipped.
      if (trimmedLine.length > 0 && !trimmedLine.startsWith('<!--')) {
        issues.push(issue('malformed_result_row', `non-table line inside the registry block: ${trimmedLine.slice(0, 80)}`));
      }
      continue;
    }
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
      duplicateIds.add(resultId);
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
      has_untracked: runCell.has_untracked,
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
export function checkChains(rows: ResultRegistryRow[], issues: ResultRegistryIssue[], defective?: Set<string>): void {
  const byId = new Map(rows.map(row => [row.result_id, row]));
  // Cycle detection runs on the FORWARD `supersedes` pointers alone — the
  // reverse column can be incomplete on a hand-edited registry, and a cycle
  // whose reverse links are broken must still be a cycle, not a clean head.
  const cyclicIds = new Set<string>();
  const walkState = new Map<string, 'walking' | 'done'>();
  for (const start of rows) {
    if (walkState.has(start.result_id)) continue;
    const trail: string[] = [];
    let cursor: ResultRegistryRow | undefined = start;
    while (cursor) {
      const state = walkState.get(cursor.result_id);
      if (state === 'done') {
        // A LATER walker whose chain reaches an already-processed cyclic
        // node is a prefix over that cycle too — first-walker-only marking
        // would let it render as a clean head over a cyclic lineage.
        // Transitive: reaching a cyclic node OR any node already marked
        // defective taints the whole trail — p → e → cycle must not leave
        // p looking like a clean head just because e absorbed the mark
        // first.
        if (cyclicIds.has(cursor.result_id) || defective?.has(cursor.result_id)) {
          for (const id of trail) defective?.add(id);
        }
        break;
      }
      if (state === 'walking') {
        // Everything from the first occurrence of cursor in the trail on is
        // the cycle proper; the PREFIX that walked into it is defective too
        // (carried stage-2 hook) — a clean-looking head chained onto a
        // cyclic lineage must not render as a trustworthy current result.
        const cycleStart = trail.indexOf(cursor.result_id);
        for (const id of trail.slice(cycleStart)) cyclicIds.add(id);
        for (const id of trail.slice(0, cycleStart)) defective?.add(id);
        break;
      }
      walkState.set(cursor.result_id, 'walking');
      trail.push(cursor.result_id);
      cursor = cursor.supersedes !== 'none' ? byId.get(cursor.supersedes) : undefined;
    }
    for (const id of trail) walkState.set(id, 'done');
  }
  if (cyclicIds.size > 0) {
    issues.push(issue('cyclic_result_supersession', `supersession cycle through ${[...cyclicIds].sort().join(', ')}`));
    for (const id of cyclicIds) defective?.add(id);
  }
  // Head uniqueness per UNDIRECTED component of the supersedes relation:
  // exactly one row with superseded_by = none. Undirected union survives
  // broken reverse columns.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const row of rows) parent.set(row.result_id, row.result_id);
  for (const row of rows) {
    if (row.supersedes !== 'none' && byId.has(row.supersedes)) {
      parent.set(find(row.result_id), find(row.supersedes));
    }
    if (row.superseded_by !== 'none' && byId.has(row.superseded_by)) {
      parent.set(find(row.result_id), find(row.superseded_by));
    }
  }
  const components = new Map<string, string[]>();
  for (const row of rows) {
    const root = find(row.result_id);
    const bucket = components.get(root) ?? [];
    bucket.push(row.result_id);
    components.set(root, bucket);
  }
  for (const component of components.values()) {
    if (component.some(id => cyclicIds.has(id))) continue;
    const heads = component.filter(id => byId.get(id)!.superseded_by === 'none');
    if (heads.length !== 1) {
      issues.push(issue('result_chain_head_not_unique', `chain ${component.sort().join(' → ')} has ${heads.length} current head(s); exactly one expected`));
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
/** The NO-IO subset of the current-row defect rules: everything a
 *  renderer can decide from the parsed row plus the ledger view alone —
 *  run missing/unstamped/not-active/resultless head, chain and identity
 *  defects, inexact binding, and the row↔stamp fidelity comparisons
 *  (commit prefix, +snapshot / +untracked markers). Deliberately NOT the
 *  artifact checks (existence, SHA-256): those cost file IO the ungated
 *  render hooks must never pay. One definition consumed by the run-index
 *  star; the validator states the SAME conditions as granular issue codes
 *  for repair guidance, and the parity control in the run-index suite
 *  keeps the two from drifting. `known` is the ledger entry for
 *  row.run_id (undefined when the ledger has none). */
export function currentRowLedgerDefective(
  row: Pick<ResultRegistryRow, 'effective_commit' | 'has_snapshot' | 'has_untracked' | 'artifact_sha256'>,
  known: RunValidity | undefined,
): boolean {
  // A malformed SHA-256 cell is a zero-IO row defect (format only; the
  // content comparison stays with the validator's artifact read).
  if (!/^[0-9a-f]{64}$/.test(row.artifact_sha256)) return true;
  if (!known || !known.stamped) return true;
  if (known.validity !== 'active') return true;
  if (known.no_authoritative_identity || known.conflicting_stamps) return true;
  if (known.attempts.chain_defect || known.attempts.conflicting_attempts) return true;
  if (known.attempts.latest_failed) return true;
  const effective = known.origin ? effectiveCodeIdentity(known.origin as RunOriginV1) : null;
  if (!effective) return true; // aligned_heuristic / unbound / no payload
  if (row.effective_commit === null) return true;
  if (!effective.startsWith(row.effective_commit)) return true;
  const originRecord = known.origin as unknown as Record<string, unknown> | null;
  const stampHasSnapshot = typeof originRecord?.snapshot_commit === 'string';
  if (row.has_snapshot !== stampHasSnapshot) return true;
  const stampHasUntracked = originRecord?.binding_quality === 'head_plus_untracked';
  if (row.has_untracked !== stampHasUntracked) return true;
  return false;
}

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
  for (const id of state.duplicate_ids) defective.add(id);
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
      if (known.conflicting_stamps) {
        state.issues.push(issue('result_run_conflicting_stamps', `${row.result_id} names run ${row.run_id}, which carries CONFLICTING origin stamps`));
      }
      // Attempt-chain health is validity truth the WRITE path already
      // refuses on; the read side must keep saying it after registration
      // too, or a row registered clean would keep rendering as a clean
      // current result after a union merge lands a defective closure or a
      // record-only booking marks the head attempt resultless.
      if (known.attempts.chain_defect || known.attempts.conflicting_attempts) {
        state.issues.push(issue('result_run_attempt_chain_defect', `${row.result_id} names run ${row.run_id}, whose attempt chain carries ${known.attempts.conflicting_attempts ? 'CONFLICTING attempt closures' : 'a chain defect'}`));
      }
      if (row.superseded_by === 'none' && known.attempts.latest_failed) {
        state.issues.push(issue('result_run_latest_attempt_failed', `${row.result_id} names run ${row.run_id}, whose latest attempt is closed as resultless — a current result must come from a delivering attempt`));
      }
      const effective = known.origin ? effectiveCodeIdentity(known.origin as RunOriginV1) : null;
      if (row.superseded_by === 'none') {
        if (known.validity !== 'active') {
          state.issues.push(issue('result_run_not_active', `${row.result_id} names run ${row.run_id}, whose ledger state is ${known.validity}`));
        }
        if (!effective) {
          state.issues.push(issue('result_run_not_exact', `${row.result_id} names run ${row.run_id}, whose stamp has no exact code identity (aligned/unbound bindings cannot back a current result)`));
        }
        if (row.effective_commit === null) {
          // A hand-written current row without the "@ sha" identity cell
          // states no commit at all — that absence is itself a defect, not
          // a free pass past the mismatch check below.
          state.issues.push(issue('result_row_commit_missing', `${row.result_id}'s current-run cell records no code identity ("run_id @ sha" expected)`));
        }
      }
      if (row.effective_commit && effective && !effective.startsWith(row.effective_commit)) {
        state.issues.push(issue('result_run_commit_mismatch', `${row.result_id} records commit ${row.effective_commit} but the run's stamp says ${effective.slice(0, 12)}`));
      }
      // Snapshot-marker fidelity (carried stage-2 hook): the row's +snapshot
      // marker must agree with the stamp — a hand-dropped marker renders a
      // dirty-snapshot identity as plain HEAD, a spurious one claims a
      // snapshot that never existed. Either direction is the D4 conflation.
      const stampHasSnapshot = typeof (known.origin as unknown as Record<string, unknown> | null)?.snapshot_commit === 'string';
      if (row.effective_commit !== null && row.has_snapshot !== stampHasSnapshot) {
        state.issues.push(issue(
          'result_row_snapshot_marker_mismatch',
          `${row.result_id}'s run cell ${row.has_snapshot ? 'carries' : 'lacks'} the +snapshot marker but the stamp ${stampHasSnapshot ? 'records a snapshot commit' : 'records none'}`,
        ));
      }
      // Same fidelity rule for the +untracked qualifier: dropping it
      // renders a head_plus_untracked binding as a fully exact identity —
      // the exact over-claim the marker exists to prevent.
      const stampHasUntracked = (known.origin as unknown as Record<string, unknown> | null)?.binding_quality === 'head_plus_untracked';
      if (row.effective_commit !== null && row.has_untracked !== stampHasUntracked) {
        state.issues.push(issue(
          'result_row_untracked_marker_mismatch',
          `${row.result_id}'s run cell ${row.has_untracked ? 'carries' : 'lacks'} the +untracked marker but the stamp's binding is ${String((known.origin as unknown as Record<string, unknown> | null)?.binding_quality ?? 'unknown')}`,
        ));
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
  // Link-syntax safety: ')' would truncate the markdown link target on
  // re-parse, and '#' silently splits as a fragment, hashing a different
  // file than the row names. Both refused up front.
  if (/[()#]/.test(input.artifactRelPath)) {
    throw new Error("artifact path must not contain '(', ')' or '#' (they break the markdown link round-trip)");
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
  if (known.conflicting_stamps) {
    throw new Error(`run ${input.runId} carries CONFLICTING origin stamps; repair the ledger before registering results on it`);
  }
  if (known.attempts.chain_defect || known.attempts.conflicting_attempts) {
    throw new Error(
      `run ${input.runId}'s attempt chain is defective (gap, forged ordinal, or divergent concurrent retries); `
      + 'repair the ledger before registering results on it — a defective chain cannot say which code produced the artifact',
    );
  }
  if (known.attempts.latest_failed) {
    throw new Error(
      `run ${input.runId}'s latest attempt is CLOSED as resultless (${known.attempts.closures.at(-1)?.previous_outcome ?? 'failed'}); `
      + 'a current result must come from a delivering attempt — retry first, or register a different run',
    );
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
  // head_plus_untracked has an exact TRACKED identity but untracked files
  // were present at capture — the sha alone would over-claim, so the cell
  // carries the qualifier and the read side keeps it honest.
  const untrackedMarker = originRecord?.binding_quality === 'head_plus_untracked' ? '+untracked' : '';
  const runCell = `${input.runId} @ ${effective.slice(0, 12)}${snapshotMarker}${untrackedMarker}`;

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
  // Reparenting protection: an existing row that already supersedes A must
  // not be re-pointed at C — A's reverse link would silently orphan.
  if (
    existing && input.supersedes !== undefined
    && existing.supersedes !== 'none' && input.supersedes !== existing.supersedes
  ) {
    throw new Error(
      `${input.resultId} already supersedes ${existing.supersedes}; reparenting it to ${input.supersedes} `
      + `would orphan ${existing.supersedes}'s reverse link — register a new result id instead`,
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
    // Exactly-one-link rule (report-registry parity): the single link must
    // name the hashed artifact — a second divergent link would describe one
    // file while the hash column vouches for another.
    const links = [...input.description.matchAll(new RegExp(MARKDOWN_LINK.source, 'g'))];
    if (links.length > 1) {
      throw new Error('--description must contain at most one Markdown link (the hashed artifact)');
    }
    const linked = links[0];
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
    // Carried-forward descriptions obey the same one-link rule as provided
    // ones — a hand-edited second link would ride along re-emitted and
    // unvouched (the hash column vouches only for the first).
    const carriedLinks = [...existing.description.matchAll(new RegExp(MARKDOWN_LINK.source, 'g'))];
    if (carriedLinks.length > 1) {
      throw new Error(
        `${input.resultId}'s existing description carries ${carriedLinks.length} Markdown links; `
        + 'pass an explicit --description with at most one link (the hashed artifact)',
      );
    }
    description = existing.description.replace(/\]\([^)]*\)/, `](${input.artifactRelPath})`);
    assertCellSafe('carried-forward description', description);
  } else {
    description = `[${input.resultId}](${input.artifactRelPath})`;
  }
  const newLine = `| \`${input.resultId}\` | ${description} | \`${digest}\` | \`${runCell}\` | \`${supersedes}\` | \`none\` |`;
  // Airtight round-trip: the exact line about to be written must re-parse to
  // the row we intend. Any field-level guard this writer missed surfaces
  // HERE as a refusal instead of an exit-0 row the registry cannot read.
  {
    const cells = newLine.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    const reparsedRun = cells.length === RESULT_TABLE_COLUMNS ? parseRunCell(cells[3]!) : null;
    const reparsedLink = cells.length === RESULT_TABLE_COLUMNS ? MARKDOWN_LINK.exec(cells[1]!) : null;
    if (
      cells.length !== RESULT_TABLE_COLUMNS
      || cells[0]!.replace(/`/g, '') !== input.resultId
      || !reparsedRun || reparsedRun.run_id !== input.runId
      || reparsedRun.effective_commit === null
      || !reparsedLink || reparsedLink[1]!.trim() !== input.artifactRelPath
    ) {
      throw new Error('internal refusal: the registry line would not round-trip; no row was written');
    }
  }

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
      has_untracked: untrackedMarker.length > 0,
      supersedes,
      superseded_by: 'none',
    },
  };
}
