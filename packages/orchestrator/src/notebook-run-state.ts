import * as path from 'node:path';
import { RUN_ROOTS } from './run-directories.js';
import { canonicalJson, readValidityLedger, type RunValidity } from './validity-ledger.js';

/** The ledger's objective state for a run supplying frozen review material.
 * Null records the absence of ledger authority; it does not mean active.
 * Scientific use of active, superseded or void evidence is the reviewer's job. */
export type NotebookRunState = { run_id: string; state: RunValidity | null };

type MaterialInput = { path: string };
type MaterialScope = { notebook: MaterialInput; dependencies: MaterialInput[]; opaque_links?: MaterialInput[] };
const RUN_PREFIXES = RUN_ROOTS.map(root => root.split(path.sep).join('/') + '/');

/** Input paths already passed the review intake's project-root normalization.
 * Derive identities from the complete frozen closure, including recursive,
 * explicit and opaque dependencies. Root-level ledger files are not runs. */
export function notebookMaterialRunIds(scope: MaterialScope): string[] {
  const ids = new Set<string>();
  for (const input of [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])]) {
    const prefix = RUN_PREFIXES.find(root => input.path.startsWith(root));
    if (prefix === undefined) continue;
    const tail = input.path.slice(prefix.length);
    const separator = tail.indexOf('/');
    if (separator > 0 && separator < tail.length - 1) ids.add(tail.slice(0, separator));
  }
  return [...ids].sort();
}

export function captureNotebookRunStates(projectRoot: string, scope: MaterialScope): NotebookRunState[] {
  const ids = notebookMaterialRunIds(scope);
  if (ids.length === 0) return [];
  const ledger = readValidityLedger(projectRoot);
  return ids.map(run_id => ({ run_id, state: ledger.runs.get(run_id) ?? null }));
}

export function assertNotebookRunStates(scope: MaterialScope, value: unknown): asserts value is NotebookRunState[] {
  const ids = notebookMaterialRunIds(scope);
  if (!Array.isArray(value) || value.length !== ids.length
    || value.some((item, index) => !item || item.run_id !== ids[index]
      || (item.state !== null && (typeof item.state !== 'object' || Array.isArray(item.state)
        || item.state.run_id !== item.run_id)))) {
    throw new Error('notebook run-state inventory does not match the complete frozen material');
  }
}

/** Compare only the relevant derived run states, not unrelated ledger events
 * or the review run's own stamp. Errors never imply current acceptance. */
export function notebookRunStatesCurrent(projectRoot: string, scope: MaterialScope & { run_states: NotebookRunState[] }): boolean {
  assertNotebookRunStates(scope, scope.run_states);
  return canonicalJson(scope.run_states) === canonicalJson(captureNotebookRunStates(projectRoot, scope));
}
