# Physics discussion corpus: PRL papers (Guo / Meißner / Hoferichter)

Use this to collect **primary-source LaTeX** for close reading and for extracting **general discussion logic** (argument structure, diagnostics, uncertainty narration, and “bottom line” framing) from exemplar papers. This is **not** about superficial PRL formatting.

For the distilled, reusable “how to discuss physics” guide, see:
- `assets/style/physics_discussion_logic_playbook.md`

## Source (INSPIRE query)

- INSPIRE UI link (most recent PRL papers):  
  `https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20f%20k%20guo%20or%20a%20u%20g%20meissner%20or%20a%20m%20hoferichter%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true`

## Download arXiv sources (best-effort; logged)

```bash
python3 scripts/bin/fetch_prl_style_corpus.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20f%20k%20guo%20or%20a%20u%20g%20meissner%20or%20a%20m%20hoferichter%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
  --max-records 50 \
  --resume \
  --out-dir /tmp/prl_style_corpus
```

Outputs:
- `/tmp/prl_style_corpus/meta.json` — query + extraction configuration
- `/tmp/prl_style_corpus/trace.jsonl` — per-record success/failure log (network/DNS robust)
- `/tmp/prl_style_corpus/papers/<arxiv_id>/...` — extracted TeX/Bib/Sty sources (filtered by extension)

## Next: generate N=10 reading packs (recommended)

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir /tmp/prl_style_corpus \
  --n 10 \
  --resume \
  --out-dir /tmp/research_writer_discussion_logic \
  --mask-math \
  --mask-cites
```

## Usage note (important)

This corpus is for learning **discussion logic and structure**, not for copying text. Do not paste paragraphs verbatim into new manuscripts.
