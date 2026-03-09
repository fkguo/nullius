# literature_queries.md

Purpose: append-only log of literature/code searches and selection decisions.

Scope policy:
- Preferred stable anchors for final citations: INSPIRE-HEP (inspirehep.net), arXiv (arxiv.org + export.arxiv.org), DOI (doi.org), GitHub (github.com).
- Allowed metadata helpers: Crossref (api.crossref.org) for DOI discovery and DOI→BibTeX.
- General scholarly search may be used for discovery, but it must be logged here and the final citation should land on stable anchors (INSPIRE/arXiv/DOI/GitHub/Zenodo/etc.).

Logging policy:
- Keep this file append-only (do not rewrite history; add corrections as new rows).
- Record query strings, filters/criteria, shortlist, what you accepted/rejected and why.
- For any accepted item, create/update a local KB note and link it in the “Local KB notes” column.
- Links must be clickable. Do NOT wrap Markdown links or citations like [@recid-...](#ref-recid-...) in backticks.

## Log

| Timestamp (UTC) | Source | Query | Filters / criteria | Shortlist (links) | Decision / notes | Local KB notes |
|---|---|---|---|---|---|---|
| 2026-02-01T16:59:05Z | arXiv | id:2210.03629 | direct id input | https://arxiv.org/abs/2210.03629 | ingested (auto); arXiv Atom metadata | [arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md) |
| 2026-02-01T22:31:44Z | arXiv | id:2210.03629 | direct id input | https://arxiv.org/abs/2210.03629 | ingested (auto); arXiv Atom metadata | [arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md) |
| 2026-02-01T22:46:11Z | arXiv | id:2210.03629 | direct id input | https://arxiv.org/abs/2210.03629 | ingested (auto); arXiv Atom metadata | [arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md) |
| 2026-02-01T22:49:05Z | arXiv | id:2210.03629 | direct id input | https://arxiv.org/abs/2210.03629 | ingested (auto); arXiv Atom metadata | [arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md) |
| 2026-02-02T03:04:34Z | arXiv | id:2005.11401 | direct id input | https://arxiv.org/abs/2005.11401 | ingested (auto); arXiv Atom metadata | [arxiv-2005.11401-rag](../literature/arxiv-2005.11401-rag.md) |
| 2026-02-02T03:04:37Z | arXiv | id:2303.11366 | direct id input | https://arxiv.org/abs/2303.11366 | ingested (auto); arXiv Atom metadata | [arxiv-2303.11366-reflexion](../literature/arxiv-2303.11366-reflexion.md) |
| 2026-02-02T03:04:40Z | arXiv | id:2305.10601 | direct id input | https://arxiv.org/abs/2305.10601 | ingested (auto); arXiv Atom metadata | [arxiv-2305.10601-tree-of-thoughts](../literature/arxiv-2305.10601-tree-of-thoughts.md) |
| 2026-02-02T03:04:43Z | arXiv | id:2308.03688 | direct id input | https://arxiv.org/abs/2308.03688 | ingested (auto); arXiv Atom metadata | [arxiv-2308.03688-agentbench](../literature/arxiv-2308.03688-agentbench.md) |
| 2026-02-02T03:04:46Z | arXiv | id:2308.08155 | direct id input | https://arxiv.org/abs/2308.08155 | ingested (auto); arXiv Atom metadata | [arxiv-2308.08155-autogen](../literature/arxiv-2308.08155-autogen.md) |
| 2026-02-02T03:04:49Z | arXiv | id:2310.06770 | direct id input | https://arxiv.org/abs/2310.06770 | ingested (auto); arXiv Atom metadata | [arxiv-2310.06770-swe-bench](../literature/arxiv-2310.06770-swe-bench.md) |
| 2026-02-02T03:04:52Z | arXiv | id:2412.14470 | direct id input | https://arxiv.org/abs/2412.14470 | ingested (auto); arXiv Atom metadata | [arxiv-2412.14470-agent-safetybench](../literature/arxiv-2412.14470-agent-safetybench.md) |
| 2026-02-02T03:04:55Z | arXiv | id:2503.16416 | direct id input | https://arxiv.org/abs/2503.16416 | ingested (auto); arXiv Atom metadata | [arxiv-2503.16416-agent-eval-survey](../literature/arxiv-2503.16416-agent-eval-survey.md) |
| 2026-02-02T16:45:28Z | INSPIRE | eprint:2512.15867 | direct id input | https://inspirehep.net/literature/3093880 | ingested (auto); resolved via INSPIRE by eprint; package-local note retired in 2026-03 cleanup | retired from package seed KB |
| 2026-02-02T16:45:35Z | INSPIRE | eprint:2512.07785 | direct id input | https://inspirehep.net/literature/3090360 | ingested (auto); resolved via INSPIRE by eprint; package-local note retired in 2026-03 cleanup | retired from package seed KB |
| 2026-02-02T16:45:39Z | arXiv | id:2210.03629 | direct id input | https://arxiv.org/abs/2210.03629 | ingested (auto); arXiv Atom metadata | [arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md) |
| 2026-02-02T16:45:47Z | arXiv | id:2308.08155 | direct id input | https://arxiv.org/abs/2308.08155 | ingested (auto); arXiv Atom metadata | [arxiv-2308.08155-autogen](../literature/arxiv-2308.08155-autogen.md) |
| 2026-02-02T16:45:50Z | arXiv | id:2303.11366 | direct id input | https://arxiv.org/abs/2303.11366 | ingested (auto); arXiv Atom metadata | [arxiv-2303.11366-reflexion](../literature/arxiv-2303.11366-reflexion.md) |
| 2026-02-02T16:45:55Z | arXiv | id:2405.15793 | direct id input | https://arxiv.org/abs/2405.15793 | ingested (auto); arXiv Atom metadata | [arxiv-2405.15793-swe-agent](../literature/arxiv-2405.15793-swe-agent.md) |
| 2026-02-02T16:46:56Z | arXiv | id:2303.11366 | direct id input | https://arxiv.org/abs/2303.11366 | ingested (auto); arXiv Atom metadata | [arxiv-2303.11366-reflexion](../literature/arxiv-2303.11366-reflexion.md) |
| 2026-02-03T06:56:01Z | arXiv | arxiv:2509.08535 |  | [arXiv](https://arxiv.org/abs/2509.08535) | Accepted historically; package-local note retired in 2026-03 cleanup to keep the seed KB generic and minimal | retired from package seed KB |
| 2026-02-03T06:56:01Z | arXiv | arxiv:2510.02426 |  | [arXiv](https://arxiv.org/abs/2510.02426) | Accepted historically; package-local note retired in 2026-03 cleanup to keep the seed KB generic and minimal | retired from package seed KB |
