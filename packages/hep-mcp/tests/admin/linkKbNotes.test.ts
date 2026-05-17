import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { linkKbNotes, formatKbLinkReport } from '../../src/admin/linkKbNotes.js';

function makePaperJson(projectRoot: string, projectId: string, paperId: string, identifier?: string): string {
  const dir = path.join(projectRoot, 'artifacts', 'hep-mcp', 'projects', projectId, 'papers', paperId);
  fs.mkdirSync(dir, { recursive: true });
  const paperJson = path.join(dir, 'paper.json');
  const body = identifier
    ? { version: 1, source: { kind: 'latex', identifier, main_tex: 'main.tex' } }
    : { version: 1, source: { kind: 'latex', main_tex: 'main.tex' } };
  fs.writeFileSync(paperJson, JSON.stringify(body));
  return paperJson;
}

function makeKbNote(kbDir: string, filename: string, body: string): string {
  fs.mkdirSync(kbDir, { recursive: true });
  const p = path.join(kbDir, filename);
  fs.writeFileSync(p, body);
  return p;
}

describe('linkKbNotes', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'kblink-proj-'));
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('rejects relative project_root', async () => {
      await expect(linkKbNotes({ project_root: 'relative/path' })).rejects.toThrow(/absolute path/);
    });
  });

  describe('kb_dir resolution', () => {
    it('auto-detects .autoresearch/knowledge_base when present', async () => {
      fs.mkdirSync(path.join(tmpProject, '.autoresearch', 'knowledge_base'), { recursive: true });
      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.kb_dir).toBe(path.join(tmpProject, '.autoresearch', 'knowledge_base'));
      expect(r.kb_dir_source).toBe('auto_detected');
    });

    it('falls through to knowledge_base/literature when the dotted form is absent', async () => {
      fs.mkdirSync(path.join(tmpProject, 'knowledge_base', 'literature'), { recursive: true });
      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.kb_dir).toBe(path.join(tmpProject, 'knowledge_base', 'literature'));
      expect(r.kb_dir_source).toBe('auto_detected');
    });

    it('falls through to plain knowledge_base when the more-specific candidates are absent', async () => {
      fs.mkdirSync(path.join(tmpProject, 'knowledge_base'), { recursive: true });
      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.kb_dir).toBe(path.join(tmpProject, 'knowledge_base'));
      expect(r.kb_dir_source).toBe('auto_detected');
    });

    it('marks kb_dir_source=missing when no candidate exists', async () => {
      const r = await linkKbNotes({ project_root: tmpProject });
      // Should still report the highest-priority candidate path.
      expect(r.kb_dir).toBe(path.join(tmpProject, '.autoresearch', 'knowledge_base'));
      expect(r.kb_dir_source).toBe('missing');
    });

    it('honours an explicit kb_dir override', async () => {
      const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-kb-'));
      try {
        const r = await linkKbNotes({ project_root: tmpProject, kb_dir: explicit });
        expect(r.kb_dir).toBe(explicit);
        expect(r.kb_dir_source).toBe('explicit');
      } finally {
        fs.rmSync(explicit, { recursive: true, force: true });
      }
    });
  });

  describe('canonical_id extraction from KB notes', () => {
    it('matches a paper.json by RefKey: arxiv-<id> frontmatter line', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'arxiv_2401_09012v3', 'arxiv:2401.09012v3');
      makeKbNote(kbDir, 'note-with-refkey.md', '# KB note\n\nRefKey: arxiv-2401.09012v3\n\n## Summary\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_matched).toBe(1);
      expect(r.matched[0]!.canonical_id).toBe('arxiv:2401.09012v3');
      expect(r.matched[0]!.kb_note).toBe(path.join(kbDir, 'note-with-refkey.md'));
    });

    it('matches by arXiv: frontmatter line when there is no RefKey', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:2401.09012');
      makeKbNote(kbDir, 'arxiv-2401.09012.md', '# KB note\n\narXiv: 2401.09012\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_matched).toBe(1);
      expect(r.matched[0]!.canonical_id).toBe('arxiv:2401.09012');
    });

    it('matches by DOI: frontmatter line', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'doi:10.1103/PhysRevD.110.012345');
      makeKbNote(kbDir, 'note.md', '# KB note\n\nDOI: 10.1103/PhysRevD.110.012345\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_matched).toBe(1);
      expect(r.matched[0]!.canonical_id).toBe('doi:10.1103/PhysRevD.110.012345');
    });

    it('matches by INSPIRE recid frontmatter line', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'inspire:recid:1234567');
      makeKbNote(kbDir, 'note.md', '# KB note\n\nrecid: 1234567\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_matched).toBe(1);
      expect(r.matched[0]!.canonical_id).toBe('inspire:recid:1234567');
    });

    it('matches by filename `arxiv-<id>.md` when frontmatter has no identifier lines', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:hep-ph/9501234');
      // Filename uses the legacy slashless arxiv form (slashes are illegal in
      // filenames anyway).
      makeKbNote(kbDir, 'arxiv-hep-ph/9501234.md'.replace('/', '-'), '# Just a note, no frontmatter\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      // The legacy form `arxiv-hep-ph-9501234` does NOT round-trip back to
      // `hep-ph/9501234` via our canonicalizer (no special handling), so this
      // is expected to NOT match. We assert the documented behaviour.
      expect(r.summary.total_matched).toBe(0);
      expect(r.summary.total_papers_without_note).toBe(1);
      expect(r.summary.total_notes_unparseable + r.summary.total_notes_without_paper).toBe(1);
    });

    it('classifies a note with no extractable id as unparseable', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makeKbNote(kbDir, 'random-slug.md', '# Some thoughts\n\nNo frontmatter, no identifier.\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_notes_unparseable).toBe(1);
      expect(r.notes_unparseable[0]!.kb_note).toBe(path.join(kbDir, 'random-slug.md'));
    });
  });

  describe('buckets', () => {
    it('papers_without_note: paper.json exists but no matching KB note', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      fs.mkdirSync(kbDir, { recursive: true }); // make kbDir exist so auto-detect picks it
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:2401.09012');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_papers_without_note).toBe(1);
      expect(r.papers_without_note[0]!.canonical_id).toBe('arxiv:2401.09012');
      expect(r.papers_without_note[0]!.expected_kb_notes).toEqual([
        path.join(kbDir, 'arxiv-2401.09012.md'),
      ]);
    });

    it('papers_without_note: paper.json has no source.identifier → canonical_id=null', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      fs.mkdirSync(kbDir, { recursive: true });
      makePaperJson(tmpProject, 'p1', 'paper1'); // no identifier

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_papers_without_note).toBe(1);
      expect(r.papers_without_note[0]!.canonical_id).toBeNull();
      expect(r.papers_without_note[0]!.expected_kb_notes).toEqual([]);
    });

    it('notes_without_paper: KB note has canonical_id but no paper.json claims it', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makeKbNote(kbDir, 'note.md', '# KB note\n\nRefKey: arxiv-9999.99999\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_notes_without_paper).toBe(1);
      expect(r.notes_without_paper[0]!.extracted_canonical_ids).toContain('arxiv:9999.99999');
    });

    it('mixed scenario: matched + unmatched on both sides + unparseable', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper-keep', 'arxiv:KEEP.v1');
      makePaperJson(tmpProject, 'p1', 'paper-without', 'arxiv:WITHOUT.v1');
      makeKbNote(kbDir, 'note-matched.md', '# Note\n\nRefKey: arxiv-KEEP.v1\n');
      makeKbNote(kbDir, 'note-orphan.md', '# Note\n\nRefKey: arxiv-ORPHAN.v1\n');
      makeKbNote(kbDir, 'note-mystery.md', '# Note\n\n(nothing identifiable)\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_papers).toBe(2);
      expect(r.summary.total_kb_notes).toBe(3);
      expect(r.summary.total_matched).toBe(1);
      expect(r.summary.total_papers_without_note).toBe(1);
      expect(r.summary.total_notes_without_paper).toBe(1);
      expect(r.summary.total_notes_unparseable).toBe(1);
    });

    it('two notes claiming the same canonical_id: one matches, other is reported separately (NOT as orphan)', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:DUP.v1');
      const noteA = makeKbNote(kbDir, 'arxiv-DUP.v1.md', '# A\n\nRefKey: arxiv-DUP.v1\n');
      const noteB = makeKbNote(kbDir, 'arxiv-DUP-copy.md', '# B\n\nRefKey: arxiv-DUP.v1\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      // Whichever note readdir yields first becomes the primary; the other is
      // tracked as a duplicate. The assertion is order-independent.
      expect(r.summary.total_matched).toBe(1);
      expect(new Set([noteA, noteB])).toContain(r.matched[0]!.kb_note);
      // The duplicate must NOT be a phantom orphan in notes_without_paper.
      expect(r.summary.total_notes_without_paper).toBe(0);
      expect(r.summary.total_duplicate_notes).toBe(1);
      expect(r.duplicate_notes[0]!.canonical_id).toBe('arxiv:DUP.v1');
      // Together the primary + duplicate slots cover both planted notes.
      const dup = r.duplicate_notes[0]!;
      expect(new Set([dup.primary_kb_note, ...dup.duplicate_kb_notes])).toEqual(new Set([noteA, noteB]));
      // The matched note IS the primary; the duplicate is the other.
      expect(r.matched[0]!.kb_note).toBe(dup.primary_kb_note);
      expect(dup.duplicate_kb_notes).toHaveLength(1);
    });

    it('expected_kb_notes is suppressed when kb_dir is missing (no candidate dir on disk)', async () => {
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:2401.09012');
      // Note: no knowledge_base dir is created — kb_dir_source should be 'missing'.
      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.kb_dir_source).toBe('missing');
      expect(r.summary.total_papers_without_note).toBe(1);
      const p = r.papers_without_note[0]!;
      expect(p.expected_kb_notes).toEqual([]);
      expect(p.reason).toMatch(/kb_dir does not exist/);
    });

    it('arXiv: line tolerates trailing annotations (after the relaxed regex)', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:2401.09012');
      makeKbNote(kbDir, 'note.md', '# KB note\n\narXiv: 2401.09012 (v3 currently)\n');
      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_matched).toBe(1);
    });

    it('does not recurse into kb_dir subdirectories', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makeKbNote(kbDir, 'top.md', '# Note\n\nRefKey: arxiv-TOP.v1\n');
      // A subdirectory of kbDir with a markdown file inside — must NOT count.
      const sub = path.join(kbDir, 'subgroup');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'nested.md'), '# nested\n\nRefKey: arxiv-NESTED.v1\n');

      const r = await linkKbNotes({ project_root: tmpProject });
      expect(r.summary.total_kb_notes).toBe(1);
      expect(r.notes_without_paper[0]!.kb_note).toBe(path.join(kbDir, 'top.md'));
    });
  });

  describe('formatKbLinkReport', () => {
    it('renders summary, project_root, kb_dir, and each bucket', async () => {
      const kbDir = path.join(tmpProject, 'knowledge_base');
      makePaperJson(tmpProject, 'p1', 'paper1', 'arxiv:2401.09012');
      makeKbNote(kbDir, 'mystery.md', '# Mystery\n');
      const r = await linkKbNotes({ project_root: tmpProject });
      const text = formatKbLinkReport(r);
      expect(text).toContain('schema_version=1');
      expect(text).toContain(`project_root  : ${tmpProject}`);
      expect(text).toContain(`kb_dir        : ${kbDir}`);
      expect(text).toContain('summary:');
      expect(text).toContain('papers_without_note:');
      expect(text).toContain('notes_unparseable:');
    });
  });
});
