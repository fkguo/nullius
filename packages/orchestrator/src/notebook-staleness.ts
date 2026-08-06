import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readValidityLedger, type ValidityLedgerView } from './validity-ledger.js';
import { validateResultRegistry } from './result-registry.js';

/** D5: per-section staleness of the living notebook against the project's
 *  current version — the acceptance sentence's "which sections belong to the
 *  current version and which have not been rewritten since an earlier one".
 *
 *  Sections opt in with an HTML-comment stamp; the checker classifies each
 *  section with the fully-specified six-step worst-wins procedure, every
 *  outcome decidable and none guessed:
 *    1. a cited run superseded/void        → stale (cites-superseded-run)
 *    2. no stamp                           → unstamped
 *    3. stamp sha unresolvable             → incomparable (unresolvable-stamp)
 *    4. stamp strict-ancestor of any b∈B   → stale (stamp-behind)
 *    5. any b∈B unresolvable / sentinel /
 *       diverged from the stamp            → incomparable (named cause)
 *    6. otherwise                          → current; qualified
 *       current-modulo-untracked when any compared b came from a
 *       head_plus_untracked row (two-axis ruling: participate in ancestry,
 *       never claim unqualified currency)
 *  B is the PROJECT-LEVEL set of effective code identities of the results
 *  registry's current rows; rows without a usable exact identity contribute
 *  a SENTINEL (sections cannot be judged current against them).
 */

const STAMP_PATTERN = /<!--\s*written-against:\s*([^\s>]+)\s*-->/;
const CITES_PATTERN = /<!--\s*cites-runs:\s*([^>]+?)\s*-->/;
const SHA_LIKE = /^[0-9a-f]{7,40}$/;

export type SectionClass =
  | 'current'
  | 'current-modulo-untracked'
  | 'stale'
  | 'unstamped'
  | 'incomparable';

export type SectionReport = {
  heading: string;
  class: SectionClass;
  cause: string;
};

export type NotebookStalenessReport = {
  notebook_found: boolean;
  sections: SectionReport[];
  counts: Record<SectionClass, number>;
  baseline_set: Array<{ result_id: string; commit: string | null; sentinel: boolean; untracked_qualified: boolean }>;
};

function git(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync(
      'git',
      ['--no-optional-locks', '-C', projectRoot, ...args],
      { encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
}

function resolveCommit(projectRoot: string, ref: string): string | null {
  if (!SHA_LIKE.test(ref)) return null; // moving refs are rejected by contract
  const resolved = git(projectRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return resolved?.trim() || null;
}

function isAncestor(projectRoot: string, ancestor: string, descendant: string): boolean | null {
  try {
    execFileSync(
      'git',
      ['--no-optional-locks', '-C', projectRoot, 'merge-base', '--is-ancestor', ancestor, descendant],
      { timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
    return null; // git failure — comparison undecidable, never guessed
  }
}

export function checkNotebookStaleness(
  projectRoot: string,
  ledgerView?: ValidityLedgerView,
): NotebookStalenessReport {
  const counts: Record<SectionClass, number> = {
    'current': 0, 'current-modulo-untracked': 0, stale: 0, unstamped: 0, incomparable: 0,
  };
  const report: NotebookStalenessReport = {
    notebook_found: false, sections: [], counts, baseline_set: [],
  };
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  if (!fs.existsSync(notebookPath)) return report;
  report.notebook_found = true;

  const ledger = ledgerView ?? readValidityLedger(projectRoot);
  const registry = validateResultRegistry(projectRoot, ledger);

  // Baseline set B from the current registry rows. Fail-closed admission:
  // a row whose identity is not a resolvable exact commit is a sentinel.
  const baseline: Array<{ result_id: string; commit: string | null; sentinel: boolean; untracked_qualified: boolean }> = [];
  // Design D5's fail-closed admission includes "whose registry line is
  // malformed": a table line the parser could not see may BE a current row,
  // so its mere existence blocks unqualified currency — a sentinel with no
  // commit keeps every stamped section at `incomparable` until repaired.
  if (registry.issues.some(entry => entry.code === 'malformed_result_row')) {
    baseline.push({
      result_id: '(malformed registry line)', commit: null, sentinel: true, untracked_qualified: false,
    });
  }
  for (const row of registry.current) {
    const known = ledger.runs.get(row.run_id);
    const origin = known?.origin as unknown as Record<string, unknown> | null;
    const quality = origin && typeof origin.binding_quality === 'string' ? origin.binding_quality : null;
    const fullCommit = origin && typeof origin.snapshot_commit === 'string'
      ? origin.snapshot_commit
      : origin && typeof origin.baseline_commit === 'string' ? origin.baseline_commit : null;
    const sentinel = registry.defective_result_ids.has(row.result_id)
      || !known || !known.stamped
      || quality === 'aligned_heuristic' || quality === 'unbound'
      || fullCommit === null;
    baseline.push({
      result_id: row.result_id,
      commit: sentinel ? null : fullCommit,
      sentinel,
      untracked_qualified: quality === 'head_plus_untracked',
    });
  }
  report.baseline_set = baseline;

  // Split the notebook into ## sections (content before the first ## is
  // front matter and not classified).
  const text = fs.readFileSync(notebookPath, 'utf-8');
  const lines = text.split('\n');
  const sections: Array<{ heading: string; body: string[] }> = [];
  let currentSection: { heading: string; body: string[] } | null = null;
  // Fence-aware: a `## ...` line INSIDE a fenced code block is content, not
  // a section heading — treating it as one would let fenced examples smuggle
  // stamps and citations into the classification.
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue; // fence delimiters and fenced content stay OUT of the
      // matching body: a fenced example must not smuggle stamps or
      // citations into classification. (An unclosed fence extends to EOF —
      // CommonMark semantics — so everything after it is fenced content.)
    }
    if (inFence) {
      continue;
    }
    if (/^##\s+/.test(line)) {
      if (currentSection) sections.push(currentSection);
      currentSection = { heading: line.replace(/^##\s+/, '').trim(), body: [] };
    } else if (currentSection) {
      currentSection.body.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  for (const section of sections) {
    const body = section.body.join('\n');
    const classify = (cls: SectionClass, cause: string): void => {
      counts[cls] += 1;
      report.sections.push({ heading: section.heading, class: cls, cause });
    };

    // Step 1: cited runs outrank commit currency.
    const citesMatches = [...body.matchAll(new RegExp(CITES_PATTERN.source, 'g'))];
    if (citesMatches.length > 0) {
      const citedIds = citesMatches
        .flatMap(match => match[1]!.split(','))
        .map(id => id.trim()).filter(id => id.length > 0);
      const dead = citedIds.find((id) => {
        const known = ledger.runs.get(id);
        return known !== undefined && known.validity !== 'active';
      });
      if (dead) {
        classify('stale', `cites-superseded-run: ${dead} is ${ledger.runs.get(dead)!.validity}`);
        continue;
      }
    }
    // Step 2: no stamp. Per the stated convention sections END with their
    // stamp, so with multiple stamps the LAST one is authoritative — a
    // first-match rule would let any earlier example outrank the real one.
    const stampMatches = [...body.matchAll(new RegExp(STAMP_PATTERN.source, 'g'))];
    const stampMatch = stampMatches.length > 0 ? stampMatches[stampMatches.length - 1]! : null;
    if (!stampMatch) {
      classify('unstamped', 'never-stamped');
      continue;
    }
    // Step 3: stamp unresolvable (includes moving refs, rejected by contract).
    const stamp = resolveCommit(projectRoot, stampMatch[1]!);
    if (!stamp) {
      classify('incomparable', `unresolvable-stamp: ${stampMatch[1]}`);
      continue;
    }
    // Steps 4-6 against every baseline member, worst-wins.
    let stale: string | null = null;
    let incomparable: string | null = null;
    let untrackedQualified = false;
    for (const member of baseline) {
      if (member.sentinel || !member.commit) {
        incomparable = incomparable ?? `unbindable-result-row: ${member.result_id}`;
        continue;
      }
      const resolved = resolveCommit(projectRoot, member.commit);
      if (!resolved) {
        incomparable = incomparable ?? `unresolvable-baseline: ${member.result_id}`;
        continue;
      }
      if (resolved === stamp) {
        if (member.untracked_qualified) untrackedQualified = true;
        continue;
      }
      const stampBehind = isAncestor(projectRoot, stamp, resolved);
      if (stampBehind === true) {
        stale = `stamp-behind: ${member.result_id}`;
        break; // worst outcome for this section is decided
      }
      if (stampBehind === null) {
        // A git FAILURE is not divergence — same class (incomparable), but
        // the cause must say what actually happened.
        incomparable = incomparable ?? `comparison-failed: ${member.result_id}`;
        continue;
      }
      const stampAhead = isAncestor(projectRoot, resolved, stamp);
      if (stampAhead === true) {
        if (member.untracked_qualified) untrackedQualified = true;
        continue;
      }
      if (stampAhead === null) {
        incomparable = incomparable ?? `comparison-failed: ${member.result_id}`;
        continue;
      }
      incomparable = incomparable ?? `diverged-history: ${member.result_id}`;
    }
    if (stale) {
      classify('stale', stale);
    } else if (incomparable) {
      classify('incomparable', incomparable);
    } else if (baseline.length === 0) {
      classify('current', 'no-current-results');
    } else if (untrackedQualified) {
      classify('current-modulo-untracked', 'compared against a head_plus_untracked identity');
    } else {
      classify('current', 'stamp reaches every current baseline');
    }
  }
  return report;
}
