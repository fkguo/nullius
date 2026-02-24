/**
 * Golden Master Test Mock Data
 * Sample API responses for testing output structure stability
 */

export const MOCK_PAPER_SUMMARY = {
  recid: '1234567',
  title: 'Test Paper on Hadronic Molecules',
  authors: ['Author A', 'Author B'],
  year: '2023',
  arxiv_id: '2301.12345',
  doi: '10.1103/PhysRevD.107.014001',
  citation_count: 50,
  publication: 'Phys. Rev. D 107 (2023) 014001',
};

export const MOCK_PAPER_SUMMARIES = [
  MOCK_PAPER_SUMMARY,
  {
    recid: '1234568',
    title: 'Review of Exotic Hadrons',
    authors: ['Author C', 'Author D', 'Author E'],
    year: '2022',
    arxiv_id: '2201.00001',
    citation_count: 120,
    publication: 'Rev. Mod. Phys. 94 (2022) 015004',
    publication_type: ['review'],
  },
  {
    recid: '1234569',
    title: 'Pentaquark States in QCD',
    authors: ['Author F'],
    year: '2021',
    arxiv_id: '2101.00002',
    citation_count: 30,
    publication: 'Phys. Lett. B 812 (2021) 136012',
  },
];

export const MOCK_LATEX_CONTENT = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
This paper discusses hadronic molecules.

\\section{Theory}
The binding energy is given by:
\\begin{equation}
E_B = -\\frac{\\hbar^2 \\kappa^2}{2\\mu}
\\end{equation}

\\section{Results}
We find that the $X(3872)$ is consistent with a $D\\bar{D}^*$ molecule.

\\section{Conclusions}
Hadronic molecules provide a natural explanation for exotic states.
\\end{document}`;

export const MOCK_CLAIMS = [
  {
    claim_text: 'The X(3872) is a hadronic molecule',
    evidence_type: 'theoretical',
    confidence: 0.85,
    source_recid: '1234567',
  },
  {
    claim_text: 'The binding energy is approximately 0.1 MeV',
    evidence_type: 'experimental',
    confidence: 0.9,
    source_recid: '1234568',
  },
];
