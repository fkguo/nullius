import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/api/client.js', () => ({
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
  search: vi.fn(),
  getPaper: vi.fn(),
}));

const api = await import('../../src/api/client.js');

import { getCorpusDir, getCorpusSourcesDir } from '../../src/corpora/style/paths.js';
import { buildCorpusEvidenceCatalog } from '../../src/corpora/style/evidence.js';
import { MACRO_WRAPPED_EQUATIONS_LATEX_FIXTURE } from '../fixtures/latex/macroWrappedFixture.js';

describe('StyleCorpus LaTeX→evidence (R3)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-evidence-'));
    process.env.HEP_DATA_DIR = dataDir;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('builds stable evidence catalog from fixture LaTeX project', async () => {
    const corpusDir = getCorpusDir('rmp');
    const sourcesDir = getCorpusSourcesDir('rmp');

    const paperKey = 'recid_1';
    const extractedRoot = path.join(sourcesDir, paperKey, 'extracted');
    fs.mkdirSync(path.join(extractedRoot, 'figs'), { recursive: true });

    fs.writeFileSync(
      path.join(extractedRoot, 'main.tex'),
      String.raw`\documentclass{article}
\title{Test Paper}
\begin{document}
\maketitle
\begin{abstract}
We study X.
\end{abstract}

\section{Introduction}
We assume an effective field theory description. The energy is 13 TeV.

\section{Results}
We find m = 125.09 \pm 0.24 GeV. The significance is 5\sigma. See Fig.~\ref{fig:one} and \cite{CustomKey}.
\begin{figure}
\centering
\includegraphics{figs/plot}
\caption{A test figure.}
\label{fig:one}
\end{figure}

\begin{equation}
E = mc^2
\label{eq:einstein}
\end{equation}

\bibliographystyle{unsrt}
\bibliography{refs}
\end{document}
`,
      'utf-8'
    );

    fs.writeFileSync(
      path.join(extractedRoot, 'refs.bib'),
      String.raw`@article{CustomKey,
  eprint = {2301.01234},
  archivePrefix = {arXiv},
  primaryClass = {hep-th},
  title = {Quantum Widget Dynamics},
  year = {2020}
}
`,
      'utf-8'
    );

    fs.writeFileSync(path.join(extractedRoot, 'figs', 'plot.pdf'), '%PDF-1.4\n% dummy\n', 'utf-8');

    vi.mocked(api.getByArxiv).mockResolvedValue({
      recid: '123',
      title: 'Mapped paper',
      authors: ['Doe, Jane'],
      year: 2020,
    } as any);

    vi.mocked(api.getPaper).mockResolvedValue({
      recid: '123',
      title: 'Mapped paper',
      authors: ['Doe, Jane'],
      year: 2020,
      texkey: 'Doe:2020ab',
    } as any);

    const entry: any = {
      version: 1,
      style_id: 'rmp',
      recid: '1',
      title: 'Fixture',
      status: 'downloaded',
      source: {
        source_type: 'latex',
        source_dir: `sources/${paperKey}/extracted`,
        main_tex: `sources/${paperKey}/extracted/main.tex`,
      },
    };

    const res = await buildCorpusEvidenceCatalog({
      style_id: 'rmp',
      entry,
      map_citations_to_inspire: true,
    });

    expect(res.catalog_path).toContain(path.join(corpusDir, 'evidence', paperKey));
    const catalogText = fs.readFileSync(res.catalog_path, 'utf-8');
    expect(catalogText).toMatchSnapshot();

    // Sanity: mapped citekey shows up in citation_context
    expect(catalogText).toContain('Doe:2020ab');
    expect(catalogText).toContain('CustomKey');
  });

  it('extracts macro-wrapped equations and prevents paragraph leakage', async () => {
    const corpusDir = getCorpusDir('rmp');
    const sourcesDir = getCorpusSourcesDir('rmp');

    const paperKey = 'recid_2';
    const extractedRoot = path.join(sourcesDir, paperKey, 'extracted');
    fs.mkdirSync(extractedRoot, { recursive: true });

    fs.writeFileSync(path.join(extractedRoot, 'main.tex'), MACRO_WRAPPED_EQUATIONS_LATEX_FIXTURE, 'utf-8');

    const entry: any = {
      version: 1,
      style_id: 'rmp',
      recid: '2',
      title: 'Macro-wrapped fixture',
      status: 'downloaded',
      source: {
        source_type: 'latex',
        source_dir: `sources/${paperKey}/extracted`,
        main_tex: `sources/${paperKey}/extracted/main.tex`,
      },
    };

    const res = await buildCorpusEvidenceCatalog({
      style_id: 'rmp',
      entry,
      map_citations_to_inspire: false,
      include_inline_math: false,
    });

    expect(res.catalog_path).toContain(path.join(corpusDir, 'evidence', paperKey));
    const catalogText = fs.readFileSync(res.catalog_path, 'utf-8');
    const items = catalogText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const equations = items
      .filter((item) => item.type === 'equation')
      .map((item) => ({
        text: item.text,
        label: item.meta?.label,
        env: item.meta?.env_name,
        equation_type: item.meta?.equation_type,
      }));
    expect(equations).toMatchSnapshot();

    const abstracts = items.filter((item) => item.type === 'abstract').map((item) => item.text);
    expect(abstracts).toHaveLength(1);
    expect(abstracts[0]).toContain('We study X');

    const paragraphs = items.filter((item) => item.type === 'paragraph').map((item) => item.text);
    const leaked = paragraphs.some((p: string) => /a\s*=\s*b/.test(p) || /x\s*&=\s*&\s*y/.test(p));
    expect(leaked).toBe(false);

    expect(paragraphs.some((p: string) => p.includes('We study X'))).toBe(false);
    expect(paragraphs.some((p: string) => p.includes('bibliography entry'))).toBe(false);
  });
});
