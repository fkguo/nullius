import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Anti-drift lock: every ledger-writing surface must refresh the notebook
 *  current-state block. The judge panel's verified failure mode is a future
 *  writer silently skipping the refresh, leaving a currency-claiming block
 *  behind until a human notices — this lock turns that into a red test at
 *  the moment the writer is added.
 *
 *  Source-level on purpose: the behavioral tests prove the refresh WORKS;
 *  this one proves it stays WIRED. */

const SRC = path.join(__dirname, '..', 'src');
const read = (name: string): string => fs.readFileSync(path.join(SRC, name), 'utf-8');

describe('notebook current-state refresh hook coverage', () => {
  it('the shared stamp writer refreshes after an appended stamp', () => {
    const source = read('run-stamp.ts');
    expect(source).toContain("import { refreshNotebookCurrentState } from './notebook-current-state.js'");
    expect(source).toContain('refreshNotebookCurrentState(projectRoot, { insertIfMissing: false })');
  });

  it('every ledger-writing trace verb routes through the shared per-command refresh', () => {
    const source = read('cli-trace.ts');
    expect(source).toContain('function refreshCurrentStateAfterWrite');
    // One call per writing verb block: backfill, confirm-chains, and the
    // shared supersede/void/reinstate arm. (The stamp verb is covered
    // inside stampRunDirectory itself.)
    const calls = source.match(/refreshCurrentStateAfterWrite\(projectRoot, io\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const verb of ["case 'backfill'", "case 'confirm-chains'", "case 'supersede'"]) {
      expect(source).toContain(verb);
    }
  });

  it('result registration and init both refresh', () => {
    expect(read('cli.ts')).toContain('refreshNotebookCurrentState(projectRoot, { insertIfMissing: false })');
    expect(read('cli-init.ts')).toContain('refreshNotebookCurrentState(repoRoot, { insertIfMissing: false })');
  });

  it('no OTHER module appends validity events without a documented refresh story', () => {
    // The ledger's append surface is the choke point: enumerate its callers
    // and require each to be one of the audited writers above (or the
    // ledger module itself). A new caller must join this list consciously.
    const audited = new Set(['validity-ledger.ts', 'run-stamp.ts', 'cli-trace.ts', 'trace-backfill.ts']);
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(SRC)) {
      if (!entry.endsWith('.ts')) continue;
      const source = fs.readFileSync(path.join(SRC, entry), 'utf-8');
      if (source.includes('appendValidityEvent(') && !audited.has(entry)) {
        offenders.push(entry);
      }
    }
    // trace-backfill's batch writers are refreshed by their CLI arms in
    // cli-trace.ts (asserted above), the only entry points that invoke them.
    expect(offenders).toEqual([]);
  });
});
