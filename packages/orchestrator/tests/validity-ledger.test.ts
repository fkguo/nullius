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
  isTraceabilityArtifactPath,
  pinSnapshotRef,
  sanitizeRunRefComponent,
} from '../src/run-origin.js';
import {
  buildTraceabilityView,
  listRunDirectories,
  readManuscriptPointer,
  renderTraceabilityProse,
} from '../src/traceability-view.js';
import { runTraceCommand } from '../src/cli-trace.js';

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

describe('review-locked contracts (stage-1 r1 findings)', () => {
  it('breaks equal-ts_utc ties by event_id, deterministically', () => {
    const run = 'r-tie';
    const ts = '2026-08-01T00:00:00Z';
    const a = event({ event: 'supersede', run_id: run, by_run_id: 'n', ts_utc: ts, event_id: mintUlid(1_000) });
    const b = event({ event: 'void', run_id: run, ts_utc: ts, event_id: mintUlid(2_000) });
    // Physical order reversed relative to event_id order.
    appendValidityEvent(projectRoot, b);
    appendValidityEvent(projectRoot, a);
    // b's ULID sorts after a's → void is the effective last event.
    expect(readValidityLedger(projectRoot).runs.get(run)?.validity).toBe('void');
  });

  it('keeps scoped void as annotation and reinstates after full void', () => {
    const run = 'r-scoped-void';
    appendValidityEvent(projectRoot, event({ event: 'void', run_id: run, scope: 'figure_only' }));
    let view = readValidityLedger(projectRoot);
    expect(view.runs.get(run)?.validity).toBe('active');
    expect(view.runs.get(run)?.scoped_annotations[0]?.event).toBe('void');

    appendValidityEvent(projectRoot, event({ event: 'void', run_id: run }));
    appendValidityEvent(projectRoot, event({
      event: 'reinstate', run_id: run, ts_utc: '2100-01-01T00:00:00Z',
    }));
    view = readValidityLedger(projectRoot);
    expect(view.runs.get(run)?.validity).toBe('active');
  });

  it('rejects semantically invalid lines as malformed instead of replaying them', () => {
    const ledger = validityLedgerPath(projectRoot);
    const badUlid = { schema_id: 'validity_event_v1', event_id: 'not-a-ulid', event: 'void', run_id: 'r', reason: 'x', actor: 't', ts_utc: '2026-08-01T00:00:00Z' };
    const unknownEvent = { schema_id: 'validity_event_v1', event_id: mintUlid(), event: 'obliterate', run_id: 'r', actor: 't', ts_utc: '2026-08-01T00:00:00Z' };
    const supersedeNoReason = { schema_id: 'validity_event_v1', event_id: mintUlid(), event: 'supersede', run_id: 'r', by_run_id: 'n', actor: 't', ts_utc: '2026-08-01T00:00:00Z' };
    const voidNoActor = { schema_id: 'validity_event_v1', event_id: mintUlid(), event: 'void', run_id: 'r', reason: 'x', ts_utc: '2026-08-01T00:00:00Z' };
    const badTs = { schema_id: 'validity_event_v1', event_id: mintUlid(), event: 'void', run_id: 'r', reason: 'x', actor: 't', ts_utc: 'yesterday' };
    fs.writeFileSync(ledger, [badUlid, unknownEvent, supersedeNoReason, voidNoActor, badTs]
      .map(value => JSON.stringify(value)).join('\n') + '\n');
    const view = readValidityLedger(projectRoot);
    expect(view.malformed_lines).toBe(5);
    expect(view.events).toHaveLength(0);
    expect(view.runs.get('r')).toBeUndefined();
  });

  it('refuses a divergent event_id even when a matching duplicate precedes it', () => {
    const e = event({ event: 'void', run_id: 'r-dup' });
    appendValidityEvent(projectRoot, e);
    // Manufacture union-merge residue: duplicate line THEN a divergent one.
    const divergent = { ...e, reason: 'a different reason' };
    fs.appendFileSync(validityLedgerPath(projectRoot),
      `${JSON.stringify(e)}\n${JSON.stringify(divergent)}\n`);
    expect(() => appendValidityEvent(projectRoot, e)).toThrow(/different payload/);
  });

  it('reports conflicting stamps as a defect instead of silently last-wins', () => {
    const stampOf = (quality: string, eventId: string) => event({
      event: 'stamp', run_id: 'r-twice', reason: null, event_id: eventId,
      stamp: {
        schema_id: 'run_origin_v1', event_id: eventId, run_id: 'r-twice',
        captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: quality,
        baseline_commit: 'a'.repeat(40), dirty: { tracked_modified: 0, untracked_count: 0 },
      } as ValidityEventV1['stamp'],
    });
    appendValidityEvent(projectRoot, stampOf('exact_clean', mintUlid(1_000)));
    appendValidityEvent(projectRoot, stampOf('head_plus_untracked', mintUlid(2_000)));
    const entry = readValidityLedger(projectRoot).runs.get('r-twice');
    expect(entry?.conflicting_stamps).toBe(true);
  });

  it('creates the union-merge gitattributes idempotently without clobbering custom lines', () => {
    appendValidityEvent(projectRoot, event({ event: 'void', run_id: 'r' }));
    const attributesPath = path.join(projectRoot, 'artifacts', 'runs', '.gitattributes');
    expect(fs.readFileSync(attributesPath, 'utf-8')).toContain('validity_ledger.jsonl merge=union');
    fs.writeFileSync(attributesPath, 'validity_ledger.jsonl merge=ours\ncustom.txt -diff\n');
    appendValidityEvent(projectRoot, event({ event: 'void', run_id: 'r2' }));
    const text = fs.readFileSync(attributesPath, 'utf-8');
    expect(text).toContain('merge=ours');
    expect(text).not.toContain('merge=union');
  });

  it('appends successfully when artifacts/runs does not exist yet', () => {
    fs.rmSync(path.join(projectRoot, 'artifacts'), { recursive: true, force: true });
    expect(appendValidityEvent(projectRoot, event({ event: 'void', run_id: 'r' }))).toBe('appended');
  });
});

describe('isTraceabilityArtifactPath (narrow by construction)', () => {
  it('excludes only the machinery paths, not lookalikes elsewhere', () => {
    expect(isTraceabilityArtifactPath('artifacts/runs/validity_ledger.jsonl')).toBe(true);
    expect(isTraceabilityArtifactPath('artifacts/runs/validity_ledger.jsonl.lock')).toBe(true);
    expect(isTraceabilityArtifactPath('artifacts/runs/.gitattributes')).toBe(true);
    expect(isTraceabilityArtifactPath('artifacts/runs/some-run/run_origin.json')).toBe(true);
    expect(isTraceabilityArtifactPath('team/runs/some-run/run_origin.json')).toBe(true);
    // Lookalikes OUTSIDE the machinery locations still count as untracked.
    expect(isTraceabilityArtifactPath('src/run_origin.json')).toBe(false);
    expect(isTraceabilityArtifactPath('validity_ledger.jsonl')).toBe(false);
    expect(isTraceabilityArtifactPath('notes/validity_ledger.jsonl')).toBe(false);
  });
});

describe('traceability view and CLI (review-locked)', () => {
  function initRepo(dir: string): void {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  }
  function commitAll(dir: string, message: string): void {
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message]);
  }
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      cwd: projectRoot,
      stdout: (t: string) => { out.push(t); },
      stderr: (t: string) => { err.push(t); },
      out, err,
    };
  };

  it('merges mirrored run ids with artifacts/runs canonical', () => {
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'shared-run'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'team', 'runs', 'shared-run'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'team', 'runs', 'team-only-run'), { recursive: true });
    const entries = listRunDirectories(projectRoot);
    const shared = entries.find(entry => entry.run_id === 'shared-run');
    expect(shared?.canonical_root).toBe(path.join('artifacts', 'runs'));
    expect(shared?.mirrored).toBe(true);
    expect(entries.find(entry => entry.run_id === 'team-only-run')?.canonical_root)
      .toBe(path.join('team', 'runs'));
    expect(entries).toHaveLength(2);
  });

  it('reads the manuscript pointer in all three states without over-claiming', () => {
    const indexPath = path.join(projectRoot, 'project_index.md');
    expect(readManuscriptPointer(projectRoot).registry_block_found).toBe(false);
    fs.writeFileSync(indexPath, [
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->',
      'unparseable pointer lines',
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->',
    ].join('\n'));
    const broken = readManuscriptPointer(projectRoot);
    expect(broken.registry_block_found).toBe(true);
    expect(broken.pointer_parse_ok).toBe(false);
    fs.writeFileSync(indexPath, [
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->',
      '- Current report ID: `m9-report`',
      '- Current report: [The report](reports/the_report.md)',
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->',
    ].join('\n'));
    const ok = readManuscriptPointer(projectRoot);
    expect(ok.pointer_parse_ok).toBe(true);
    expect(ok.current_report_id).toBe('m9-report');
    expect(ok.current_report_link).toBe('reports/the_report.md');
    expect(ok.validation).toBe('deferred');
  });

  it('reports unborn HEAD and parse-failed pointers as their own unanswerable reasons', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->',
      'garbled',
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->',
    ].join('\n'));
    const view = buildTraceabilityView(projectRoot);
    expect(view.unanswerable.some(u => u.reason.includes('unborn HEAD'))).toBe(true);
    expect(view.unanswerable.some(u => u.reason.includes('did not parse'))).toBe(true);
    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('unborn HEAD');
    expect(prose).not.toContain('clean tracked tree');
  });

  it('surfaces heuristic/unbound stamps and integrity defects at the top of the prose', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'r-aligned'), { recursive: true });
    const alignedId = mintUlid();
    appendValidityEvent(projectRoot, event({
      event: 'stamp', run_id: 'r-aligned', reason: null, event_id: alignedId,
      stamp: {
        schema_id: 'run_origin_v1', event_id: alignedId, run_id: 'r-aligned',
        captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'aligned_heuristic',
        baseline_commit: null, aligned_commit: 'b'.repeat(40),
        alignment: { window_prev_s: 10, nominal_timestamp: false },
        dirty: { tracked_modified: 0, untracked_count: 0 },
      } as ValidityEventV1['stamp'],
    }));
    const sharedId = mintUlid();
    const ledger = validityLedgerPath(projectRoot);
    fs.appendFileSync(ledger, [
      JSON.stringify({ schema_id: 'validity_event_v1', event_id: sharedId, event: 'void', run_id: 'r-aligned', reason: 'A', actor: 't', ts_utc: '2026-08-02T00:00:00Z' }),
      JSON.stringify({ schema_id: 'validity_event_v1', event_id: sharedId, event: 'supersede', run_id: 'r-aligned', by_run_id: 'x', reason: 'B', actor: 't', ts_utc: '2026-08-02T00:00:00Z' }),
    ].join('\n') + '\n');
    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.binding_quality_counts['aligned_heuristic']).toBe(1);
    expect(view.unanswerable.some(u => u.clause === 'exact code revision (per-run)')).toBe(true);
    expect(view.ledger.integrity_defects).toBe(1);
    const prose = renderTraceabilityProse(view);
    expect(prose.indexOf('LEDGER INTEGRITY CONDITION')).toBeGreaterThanOrEqual(0);
    expect(prose.indexOf('LEDGER INTEGRITY CONDITION')).toBeLessThan(prose.indexOf('Current best result'));
    expect(prose).toContain('aligned_heuristic');
  });

  it('stamp --event-id retry short-circuits on the ledger, and canonical root is enforced', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'the-run'), { recursive: true });
    const stdio1 = io();
    const parsedBase = { by: null, reason: null, scope: null, actor: 'test', deps: {} };
    expect(runTraceCommand(projectRoot, {
      action: 'stamp', target: 'artifacts/runs/the-run', eventId: null, ...parsedBase,
    }, stdio1)).toBe(0);
    const eventId = /event (\S+)/.exec(stdio1.out.join(''))![1]!;
    // Retry with the SAME event id: recognized on the ledger, no divergence
    // error even though a re-capture would differ (time moved).
    const stdio2 = io();
    expect(runTraceCommand(projectRoot, {
      action: 'stamp', target: 'artifacts/runs/the-run', eventId, ...parsedBase,
    }, stdio2)).toBe(0);
    expect(stdio2.out.join('')).toContain('already stamped');
    // Mirror of a canonical run refuses the stamp and names the canonical path.
    fs.mkdirSync(path.join(projectRoot, 'team', 'runs', 'the-run'), { recursive: true });
    const stdio3 = io();
    expect(runTraceCommand(projectRoot, {
      action: 'stamp', target: 'team/runs/the-run', eventId: null, ...parsedBase,
    }, stdio3)).toBe(1);
    expect(stdio3.err.join('')).toContain('canonical');
  });

  it('propagates a stash-create failure instead of grading it exact_clean', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '2'); // dirty → stash must write objects
    // Recursive chmod: existing fanout subdirectories must also be sealed,
    // or a new object landing in one of them would let stash succeed and
    // make this injection nondeterministic.
    const objectsDir = path.join(projectRoot, '.git', 'objects');
    const sealed: string[] = [];
    const walk = (dir: string): void => {
      sealed.push(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
      }
    };
    walk(objectsDir);
    for (const dir of sealed) fs.chmodSync(dir, 0o500);
    try {
      expect(() => captureRunOrigin(projectRoot, 'run-broken')).toThrow();
    } finally {
      for (const dir of sealed) fs.chmodSync(dir, 0o755);
    }
  });

  it('rejects stamp payloads that violate the origin contract (deep validation)', () => {
    const ledger = validityLedgerPath(projectRoot);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    const base = { schema_id: 'validity_event_v1', event: 'stamp', run_id: 'r', actor: 't', ts_utc: '2026-08-01T00:00:00Z' };
    const goodId = mintUlid();
    const badPayloads = [
      { note: 'just a schema_id' , stamp: { schema_id: 'run_origin_v1' } },
      { note: 'bad quality', stamp: { schema_id: 'run_origin_v1', event_id: goodId, run_id: 'r', captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'perfect', baseline_commit: 'a'.repeat(40), dirty: { tracked_modified: 0, untracked_count: 0 } } },
      { note: 'unbound without reason', stamp: { schema_id: 'run_origin_v1', event_id: goodId, run_id: 'r', captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'unbound', baseline_commit: null, dirty: { tracked_modified: 0, untracked_count: 0 } } },
      { note: 'snapshot quality without snapshot', stamp: { schema_id: 'run_origin_v1', event_id: goodId, run_id: 'r', captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'exact_tracked_snapshot', baseline_commit: 'a'.repeat(40), dirty: { tracked_modified: 1, untracked_count: 0 } } },
    ];
    fs.writeFileSync(ledger, badPayloads
      .map(entry => JSON.stringify({ ...base, event_id: mintUlid(), stamp: entry.stamp }))
      .join('\n') + '\n');
    const view = readValidityLedger(projectRoot);
    expect(view.malformed_lines).toBe(badPayloads.length);
    expect(view.runs.get('r')?.stamped ?? false).toBe(false);
  });

  it('refuses stamping outside the two run roots', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    fs.mkdirSync(path.join(projectRoot, 'misc', 'run'), { recursive: true });
    const stdio = io();
    expect(runTraceCommand(projectRoot, {
      action: 'stamp', target: 'misc/run', eventId: null,
      by: null, reason: null, scope: null, actor: 'test', deps: {},
    }, stdio)).toBe(1);
    expect(stdio.err.join('')).toContain('artifacts/runs');
    expect(fs.existsSync(validityLedgerPath(projectRoot))).toBe(false);
  });

  it('refuses --event-id reuse of a non-stamp or other-run event, before any mirror write', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'the-run'), { recursive: true });
    const voidEvent = event({ event: 'void', run_id: 'other-run' });
    appendValidityEvent(projectRoot, voidEvent);
    const stdio = io();
    expect(runTraceCommand(projectRoot, {
      action: 'stamp', target: 'artifacts/runs/the-run', eventId: voidEvent.event_id,
      by: null, reason: null, scope: null, actor: 'test', deps: {},
    }, stdio)).toBe(1);
    expect(stdio.err.join('')).toContain('void');
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', 'the-run', 'run_origin.json'))).toBe(false);
    const stdio2 = io();
    expect(runTraceCommand(projectRoot, {
      action: 'stamp', target: 'artifacts/runs/the-run', eventId: 'not-a-ulid',
      by: null, reason: null, scope: null, actor: 'test', deps: {},
    }, stdio2)).toBe(1);
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', 'the-run', 'run_origin.json'))).toBe(false);
  });

  it('counts ledger-only stamps in the quality distribution and flags merge attributes', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    // Stamp for a run whose directory does NOT exist (ledger-only).
    const goneId = mintUlid();
    appendValidityEvent(projectRoot, event({
      event: 'stamp', run_id: 'gone-run', reason: null, event_id: goneId,
      stamp: {
        schema_id: 'run_origin_v1', event_id: goneId, run_id: 'gone-run',
        captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'unbound',
        baseline_commit: null, no_repo_reason: 'legacy',
        dirty: { tracked_modified: 0, untracked_count: 0 },
      } as ValidityEventV1['stamp'],
    }));
    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.binding_quality_counts['unbound']).toBe(1);
    expect(view.unanswerable.some(u => u.clause === 'exact code revision (per-run)')).toBe(true);
    expect(view.ledger.merge_union_declared).toBe(true);
  });

  it('marks a linkless current manuscript pointer unanswerable', () => {
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->',
      '- Current report ID: `m9-report`',
      '- Current report: the report, no markdown link here',
      '<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->',
    ].join('\n'));
    const view = buildTraceabilityView(projectRoot);
    expect(view.manuscript.current_report_id).toBe('m9-report');
    expect(view.manuscript.current_report_link).toBeNull();
    expect(view.unanswerable.some(u => u.reason.includes('no Markdown link'))).toBe(true);
    // No ledger has been written here → no attributes file → declared=false
    // (locks the negative direction, not just the happy path).
    expect(view.ledger.merge_union_declared).toBe(false);
  });

  it('records dependency repository commits via deps', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot, 'one');
    const depRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-repo-'));
    try {
      initRepo(depRoot);
      fs.writeFileSync(path.join(depRoot, 'lib.jl'), 'f() = 1');
      commitAll(depRoot, 'dep');
      const depHead = execFileSync('git', ['-C', depRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      const origin = captureRunOrigin(projectRoot, 'run-with-dep', { deps: { toolkit: depRoot } });
      expect((origin.deps as Record<string, string>).toolkit).toBe(depHead);
    } finally {
      fs.rmSync(depRoot, { recursive: true, force: true });
    }
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

  it('excludes traceability artifacts from untracked noise (no self-referential demotion)', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'code.py'), 'x = 1\n');
    commitAll(projectRoot, 'initial');
    // Simulate a prior stamp: ledger + a mirror exist but are not yet committed.
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl'), '');
    const runDir = path.join(projectRoot, 'artifacts', 'runs', 'earlier-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run_origin.json'), '{}');
    const origin = captureRunOrigin(projectRoot, 'run-after-stamps');
    // Clean research tree + only tool artifacts untracked → still exact.
    expect(origin.binding_quality).toBe('exact_clean');
    expect((origin.dirty as { untracked_count: number }).untracked_count).toBe(0);
    // A real untracked research file still demotes.
    fs.writeFileSync(path.join(projectRoot, 'new_code.py'), 'y = 2\n');
    const demoted = captureRunOrigin(projectRoot, 'run-with-real-untracked');
    expect(demoted.binding_quality).toBe('head_plus_untracked');
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
