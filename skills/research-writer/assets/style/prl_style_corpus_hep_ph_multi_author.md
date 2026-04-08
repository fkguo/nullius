# Physics discussion corpus: PRL hep-ph (Ji / Zhu / Yuan / Zhou / Pospelov; ≤10 authors)

Use this to collect **primary-source arXiv LaTeX** for close reading and for extracting **general physics discussion logic** (argument structure, diagnostics, uncertainty narration, “bottom line” framing). This is **not** about superficial PRL formatting.

For the distilled, reusable “how to discuss physics” guide, see:
- `assets/style/physics_discussion_logic_playbook.md`

## Source (INSPIRE query)

INSPIRE UI link (PRL; hep-ph; ≤10 authors; most recent):

`https://inspirehep.net/literature?sort=mostrecent&size=100&page=1&q=%28a%20Xiang.Dong.Ji.1%20or%20a%20H.X.Zhu.1%20or%20a%20Feng.Yuan.1%20or%20a%20Jian.Zhou.2%20or%20a%20M.Pospelov.1%29%20and%20j%20phys.rev.lett.&author_count=10%20authors%20or%20fewer&arxiv_categories=hep-ph`

## Download arXiv sources (best-effort; logged; gzip-safe)

```bash
python3 scripts/bin/fetch_prl_style_corpus.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=100&page=1&q=%28a%20Xiang.Dong.Ji.1%20or%20a%20H.X.Zhu.1%20or%20a%20Feng.Yuan.1%20or%20a%20Jian.Zhou.2%20or%20a%20M.Pospelov.1%29%20and%20j%20phys.rev.lett.&author_count=10%20authors%20or%20fewer&arxiv_categories=hep-ph" \
  --page-size 20 \
  --max-records 96 \
  --resume \
  --out-dir /tmp/prl_hep_ph_prl_corpus
```

Outputs:
- `/tmp/prl_hep_ph_prl_corpus/meta.json` — query + extraction configuration
- `/tmp/prl_hep_ph_prl_corpus/records_order.json` — INSPIRE order (ranked)
- `/tmp/prl_hep_ph_prl_corpus/trace.jsonl` — per-record success/failure log
- `/tmp/prl_hep_ph_prl_corpus/papers/<arxiv_id>/...` — extracted TeX/Bib/Sty sources (filtered by extension)

## Generate N=10 reading packs + dual-model maps (repeat in batches)

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir /tmp/prl_hep_ph_prl_corpus \
  --out-dir "<discussion_logic_out_dir>/prl_hep-ph_xdj_hxz_fy_jz_mpospelov" \
  --mode new \
  --n 10 \
  --resume \
  --mask-math \
  --mask-cites \
  --run-models
```

After each run, check:
- `PROGRESS.md` in the output directory (packs + dual-model completeness)

## Usage note (important)

This corpus is for learning **discussion logic and structure**, not for copying text. Do not paste paragraphs verbatim into new manuscripts.
