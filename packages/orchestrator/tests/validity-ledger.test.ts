import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintUlid, ULID_PATTERN } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import {
  appendValidityEvent,
  buildValidityEvent,
  canonicalJson,
  readValidityLedger,
  validityLedgerPath,
  worstValidity,
} from '../src/validity-ledger.js';
import {
  captureRunOrigin,
  effectiveCodeIdentity,
  pinSnapshotRef,
  sanitizeRunRefComponent,
} from '../src/run-origin.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validity-ledger-'));
  fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function event(fields: Partial<ValidityEventV1> & Pick<ValidityEventV1, 'event' | 'run_id'>): ValidityEventV1 {
  return buildValidityEvent({
    actor: 'test',
    reason: fields.event === 'supersede' || fields.event === 'void' || fields.event === 'reinstate'
      ? 'test reason'
      : null,
    ...fields,
  } as Parameters<typeof buildValidityEvent>[0]);
}

describe('mintUlid', () => {
  it('mints pattern-conforming, unique, time-ordered ids', () => {
    const a = mintUlid(1_000_000);
    const b = mintUlid(2_000_000);
    expect(a).toMatch(ULID_PATTERN);
    expect(b).toMatch(ULID_PATTERN);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(mintUlid()).not.toEqual(mintUlid());
  });
});

describe('canonicalJson', () => {
  it('is invariant under key order and undefined members, sensitive to values', () => {
    expect(canonicalJson({ a: 1, b: [2, { d: 3, c: 4 }] }))
      .toEqual(canonicalJson({ b: [2, { c: 4, d: 3 }], a: 1 }));
    expect(canonicalJson({ a: 1, x: undefined })).toEqual(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toEqual(canonicalJson({ a: 2 }));
  });
});

describe('appendValidityEvent / readValidityLedger', () => {
  it('derives last-full-event-wins validity with derived superseded_by', () => {
    const oldRun = '20260801-m9-r1-alpha-r1';
    const newRun = '20260802-m9-r2-alpha-r2';
    appendValidityEvent(projectRoot, event({ event: 'supersede', run_id: oldRun, by_run_id: newRun }));
    const view = readValidityLedger(projectRoot);
    expect(view.runs.get(oldRun)?.validity).toBe('superseded');
    expect(view.runs.get(oldRun)?.superseded_by).toBe(newRun);
    expect(view.runs.get(newRun)?.validity).toBe('active');

    appendValidityEvent(projectRoot, event({ event: 'reinstate', run_id: oldRun }));
    const after = readValidityLedger(projectRoot);
    expect(after.runs.get(oldRun)?.validity).toBe('active');
    expect(after.runs.get(oldRun)?.superseded_by).toBeNull();
  });

  it('keeps scoped events as annotations that never change overall validity', () => {
    const run = '20260801-m9-r1-beta-r1';
    appendValidityEvent(projectRoot, event({
      event: 'supersede', run_id: run, by_run_id: 'x', scope: 'budget_only',
    }));
    const view = readValidityLedger(projectRoot);
    expect(view.runs.get(run)?.validity).toBe('active');
    expect(view.runs.get(run)?.scoped_annotations).toHaveLength(1);
    expect(view.runs.get(run)?.scoped_annotations[0]?.scope).toBe('budget_only');
  });

  it('is idempotent for the same event_id + payload and refuses divergent reuse', () => {
    const e = event({ event: 'void', run_id: 'r1' });
    expect(appendValidityEvent(projectRoot, e)).toBe('appended');
    expect(appendValidityEvent(projectRoot, e)).toBe('already_present');
    const divergent = { ...e, reason: 'a different reason' };
    expect(() => appendValidityEvent(projectRoot, divergent)).toThrow(/different payload/);
  });

  it('orders replay by (ts_utc, event_id), never by line position', () => {
    const run = 'r-order';
    const later = event({ event: 'void', run_id: run, ts_utc: '2026-08-02T00:00:00Z' });
    const earlier = event({ event: 'supersede', run_id: run, by_run_id: 'n', ts_utc: '2026-08-01T00:00:00Z' });
    // Append physically out of order: void first, supersede second.
    appendValidityEvent(projectRoot, later);
    appendValidityEvent(projectRoot, earlier);
    const view = readValidityLedger(projectRoot);
    // Effective order puts void LAST → the run is void, not superseded.
    expect(view.runs.get(run)?.validity).toBe('void');
  });

  it('deduplicates union-merge residue and quarantines divergent payloads at worst state', () => {
    const ledger = validityLedgerPath(projectRoot);
    const sharedId = mintUlid();
    const supersedeVariant = {
      schema_id: 'validity_event_v1', event_id: sharedId, event: 'supersede',
      run_id: 'r-defect', by_run_id: 'n', reason: 'variant A', actor: 't',
      ts_utc: '2026-08-01T00:00:00Z',
    };
    const voidVariant = {
      schema_id: 'validity_event_v1', event_id: sharedId, event: 'void',
      run_id: 'r-defect', reason: 'variant B', actor: 't',
      ts_utc: '2026-08-01T00:00:00Z',
    };
    const clean = event({ event: 'void', run_id: 'r-clean' });
    const keyReordered = JSON.stringify(
      Object.fromEntries(Object.entries(clean).reverse()),
    );
    fs.writeFileSync(ledger, [
      JSON.stringify(supersedeVariant),
      JSON.stringify(voidVariant),
      JSON.stringify(clean),
      JSON.stringify(clean), // byte-identical duplicate → silent drop
      keyReordered, // canonical-equal duplicate → same logical event
      'not json at all', // malformed → counted, never silently skipped
    ].join('\n') + '\n');

    const view = readValidityLedger(projectRoot);
    expect(view.malformed_lines).toBe(1);
    expect(view.integrity_defects).toHaveLength(1);
    expect(view.integrity_defects[0]?.event_id).toBe(sharedId);
    // Worst of {superseded, void} is void; the run has no authoritative identity.
    expect(view.runs.get('r-defect')?.validity).toBe('void');
    expect(view.runs.get('r-defect')?.no_authoritative_identity).toBe(true);
    // The clean run counted exactly once despite three physical lines.
    expect(view.events.filter(e => e.run_id === 'r-clean')).toHaveLength(1);
    expect(view.runs.get('r-clean')?.no_authoritative_identity).toBe(false);
  });

  it('fails closed when the ledger lock is held', () => {
    fs.writeFileSync(`${validityLedgerPath(projectRoot)}.lock`, JSON.stringify({ pid: 99999, ts: 'earlier' }));
    expect(() => appendValidityEvent(projectRoot, event({ event: 'void', run_id: 'r' })))
      .toThrow(/ledger is locked/);
  });

  it('stamp events carry the origin payload and mark the run stamped', () => {
    const stamp = event({
      event: 'stamp',
      run_id: 'r-stamped',
      reason: null,
      stamp: {
        schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: 'r-stamped',
        captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'exact_clean',
        baseline_commit: 'a'.repeat(40), dirty: { tracked_modified: 0, untracked_count: 0 },
      } as ValidityEventV1['stamp'],
    });
    appendValidityEvent(projectRoot, stamp);
    const view = readValidityLedger(projectRoot);
    expect(view.runs.get('r-stamped')?.stamped).toBe(true);
    expect(view.runs.get('r-stamped')?.validity).toBe('active');
  });
});

describe('worstValidity', () => {
  it('orders void > superseded > active', () => {
    expect(worstValidity('active', 'superseded')).toBe('superseded');
    expect(worstValidity('superseded', 'void')).toBe('void');
    expect(worstValidity('void', 'active')).toBe('void');
    expect(worstValidity('active', 'active')).toBe('active');
  });
});

describe('sanitizeRunRefComponent', () => {
  it('maps arbitrary run ids onto valid ref components', () => {
    expect(sanitizeRunRefComponent('20260806-m9-r246-matched-r1')).toBe('20260806-m9-r246-matched-r1');
    expect(sanitizeRunRefComponent('weird name:with*chars?')).toBe('weird-name-with-chars-');
    expect(sanitizeRunRefComponent('..dots..everywhere..')).toBe('dots.everywhere');
    expect(sanitizeRunRefComponent('ends.lock')).toBe('ends');
    expect(sanitizeRunRefComponent('***')).toBe('---');
    expect(sanitizeRunRefComponent('...')).toBe('run');
  });
});

describe('captureRunOrigin (real git fixtures)', () => {
  function initRepo(dir: string): void {
    execFileSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf-8' });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  }
  function commitAll(dir: string, message: string): string {
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message]);
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  }

  it('grades a clean tree exact_clean with baseline identity', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'code.py'), 'x = 1\n');
    const head = commitAll(projectRoot, 'initial');
    const origin = captureRunOrigin(projectRoot, 'run-clean');
    expect(origin.binding_quality).toBe('exact_clean');
    expect(origin.baseline_commit).toBe(head);
    expect(origin.snapshot_commit).toBeUndefined();
    expect(effectiveCodeIdentity(origin)).toBe(head);
  });

  it('grades tracked modifications exact_tracked_snapshot with a pinned, countable snapshot', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'code.py'), 'x = 1\n');
    const head = commitAll(projectRoot, 'initial');
    fs.writeFileSync(path.join(projectRoot, 'code.py'), 'x = 2\n');
    const origin = captureRunOrigin(projectRoot, 'run-dirty');
    expect(origin.binding_quality).toBe('exact_tracked_snapshot');
    expect((origin.dirty as { tracked_modified: number }).tracked_modified).toBe(1);
    const snapshot = origin.snapshot_commit as string;
    expect(snapshot).toMatch(/^[0-9a-f]{40}$/);
    expect(effectiveCodeIdentity(origin)).toBe(snapshot);
    // The snapshot commit's parent is HEAD (ancestry argument for D5).
    const parent = execFileSync('git', ['-C', projectRoot, 'rev-parse', `${snapshot}^1`], { encoding: 'utf-8' }).trim();
    expect(parent).toBe(head);
    // The pin survives gc reachability: the ref exists and points at it.
    const ref = execFileSync(
      'git', ['-C', projectRoot, 'rev-parse', 'refs/nullius/runs/run-dirty'],
      { encoding: 'utf-8' },
    ).trim();
    expect(ref).toBe(snapshot);
  });

  it('grades untracked presence head_plus_untracked and never claims exact', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'code.py'), 'x = 1\n');
    commitAll(projectRoot, 'initial');
    fs.writeFileSync(path.join(projectRoot, 'literature.pdf'), 'cache');
    const origin = captureRunOrigin(projectRoot, 'run-untracked');
    expect(origin.binding_quality).toBe('head_plus_untracked');
    const dirty = origin.dirty as { untracked_count: number; untracked_sample?: string[] };
    expect(dirty.untracked_count).toBe(1);
    expect(dirty.untracked_sample).toEqual(['literature.pdf']);
  });

  it('reports unbound honestly for a non-repo and an unborn HEAD', () => {
    const origin = captureRunOrigin(projectRoot, 'run-norepo');
    expect(origin.binding_quality).toBe('unbound');
    expect(origin.no_repo_reason).toMatch(/not inside a git work tree/);

    initRepo(projectRoot);
    const unborn = captureRunOrigin(projectRoot, 'run-unborn');
    expect(unborn.binding_quality).toBe('unbound');
    expect(unborn.no_repo_reason).toMatch(/unborn HEAD/);
  });

  it('pin is create-if-absent: idempotent on same object, hard error on rebind', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    const first = commitAll(projectRoot, 'one');
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '2');
    const second = commitAll(projectRoot, 'two');
    expect(pinSnapshotRef(projectRoot, 'the-run', first).outcome).toBe('created');
    expect(pinSnapshotRef(projectRoot, 'the-run', first).outcome).toBe('already_pinned');
    expect(() => pinSnapshotRef(projectRoot, 'the-run', second)).toThrow(/refusing to rebind/);
  });
});
