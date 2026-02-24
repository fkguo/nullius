import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getCorpusEvidenceDir } from '../../src/corpora/style/paths.js';
import { buildCorpusIndex, queryCorpusIndex } from '../../src/corpora/style/indexing.js';

describe('StyleCorpus hybrid retrieval (R4)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-retrieval-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('builds index + returns stable top hits', () => {
    const evidenceDir = getCorpusEvidenceDir('rmp');
    const paperDir = path.join(evidenceDir, 'recid_1');
    fs.mkdirSync(paperDir, { recursive: true });

    const catalogPath = path.join(paperDir, 'catalog.jsonl');
    const items = [
      {
        version: 1,
        style_id: 'rmp',
        recid: '1',
        paper_key: 'recid_1',
        type: 'sentence',
        evidence_id: 'ev_1',
        locator: { kind: 'latex', file: 'main.tex', offset: 10, line: 1, column: 1 },
        text: 'The energy is 13 TeV.',
      },
      {
        version: 1,
        style_id: 'rmp',
        recid: '1',
        paper_key: 'recid_1',
        type: 'sentence',
        evidence_id: 'ev_2',
        locator: { kind: 'latex', file: 'main.tex', offset: 20, line: 2, column: 1 },
        text: 'We assume an effective field theory description.',
      },
      {
        version: 1,
        style_id: 'rmp',
        recid: '1',
        paper_key: 'recid_1',
        type: 'sentence',
        evidence_id: 'ev_3',
        locator: { kind: 'latex', file: 'main.tex', offset: 30, line: 3, column: 1 },
        text: 'This sentence is unrelated to physics.',
      },
    ];

    fs.writeFileSync(catalogPath, items.map(it => JSON.stringify(it)).join('\n') + '\n', 'utf-8');

    const built = buildCorpusIndex({ style_id: 'rmp', embedding_dim: 128, embedding_model: 'hash-embedding-v1' });
    expect(built.summary.total_items).toBe(3);

    const q1 = queryCorpusIndex({ style_id: 'rmp', query: '13 TeV energy', top_k: 2 });
    expect(q1.hits[0]?.evidence_id).toBe('ev_1');

    const q2 = queryCorpusIndex({ style_id: 'rmp', query: 'effective field theory', top_k: 2 });
    expect(q2.hits[0]?.evidence_id).toBe('ev_2');
  });
});
