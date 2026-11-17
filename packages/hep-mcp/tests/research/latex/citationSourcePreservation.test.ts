import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/arxivCompat.js', () => ({
  getPaperContent: vi.fn(),
}));

const { getPaperContent } = await import('../../../src/utils/arxivCompat.js');
const { parseLatexContent } = await import('../../../src/tools/research/parseLatexContent.js');

describe('source citation extraction after stance-tool retirement', () => {
  it('keeps citation keys, citing text and positions available without a semantic reviewer', async () => {
    const source = String.raw`\documentclass{article}
\begin{document}
\section{Discussion}
Our result does not contradict the finite-volume analysis of \citep[p.~3]{Alpha:2020,Beta:2021}.
For $L \to \infty$, the comparison with \cite{Gamma:2022} requires different assumptions.
\end{document}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-citation-source-'));
    const mainTex = path.join(directory, 'main.tex');
    fs.writeFileSync(mainTex, source);
    vi.mocked(getPaperContent).mockResolvedValueOnce({
      success: true,
      source_type: 'latex',
      arxiv_id: '2301.12345',
      main_tex: mainTex,
    } as Awaited<ReturnType<typeof getPaperContent>>);
    const createMessage = vi.fn().mockRejectedValue(new Error('citation extraction must not invoke sampling'));

    try {
      const result = await parseLatexContent({
        identifier: '2301.12345',
        components: ['citations'],
        options: { citation_context_window: 200 },
        _mcp: { createMessage },
      });

      expect(getPaperContent).toHaveBeenCalledWith({
        identifier: '2301.12345', prefer: 'latex', extract: true,
      });
      expect(result.metadata.source_file).toBe(mainTex);
      expect(result.citations).toHaveLength(2);
      expect(result.citations?.[0]).toMatchObject({
        type: 'citep',
        keys: ['Alpha:2020', 'Beta:2021'],
        optional_arg: 'p.3',
        section: 'Discussion',
        location: { offset: source.indexOf('\\citep'), line: 4 },
      });
      expect(result.citations?.[0].context).toContain('does not contradict the finite-volume analysis');
      expect(result.citations?.[0].context).toContain('\\citep[p.~3]{Alpha:2020,Beta:2021}');
      expect(result.citations?.[1]).toMatchObject({
        keys: ['Gamma:2022'],
        location: { offset: source.indexOf('\\cite{Gamma'), line: 5 },
      });
      expect(result.citations?.[1].context).toContain('$L \\to \\infty$');
      expect(result.citations?.[1].context).toContain('requires different assumptions');
      expect(result.summary).toEqual({
        components_extracted: ['citations'],
        counts: { citations: 2 },
      });
      expect(createMessage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
