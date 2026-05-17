/**
 * linkKbNotes — reconcile a project's Tier 2 paper.json catalog against its
 * Tier 1 knowledge_base markdown notes.
 *
 * The two surfaces are owned by different actors:
 *   - Tier 2 paper.json is hep-mcp's regeneratable catalog of papers used in
 *     evidence / writing pipelines. Created automatically when an evidence
 *     extraction or import runs.
 *   - Tier 1 knowledge_base/*.md notes are irreplaceable human/agent commentary
 *     on a paper (summary, key equations, methodology, etc.). They are NEVER
 *     touched by hep-mcp — they belong to the curator.
 *
 * The two should mostly be in 1:1 correspondence on canonical_id, but in
 * practice they drift: a paper is read and noted but never added to a build,
 * or a paper is added to the catalog but the curator has not written a note
 * yet. This tool reports the linkage state. It is strictly READ-ONLY: there
 * is no apply path, no deletion, no rewrite. Curators reconcile by hand.
 *
 * Conventions in the wild (observed across real projects under
 * `<project_root>/.autoresearch/...` and `<project_root>/knowledge_base/`):
 *   - KB note filename: `arxiv-<id>.md`, `doi-<doi-sanitized>.md`, or arbitrary
 *     `<slug>.md` with the canonical id only in frontmatter
 *   - KB note frontmatter exposes one or more of:
 *       `RefKey: arxiv-<id>`
 *       `arXiv: <id>`
 *       `DOI: <doi>`
 *
 * The pure function emits buckets:
 *   - matched              : paper.json + KB note both exist for the same canonical_id
 *   - papers_without_note  : paper.json present but no KB note found
 *   - notes_without_paper  : KB note present but no paper.json with matching id
 *   - notes_unparseable    : KB note where no canonical id could be extracted
 *
 * Auto-detection of kb_dir: callers may pass an explicit `kb_dir` (absolute);
 * otherwise the tool probes a small ordered list of common candidates under
 * `project_root` and returns the resolved path in the report. Auto-detection
 * is a convenience for ad-hoc invocation; production callers should pass
 * `kb_dir` explicitly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARXIV_ID_REGEX } from '@autoresearch/arxiv-mcp/tooling';

export const KB_LINK_REPORT_SCHEMA_VERSION = 1 as const;

export interface KbLinkMatched {
  canonical_id: string;
  project_id: string;
  paper_id: string;
  paper_json: string;
  kb_note: string;
}

export interface KbLinkPaperWithoutNote {
  project_id: string;
  paper_id: string;
  canonical_id: string | null;
  paper_json: string;
  expected_kb_notes: string[];
  reason: string;
}

export interface KbLinkNoteWithoutPaper {
  kb_note: string;
  extracted_canonical_ids: string[];
}

export interface KbLinkNoteUnparseable {
  kb_note: string;
  reason: string;
}

export interface KbLinkDuplicateNote {
  canonical_id: string;
  /** The kb_note registered as the primary match for this canonical_id. */
  primary_kb_note: string;
  /** Other kb_notes that also claim this canonical_id. */
  duplicate_kb_notes: string[];
}

export interface KbLinkSummary {
  total_papers: number;
  total_kb_notes: number;
  total_matched: number;
  total_papers_without_note: number;
  total_notes_without_paper: number;
  total_notes_unparseable: number;
  total_duplicate_notes: number;
}

export interface KbLinkReport {
  schema_version: typeof KB_LINK_REPORT_SCHEMA_VERSION;
  project_root: string;
  hep_data_root: string;
  kb_dir: string;
  kb_dir_source: 'explicit' | 'auto_detected' | 'missing';
  matched: KbLinkMatched[];
  papers_without_note: KbLinkPaperWithoutNote[];
  notes_without_paper: KbLinkNoteWithoutPaper[];
  notes_unparseable: KbLinkNoteUnparseable[];
  /**
   * KB notes that claim a canonical_id already claimed by an earlier-indexed
   * note. The primary note is the one that participates in the matched /
   * notes_without_paper buckets; duplicates appear here instead, even when a
   * matching paper.json exists (otherwise the curator would see a phantom
   * orphan in notes_without_paper).
   */
  duplicate_notes: KbLinkDuplicateNote[];
  summary: KbLinkSummary;
}

export interface KbLinkOptions {
  /** Absolute path to the autoresearch project root. */
  project_root: string;
  /**
   * Optional override for the Tier 2 root; defaults to
   * `<project_root>/artifacts/hep-mcp/`.
   */
  hep_data_root?: string;
  /**
   * Optional absolute path to the KB note dir. If omitted, the tool probes a
   * fixed list of candidates under `project_root` (see KB_DIR_CANDIDATES) and
   * picks the first that exists. If none exist, the report sets kb_dir to the
   * highest-priority candidate path (still under project_root) and marks
   * kb_dir_source='missing'.
   */
  kb_dir?: string;
}

/**
 * Ordered list of candidate KB-note directories, relative to project_root.
 * The first existing entry wins. Order reflects observed conventions in the
 * wild: dotted ".autoresearch/knowledge_base" first (current convention in
 * real projects), then the original 5-step-plan slot, then a plain root-level
 * "knowledge_base/" fallback.
 */
const KB_DIR_CANDIDATES = [
  '.autoresearch/knowledge_base',
  'knowledge_base/literature',
  'knowledge_base',
] as const;

/**
 * Same canonicalization rule as the rest of the admin family (migrate / prune
 * / import). Restricts the accepted scheme set so all four tools agree on
 * which strings name the same paper.
 */
function canonicalizeIdentifier(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase();
    if (scheme === 'arxiv' || scheme === 'doi' || scheme === 'inspire' || scheme === 'zotero') {
      return trimmed;
    }
    return null;
  }
  if (ARXIV_ID_REGEX.test(trimmed)) return `arxiv:${trimmed}`;
  if (/^10\.\d{4,9}\//.test(trimmed)) return `doi:${trimmed}`;
  if (/^\d+$/.test(trimmed)) return `inspire:recid:${trimmed}`;
  return null;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Extract every plausible canonical identifier from a KB-note markdown file.
 * Scans the first ~50 lines (frontmatter region) for the patterns observed in
 * the wild: `RefKey: arxiv-<id>`, `arXiv: <id>`, `DOI: <doi>`. Also derives one
 * from the filename if it looks like `arxiv-<id>.md` or `<bare-arxiv-id>.md`.
 *
 * Returns the deduplicated, canonical-form set. Empty if no parseable id was
 * found anywhere.
 */
function extractCanonicalIdsFromNote(notePath: string): string[] {
  const ids = new Set<string>();

  // Filename-derived id.
  const base = path.basename(notePath, '.md');
  // `arxiv-<id>` (legacy form with dash); reconstruct legacy slash for hep-ph
  // ids if present.
  const arxivPrefix = /^arxiv-(.+)$/i.exec(base);
  if (arxivPrefix) {
    const id = arxivPrefix[1]!;
    const canon = canonicalizeIdentifier(`arxiv:${id}`);
    if (canon) ids.add(canon);
  } else {
    // Bare arxiv id as filename.
    const canon = canonicalizeIdentifier(base);
    if (canon && canon.startsWith('arxiv:')) ids.add(canon);
  }

  // Frontmatter scan.
  let head: string;
  try {
    // Read only the first ~8 KiB; frontmatter is always at the top.
    const fd = fs.openSync(notePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [...ids];
  }
  // The 8 KiB chunk is split into lines; the per-pattern `\S+` non-greedy
  // class is the safety guard, NOT the 50-line slice — if the head contains a
  // single giant unwrapped line, the regexes simply don't match and we fall
  // through. The slice is a cheap "don't scan body text past the frontmatter
  // region" bound.
  const lines = head.split('\n').slice(0, 50);
  for (const line of lines) {
    // RefKey: arxiv-<id>  →  arxiv:<id>
    let m = /^RefKey:\s*arxiv-(\S+)/i.exec(line);
    if (m) {
      const c = canonicalizeIdentifier(`arxiv:${m[1]}`);
      if (c) ids.add(c);
      continue;
    }
    // arXiv: <id>. We use `\S+` and DROP the end-of-line anchor so trailing
    // annotations like `arXiv: 2401.09012 (v3)` or `# comment` are tolerated;
    // canonicalizeIdentifier rejects ill-formed values downstream.
    m = /^arXiv:\s*(\S+)/i.exec(line);
    if (m) {
      const c = canonicalizeIdentifier(`arxiv:${m[1]}`);
      if (c) ids.add(c);
      continue;
    }
    // DOI: <doi>
    m = /^DOI:\s*(\S+)/i.exec(line);
    if (m) {
      const c = canonicalizeIdentifier(`doi:${m[1]}`);
      if (c) ids.add(c);
      continue;
    }
    // INSPIRE recid: 12345 — observed less often, but support it.
    m = /^(?:INSPIRE[\s_-]?recid|recid):\s*(\d+)/i.exec(line);
    if (m) {
      const c = canonicalizeIdentifier(`inspire:recid:${m[1]}`);
      if (c) ids.add(c);
      continue;
    }
  }
  return [...ids];
}

/**
 * Walk <hep_data_root>/projects/<id>/papers/<paper_id>/paper.json and yield
 * one record per readable file. Returns a flat list (not grouped) so callers
 * can index it however they want.
 */
function readPaperJsonCatalog(hepDataRoot: string): Array<{
  project_id: string;
  paper_id: string;
  paper_json: string;
  canonical_id: string | null;
}> {
  const out: Array<{ project_id: string; paper_id: string; paper_json: string; canonical_id: string | null }> = [];
  const projectsDir = path.join(hepDataRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return out;
  for (const projectEntry of safeReaddir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const papersDir = path.join(projectsDir, projectEntry.name, 'papers');
    if (!fs.existsSync(papersDir)) continue;
    for (const paperEntry of safeReaddir(papersDir)) {
      if (!paperEntry.isDirectory()) continue;
      const paperJsonPath = path.join(papersDir, paperEntry.name, 'paper.json');
      let raw: string;
      try {
        raw = fs.readFileSync(paperJsonPath, 'utf-8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Unparseable paper.json is silently skipped here. The prune tool's
        // own pass would surface the same file as unrecognized.
        continue;
      }
      let ident: string | undefined;
      if (parsed && typeof parsed === 'object') {
        const source = (parsed as Record<string, unknown>).source;
        if (source && typeof source === 'object') {
          const i = (source as Record<string, unknown>).identifier;
          if (typeof i === 'string') ident = i;
        }
        if (!ident) {
          const i = (parsed as Record<string, unknown>).identifier;
          if (typeof i === 'string') ident = i;
        }
      }
      const canonical = ident ? canonicalizeIdentifier(ident) : null;
      out.push({
        project_id: projectEntry.name,
        paper_id: paperEntry.name,
        paper_json: paperJsonPath,
        canonical_id: canonical,
      });
    }
  }
  return out;
}

/**
 * Compute the candidate KB note filename forms for a given canonical_id. Used
 * to surface "expected places to check" when reporting a paper-without-note.
 * The matching loop itself uses canonical_id equality, NOT filename equality —
 * these strings are diagnostic only.
 */
function candidateNoteFilenames(canonicalId: string): string[] {
  // arxiv:2401.09012v3  →  arxiv-2401.09012v3.md
  // doi:10.1103/X       →  doi-10.1103_X.md  (slashes replaced with underscore,
  //                                            since slashes are illegal in
  //                                            filenames)
  if (canonicalId.startsWith('arxiv:')) {
    const id = canonicalId.slice('arxiv:'.length);
    return [`arxiv-${id}.md`];
  }
  if (canonicalId.startsWith('doi:')) {
    const doi = canonicalId.slice('doi:'.length);
    return [`doi-${doi.replace(/\//g, '_')}.md`];
  }
  if (canonicalId.startsWith('inspire:recid:')) {
    const recid = canonicalId.slice('inspire:recid:'.length);
    return [`inspire-recid-${recid}.md`];
  }
  return [`${canonicalId.replace(/[:/]/g, '-')}.md`];
}

/**
 * Resolve kb_dir. Returns the resolved path and a tag describing where it
 * came from (explicit, auto_detected, or missing).
 */
function resolveKbDir(
  projectRoot: string,
  override: string | undefined,
): { kbDir: string; source: 'explicit' | 'auto_detected' | 'missing' } {
  if (override) {
    return { kbDir: path.resolve(override), source: 'explicit' };
  }
  for (const cand of KB_DIR_CANDIDATES) {
    const p = path.join(projectRoot, cand);
    if (fs.existsSync(p)) {
      return { kbDir: p, source: 'auto_detected' };
    }
  }
  // Nothing exists; return the highest-priority candidate path so the report
  // has a concrete path the user can `mkdir -p` if they want.
  return { kbDir: path.join(projectRoot, KB_DIR_CANDIDATES[0]), source: 'missing' };
}

export async function linkKbNotes(opts: KbLinkOptions): Promise<KbLinkReport> {
  if (!opts.project_root || !path.isAbsolute(opts.project_root)) {
    throw new Error(`linkKbNotes: project_root must be an absolute path, got ${JSON.stringify(opts.project_root)}`);
  }
  const projectRoot = path.resolve(opts.project_root);
  const hepDataRoot = opts.hep_data_root
    ? path.resolve(opts.hep_data_root)
    : path.join(projectRoot, 'artifacts', 'hep-mcp');

  const { kbDir, source: kbDirSource } = resolveKbDir(projectRoot, opts.kb_dir);

  // 1. Collect Tier 2 paper.json catalog.
  const papers = readPaperJsonCatalog(hepDataRoot);
  const paperByCanonicalId = new Map<string, (typeof papers)[number]>();
  for (const p of papers) {
    if (p.canonical_id) paperByCanonicalId.set(p.canonical_id, p);
  }

  // 2. Collect Tier 1 KB notes (non-recursive — we don't probe subdirs to
  //    avoid swallowing the curator's organizational structure).
  const noteEntries = safeReaddir(kbDir).filter(e => e.isFile() && e.name.endsWith('.md'));
  const notes = noteEntries.map(e => path.join(kbDir, e.name));
  const noteCanonicalIds = new Map<string, string[]>(); // notePath -> canonical_ids
  for (const notePath of notes) {
    noteCanonicalIds.set(notePath, extractCanonicalIdsFromNote(notePath));
  }

  // 3. Bucket.
  const matched: KbLinkMatched[] = [];
  const papersWithoutNote: KbLinkPaperWithoutNote[] = [];
  const notesWithoutPaper: KbLinkNoteWithoutPaper[] = [];
  const notesUnparseable: KbLinkNoteUnparseable[] = [];
  const duplicateNotesByCanonicalId = new Map<string, KbLinkDuplicateNote>();

  // Index notes by canonical_id. A note may carry multiple ids (e.g. arxiv +
  // DOI for the same paper) and is registered under each. The FIRST note
  // seen for a given canonical_id becomes the primary; subsequent notes that
  // claim the same id are tracked as duplicates so they don't become phantom
  // orphans in `notes_without_paper`.
  const noteByCanonicalId = new Map<string, string>();
  const duplicateNotePaths = new Set<string>(); // any note flagged as a duplicate of another
  for (const [notePath, ids] of noteCanonicalIds) {
    if (ids.length === 0) {
      notesUnparseable.push({
        kb_note: notePath,
        reason: 'no RefKey / arXiv: / DOI: line found in frontmatter and filename does not encode a recognized identifier',
      });
      continue;
    }
    for (const id of ids) {
      const primary = noteByCanonicalId.get(id);
      if (primary === undefined) {
        noteByCanonicalId.set(id, notePath);
      } else if (primary !== notePath) {
        duplicateNotePaths.add(notePath);
        let dup = duplicateNotesByCanonicalId.get(id);
        if (!dup) {
          dup = { canonical_id: id, primary_kb_note: primary, duplicate_kb_notes: [] };
          duplicateNotesByCanonicalId.set(id, dup);
        }
        if (!dup.duplicate_kb_notes.includes(notePath)) dup.duplicate_kb_notes.push(notePath);
      }
    }
  }

  // Paired pass: papers matched against notes.
  const matchedNotePaths = new Set<string>();
  for (const paper of papers) {
    if (!paper.canonical_id) {
      papersWithoutNote.push({
        project_id: paper.project_id,
        paper_id: paper.paper_id,
        canonical_id: null,
        paper_json: paper.paper_json,
        expected_kb_notes: [],
        reason: 'paper.json has no source.identifier — cannot derive canonical_id to look up a KB note',
      });
      continue;
    }
    const note = noteByCanonicalId.get(paper.canonical_id);
    if (note) {
      matched.push({
        canonical_id: paper.canonical_id,
        project_id: paper.project_id,
        paper_id: paper.paper_id,
        paper_json: paper.paper_json,
        kb_note: note,
      });
      matchedNotePaths.add(note);
    } else {
      // Suppress the "expected" paths suggestion when kb_dir is missing —
      // the candidate filenames would point into a directory that does not
      // exist, which is misleading. The reason string makes the missing-dir
      // case explicit instead.
      const expectedKbNotes =
        kbDirSource === 'missing'
          ? []
          : candidateNoteFilenames(paper.canonical_id).map(f => path.join(kbDir, f));
      const reason =
        kbDirSource === 'missing'
          ? `no KB note found because kb_dir does not exist (${kbDir}); paper canonical_id=${paper.canonical_id}`
          : `no KB note in ${kbDir} declares canonical_id=${paper.canonical_id}`;
      papersWithoutNote.push({
        project_id: paper.project_id,
        paper_id: paper.paper_id,
        canonical_id: paper.canonical_id,
        paper_json: paper.paper_json,
        expected_kb_notes: expectedKbNotes,
        reason,
      });
    }
  }

  // Notes not paired with any paper. A duplicate-of-another-note is excluded
  // from this bucket regardless of whether its canonical_id matches a paper
  // (matched papers point to the primary note). Duplicates surface only in
  // the duplicate_notes bucket.
  for (const [notePath, ids] of noteCanonicalIds) {
    if (ids.length === 0) continue; // already in unparseable
    if (matchedNotePaths.has(notePath)) continue;
    if (duplicateNotePaths.has(notePath)) continue;
    notesWithoutPaper.push({ kb_note: notePath, extracted_canonical_ids: ids });
  }

  const duplicateNotes = [...duplicateNotesByCanonicalId.values()];

  return {
    schema_version: KB_LINK_REPORT_SCHEMA_VERSION,
    project_root: projectRoot,
    hep_data_root: hepDataRoot,
    kb_dir: kbDir,
    kb_dir_source: kbDirSource,
    matched,
    papers_without_note: papersWithoutNote,
    notes_without_paper: notesWithoutPaper,
    notes_unparseable: notesUnparseable,
    duplicate_notes: duplicateNotes,
    summary: {
      total_papers: papers.length,
      total_kb_notes: notes.length,
      total_matched: matched.length,
      total_papers_without_note: papersWithoutNote.length,
      total_notes_without_paper: notesWithoutPaper.length,
      total_notes_unparseable: notesUnparseable.length,
      total_duplicate_notes: duplicateNotes.length,
    },
  };
}

/** Human-readable rendering for the CLI wrapper. */
export function formatKbLinkReport(r: KbLinkReport): string {
  const lines: string[] = [];
  lines.push(`hep_admin_link_kb_notes — schema_version=${r.schema_version}`);
  lines.push(`  project_root  : ${r.project_root}`);
  lines.push(`  hep_data_root : ${r.hep_data_root}`);
  lines.push(`  kb_dir        : ${r.kb_dir} (${r.kb_dir_source})`);
  lines.push('');
  lines.push(
    `summary: papers=${r.summary.total_papers} notes=${r.summary.total_kb_notes} ` +
      `matched=${r.summary.total_matched} ` +
      `papers_without_note=${r.summary.total_papers_without_note} ` +
      `notes_without_paper=${r.summary.total_notes_without_paper} ` +
      `notes_unparseable=${r.summary.total_notes_unparseable} ` +
      `duplicate_notes=${r.summary.total_duplicate_notes}`,
  );
  if (r.papers_without_note.length > 0) {
    lines.push('');
    lines.push('papers_without_note:');
    for (const p of r.papers_without_note) {
      lines.push(`  - ${p.project_id}/${p.paper_id}  canonical=${p.canonical_id ?? '<none>'}`);
      lines.push(`      ${p.reason}`);
    }
  }
  if (r.notes_without_paper.length > 0) {
    lines.push('');
    lines.push('notes_without_paper:');
    for (const n of r.notes_without_paper) {
      lines.push(`  - ${n.kb_note}`);
      lines.push(`      extracted_ids: ${n.extracted_canonical_ids.join(', ')}`);
    }
  }
  if (r.notes_unparseable.length > 0) {
    lines.push('');
    lines.push('notes_unparseable:');
    for (const n of r.notes_unparseable) {
      lines.push(`  - ${n.kb_note}`);
      lines.push(`      ${n.reason}`);
    }
  }
  if (r.duplicate_notes.length > 0) {
    lines.push('');
    lines.push('duplicate_notes:');
    for (const d of r.duplicate_notes) {
      lines.push(`  - canonical_id: ${d.canonical_id}`);
      lines.push(`      primary  : ${d.primary_kb_note}`);
      for (const dup of d.duplicate_kb_notes) lines.push(`      duplicate: ${dup}`);
    }
  }
  return lines.join('\n');
}
