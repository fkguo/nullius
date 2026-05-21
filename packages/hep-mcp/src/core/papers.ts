import * as fs from 'fs';
import * as path from 'path';
import { notFound, writeJsonAtomicDurable } from '@autoresearch/shared';
import { getProjectDir, getProjectPaperJsonPath } from './paths.js';

// hep-mcp project/paper JSON convention: no trailing newline (legacy). Pass
// an explicit stringify to writeJsonAtomicDurable to preserve byte-for-byte
// parity with the existing on-disk format.
const stringifyNoTrailingNewline = (payload: unknown): string =>
  JSON.stringify(payload, null, 2);

export interface HepPaperArtifactRef {
  uri: string;
  generated_at: string;
}

export interface HepPaper {
  version: 1;
  project_id: string;
  paper_id: string;
  created_at: string;
  updated_at: string;
  source: {
    kind: 'latex';
    identifier?: string;
    main_tex: string;
  };
  artifacts?: {
    evidence_catalog?: HepPaperArtifactRef;
  };
  notes?: string[];
}

export function getPaper(projectId: string, paperId: string): HepPaper {
  const paperPath = getProjectPaperJsonPath(projectId, paperId);
  if (!fs.existsSync(paperPath)) {
    throw notFound(`Paper not found: ${paperId}`, { project_id: projectId, paper_id: paperId });
  }
  return JSON.parse(fs.readFileSync(paperPath, 'utf-8')) as HepPaper;
}

export function upsertPaper(paper: HepPaper): HepPaper {
  // writeJsonAtomicDurable performs mkdir + atomic write + file fsync +
  // parent-dir fsync; no separate mkdirSync needed.
  writeJsonAtomicDurable(
    getProjectPaperJsonPath(paper.project_id, paper.paper_id),
    paper,
    stringifyNoTrailingNewline,
  );
  return paper;
}

export function listPapers(projectId: string): HepPaper[] {
  const projectDir = getProjectDir(projectId);
  const papersDir = path.join(projectDir, 'papers');
  if (!fs.existsSync(papersDir)) return [];

  const entries = fs.readdirSync(papersDir, { withFileTypes: true });
  const papers: HepPaper[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paperId = entry.name;
    try {
      papers.push(getPaper(projectId, paperId));
    } catch {
      // Skip unreadable entries
    }
  }

  papers.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return papers;
}

