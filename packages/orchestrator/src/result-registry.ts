import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readValidityLedger } from './validity-ledger.js';
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
  supersedes: string;
  superseded_by: string;
};

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

/** Parse the "run_id @ shortsha[+snapshot]" current-run cell. */
function parseRunCell(cell: string): { run_id: string; effective_commit: string | null } {
  const trimmed = cell.replace(/`/g, '').trim();
  const at = trimmed.lastIndexOf(' @ ');
  if (at < 0) return { run_id: trimmed, effective_commit: null };
  const commit = trimmed.slice(at + 3).replace(/\+snapshot$/, '').trim();
  return {
    run_id: trimmed.slice(0, at).trim(),
    effective_commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
  };
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
    if (cells.length !== RESULT_TABLE_COLUMNS) continue;
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
      supersedes: cells[4]!.replace(/`/g, '') || 'none',
      superseded_by: cells[5]!.replace(/`/g, '') || 'none',
    });
  }
  state.current = state.rows.filter(row => row.superseded_by === 'none');
  return state;
}

function resolveArtifact(projectRoot: string, row: ResultRegistryRow, issues: ResultRegistryIssue[]): string | null {
  if (!row.artifact_target) {
    issues.push(issue('result_artifact_link_missing', `${row.result_id} has no artifact Markdown link`));
    return null;
  }
  if (row.artifact_target.startsWith('/') || /^[a-z]+:/.test(row.artifact_target)) {
    issues.push(issue('invalid_result_artifact_target', `${row.result_id} must use a project-relative link`));
    return null;
  }
  const relative = row.artifact_target.split('#')[0]!;
  if (relative.split('/').includes('..')) {
    issues.push(issue('invalid_result_artifact_target', `${row.result_id} target cannot contain parent traversal`));
    return null;
  }
  const absolute = path.join(projectRoot, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    issues.push(issue('result_artifact_missing', `${row.result_id} artifact ${relative} does not exist`));
    return null;
  }
  return absolute;
}

/** Full validation: structure + artifact hashes + chain consistency + run
 *  liveness against the validity ledger. */
export function validateResultRegistry(projectRoot: string): ResultRegistryState {
  const state = parseResultRegistry(projectRoot);
  if (!state.block_found) return state;
  const byId = new Map(state.rows.map(row => [row.result_id, row]));
  const ledger = readValidityLedger(projectRoot);
  for (const row of state.rows) {
    if (!SHA256_HEX.test(row.artifact_sha256)) {
      state.issues.push(issue('invalid_result_sha256', `${row.result_id} SHA-256 cell is not a 64-hex digest`));
    } else {
      const artifactPath = resolveArtifact(projectRoot, row, state.issues);
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
    // Run liveness: the named run must be stamped and still valid.
    const known = ledger.runs.get(row.run_id);
    if (row.superseded_by === 'none') {
      if (!known || !known.stamped) {
        state.issues.push(issue('result_run_unstamped', `${row.result_id} names run ${row.run_id}, which carries no origin stamp`));
      } else {
        if (known.validity !== 'active') {
          state.issues.push(issue('result_run_not_active', `${row.result_id} names run ${row.run_id}, whose ledger state is ${known.validity}`));
        }
        if (known.no_authoritative_identity) {
          state.issues.push(issue('result_run_no_identity', `${row.result_id} names run ${row.run_id}, which is quarantined by a ledger-integrity defect`));
        }
        const effective = known.origin ? effectiveCodeIdentity(known.origin as RunOriginV1) : null;
        if (row.effective_commit && effective && !effective.startsWith(row.effective_commit)) {
          state.issues.push(issue('result_run_commit_mismatch', `${row.result_id} records commit ${row.effective_commit} but the run's stamp says ${effective.slice(0, 12)}`));
        }
      }
    }
  }
  return state;
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
  const indexPath = path.join(projectRoot, 'project_index.md');
  if (!fs.existsSync(indexPath)) throw new Error('project_index.md not found; run nullius init first');
  const text = fs.readFileSync(indexPath, 'utf-8');
  const bounds = blockBounds(text);
  if (!bounds) {
    throw new Error(
      `project_index.md has no ${RESULT_REGISTRY_START} block; add the Current results section `
      + '(nullius init --refresh scaffolds it for new projects; existing projects paste the block once)',
    );
  }
  const artifactAbsolute = path.join(projectRoot, input.artifactRelPath);
  if (!fs.existsSync(artifactAbsolute) || !fs.statSync(artifactAbsolute).isFile()) {
    throw new Error(`artifact ${input.artifactRelPath} does not exist`);
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
  const originRecord = known.origin as unknown as Record<string, unknown> | null;
  const snapshotMarker = originRecord && typeof originRecord.snapshot_commit === 'string' ? '+snapshot' : '';
  const runCell = effective
    ? `${input.runId} @ ${effective.slice(0, 12)}${snapshotMarker}`
    : input.runId;

  const state = parseResultRegistry(projectRoot);
  const existing = state.rows.find(row => row.result_id === input.resultId);
  const supersedes = input.supersedes ?? existing?.supersedes ?? 'none';
  if (supersedes !== 'none' && !state.rows.some(row => row.result_id === supersedes)) {
    throw new Error(`--supersedes names ${supersedes}, which is not a registered result id`);
  }
  const description = input.description
    ?? (existing ? existing.description.replace(/\]\([^)]*\)/, `](${input.artifactRelPath})`) : null)
    ?? `[${input.resultId}](${input.artifactRelPath})`;
  const newLine = `| \`${input.resultId}\` | ${description.includes('](') ? description : `[${input.resultId}](${input.artifactRelPath})`} | \`${digest}\` | \`${runCell}\` | \`${supersedes}\` | \`none\` |`;

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
  fs.writeFileSync(indexPath, text.slice(0, bounds.start) + newBlock + text.slice(bounds.end));
  return {
    row: {
      result_id: input.resultId,
      description,
      artifact_target: input.artifactRelPath,
      artifact_sha256: digest,
      run_id: input.runId,
      effective_commit: effective ? effective.slice(0, 12) : null,
      supersedes,
      superseded_by: 'none',
    },
  };
}
