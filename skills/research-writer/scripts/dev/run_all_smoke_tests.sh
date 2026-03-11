#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

if command -v rg >/dev/null 2>&1; then
  grep_re() { rg -n "$1" "$2" >/dev/null; }
else
  grep_re() { grep -nE "$1" "$2" >/dev/null; }
fi

run_card="${tmp_root}/run_card.json"
cat >"${run_card}" <<'JSON'
{"run_id":"SMOKE-1","workflow_id":"draft","backend":{"name":"research-writer"}}
JSON

echo "[smoke] help: scaffold CLI"
bash scripts/bin/research_writer_scaffold.sh --help >/dev/null

echo "[smoke] help: draft_sections CLI"
bash scripts/bin/research_writer_draft_sections.sh --help >/dev/null

echo "[smoke] help: consume paper manifest CLI"
bash scripts/bin/research_writer_consume_paper_manifest.sh --help >/dev/null

echo "[smoke] help: bibtex fixer"
python3 scripts/bin/fix_bibtex_revtex4_2.py --help >/dev/null

echo "[smoke] help: double-backslash fixer"
python3 scripts/bin/fix_md_double_backslash_math.py --help >/dev/null

echo "[smoke] help: PRL style corpus fetcher"
python3 scripts/bin/fetch_prl_style_corpus.py --help >/dev/null
echo "[smoke] help: discussion-logic pack generator"
python3 scripts/bin/research_writer_learn_discussion_logic.py --help >/dev/null
echo "[smoke] help: discussion-logic distiller"
python3 scripts/bin/distill_discussion_logic.py --help >/dev/null
echo "[smoke] help: LaTeX evidence-gate checker"
python3 scripts/bin/check_latex_evidence_gate.py --help >/dev/null
echo "[smoke] PRL style corpus fetcher: offline dry-run (no network)"
python3 scripts/bin/fetch_prl_style_corpus.py --query "dummy" --max-records 0 --out-dir "${tmp_root}/prl_style_corpus" --dry-run >/dev/null
echo "[smoke] PRL style corpus fetcher: offline extract (fixture)"
tar_path="${tmp_root}/arxiv_fixture.tar"
TAR_PATH="${tar_path}" python3 - <<'PY'
import io
import os
import tarfile
from pathlib import Path

tar_path = Path(os.environ["TAR_PATH"])

def add_bytes(tf: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    tf.addfile(info, io.BytesIO(data))

with tarfile.open(tar_path, mode="w") as tf:
    add_bytes(
        tf,
        "main.tex",
        b"\\\\documentclass{article}\\n"
        b"\\\\begin{document}\\n"
        b"\\\\begin{abstract}\\n"
        b"This is a demo abstract with an uncertainty discussion.\\\\n\\n"
        b"\\\\end{abstract}\\n\\n"
        b"\\\\emph{Introduction}---We motivate the problem and state the gap. We compare to prior work \\\\cite{K}.\\n\\n"
        b"We vary a matching scale to diagnose robustness.\\n\\n"
        b"\\\\input{sec}\\n\\n"
        b"\\\\emph{Conclusions}---Bottom line: the shift is driven by several small improvements and the dominant uncertainty remains.\\n"
        b"\\\\end{document}\\n",
    )
    add_bytes(tf, "sec.tex", b"Diagnostics: the result is stable under parameter variation; systematics dominate.\\n")
    add_bytes(tf, "references.bib", b"@article{K, title={T}, year={2024}, journal=\"\"}\\n")
    add_bytes(tf, "../evil.tex", b"should_not_extract\\n")
    add_bytes(tf, "figure.png", b"\\x89PNG\\r\\n\\x1a\\n")
PY

corpus_out="${tmp_root}/prl_style_corpus_fixture"
python3 scripts/bin/fetch_prl_style_corpus.py \
  --inspire-json "scripts/dev/fixtures/inspire_fixture.json" \
  --arxiv-tar "${tar_path}" \
  --max-records 2 \
  --out-dir "${corpus_out}" >/dev/null
test -f "${corpus_out}/meta.json"
test -f "${corpus_out}/trace.jsonl"
test -f "${corpus_out}/papers/1234.56789/record.json"
test -f "${corpus_out}/papers/1234.56789/main.tex"
test -f "${corpus_out}/papers/1234.56789/references.bib"
test -f "${corpus_out}/papers/2345.67890/record.json"
test -f "${corpus_out}/papers/2345.67890/main.tex"
test -f "${corpus_out}/papers/2345.67890/references.bib"
if find "${corpus_out}" -name "evil.tex" | grep -q .; then
  echo "ERROR: expected unsafe tar member to be rejected (evil.tex found)" >&2
  exit 1
fi
grep_re '\"event\": \"inspire_fixture_loaded\"' "${corpus_out}/trace.jsonl"
grep_re '\"event\": \"arxiv_download_fixture\"' "${corpus_out}/trace.jsonl"
grep_re '\"event\": \"arxiv_extract_done\"' "${corpus_out}/trace.jsonl"
grep_re '\"unsafe_rejected\": 1' "${corpus_out}/trace.jsonl"
grep_re '\"skipped_ext\": 1' "${corpus_out}/trace.jsonl"

echo "[smoke] PRL style corpus fetcher: offline extract (gzip single-file fixture)"
gz_path="${tmp_root}/arxiv_fixture.gz"
GZ_PATH="${gz_path}" python3 - <<'PY'
import gzip
import os
from pathlib import Path

gz_path = Path(os.environ["GZ_PATH"])
payload = (
    "\\\\documentclass{article}\\n"
    "\\\\begin{document}\\n"
    "Single-file gzip fixture.\\n"
    "\\\\end{document}\\n"
).encode("utf-8")
with gzip.GzipFile(filename="single.tex", mode="wb", fileobj=gz_path.open("wb")) as f:
    f.write(payload)
PY

corpus_out_gz="${tmp_root}/prl_style_corpus_fixture_gz"
python3 scripts/bin/fetch_prl_style_corpus.py \
  --inspire-json "scripts/dev/fixtures/inspire_fixture.json" \
  --arxiv-tar "${gz_path}" \
  --max-records 1 \
  --out-dir "${corpus_out_gz}" >/dev/null
test -f "${corpus_out_gz}/papers/1234.56789/record.json"
if ! find "${corpus_out_gz}/papers/1234.56789" -maxdepth 1 -name "*.tex" | grep -q .; then
  echo "ERROR: expected .tex extracted from gzip single-file fixture" >&2
  exit 1
fi

echo "[smoke] discussion-logic packs: offline (fixture corpus)"
logic_out="${tmp_root}/discussion_logic"
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir "${corpus_out}" \
  --out-dir "${logic_out}" \
  --n 1 \
  --mask-math \
  --mask-cites >/dev/null
test -f "${logic_out}/meta.json"
test -f "${logic_out}/trace.jsonl"
test -f "${logic_out}/PROGRESS.md"
test -f "${logic_out}/packs/1234.56789/pack.md"
test -f "${logic_out}/packs/1234.56789/flattened_main.tex"
test -f "${logic_out}/packs/1234.56789/evidence.json"
grep_re '^# Paper pack: 1234.56789' "${logic_out}/packs/1234.56789/pack.md"
grep_re 'BEGIN INPUT: sec\.tex' "${logic_out}/packs/1234.56789/flattened_main.tex"
grep_re '"selection_kind": "discussion_logic_diagnostics"' "${logic_out}/packs/1234.56789/evidence.json"

echo "[smoke] discussion-logic packs: resume selects next paper"
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir "${corpus_out}" \
  --out-dir "${logic_out}" \
  --mode new \
  --n 1 \
  --resume \
  --mask-math \
  --mask-cites >/dev/null
test -f "${logic_out}/packs/2345.67890/pack.md"
test -f "${logic_out}/packs/2345.67890/flattened_main.tex"
echo "[smoke] PASS: resume created next pack"

echo "[smoke] discussion-logic packs: repair mode (stub models, offline)"
logic_models_out="${tmp_root}/discussion_logic_models"
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir "${corpus_out}" \
  --out-dir "${logic_models_out}" \
  --mode new \
  --n 1 \
  --mask-math \
  --mask-cites \
  --run-models \
  --stub-models >/dev/null
test -f "${logic_models_out}/packs/1234.56789/claude.md"
test -f "${logic_models_out}/packs/1234.56789/gemini.md"
rm -f "${logic_models_out}/packs/1234.56789/gemini.md"
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir "${corpus_out}" \
  --out-dir "${logic_models_out}" \
  --mode repair \
  --n 1 \
  --resume \
  --run-models \
  --stub-models >/dev/null
test -f "${logic_models_out}/packs/1234.56789/gemini.md"
echo "[smoke] PASS: repair regenerated missing model output"

echo "[smoke] discussion-logic distill: offline (2-paper stub corpus)"
logic_models_out2="${tmp_root}/discussion_logic_models_2"
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir "${corpus_out}" \
  --out-dir "${logic_models_out2}" \
  --mode new \
  --n 2 \
  --mask-math \
  --mask-cites \
  --run-models \
  --stub-models >/dev/null
python3 scripts/bin/distill_discussion_logic.py --out-dir "${logic_models_out2}" --top 20 --examples 10 >/dev/null
test -f "${logic_models_out2}/distill/CONSENSUS.md"
test -f "${logic_models_out2}/distill/DISAGREEMENTS.md"
test -f "${logic_models_out2}/distill/STATS.json"
cp "${logic_models_out2}/distill/CONSENSUS.md" "${logic_models_out2}/distill/CONSENSUS.md.before"
cp "${logic_models_out2}/distill/DISAGREEMENTS.md" "${logic_models_out2}/distill/DISAGREEMENTS.md.before"
cp "${logic_models_out2}/distill/STATS.json" "${logic_models_out2}/distill/STATS.json.before"
# Idempotency: re-run and ensure outputs are identical (deterministic mode).
python3 scripts/bin/distill_discussion_logic.py --out-dir "${logic_models_out2}" --top 20 --examples 10 >/dev/null
/usr/bin/diff -q "${logic_models_out2}/distill/CONSENSUS.md.before" "${logic_models_out2}/distill/CONSENSUS.md" >/dev/null
/usr/bin/diff -q "${logic_models_out2}/distill/DISAGREEMENTS.md.before" "${logic_models_out2}/distill/DISAGREEMENTS.md" >/dev/null
/usr/bin/diff -q "${logic_models_out2}/distill/STATS.json.before" "${logic_models_out2}/distill/STATS.json" >/dev/null
grep_re '^# Distilled discussion-logic patterns' "${logic_models_out2}/distill/CONSENSUS.md"
grep_re '^# Distilled discussion-logic patterns' "${logic_models_out2}/distill/DISAGREEMENTS.md"
grep_re '\"total_packs\": 2' "${logic_models_out2}/distill/STATS.json"
grep_re 'question_observable' "${logic_models_out2}/distill/CONSENSUS.md"

echo "[smoke] LaTeX evidence-gate checker: flags risky unanchored revadd"
eg_dir="${tmp_root}/evidence_gate"
mkdir -p "${eg_dir}"
bad_tex="${eg_dir}/bad.tex"
good_tex="${eg_dir}/good.tex"
cat >"${bad_tex}" <<'EOF'
\\documentclass{article}
\\begin{document}
\\revadd{The data are taken from NNOline and we assign a uniform uncertainty of 1\\%.}
\\end{document}
EOF
cat >"${good_tex}" <<'EOF'
\\documentclass{article}
\\begin{document}
\\revadd{The data are taken from NNOline (Table~I of Ref.~\\cite{Stoks:1993tb}) and we assign a uniform uncertainty of 1\\%.}
\\end{document}
EOF
if python3 scripts/bin/check_latex_evidence_gate.py --tex "${bad_tex}" --fail >/dev/null 2>&1; then
  echo "ERROR: expected evidence-gate checker to fail on unanchored risky revadd" >&2
  exit 1
fi
python3 scripts/bin/check_latex_evidence_gate.py --tex "${good_tex}" --fail >/dev/null

echo "[smoke] LaTeX evidence-gate checker: scan-all flags risky plain text"
plain_bad_tex="${eg_dir}/plain_bad.tex"
plain_good_tex="${eg_dir}/plain_good.tex"
cat >"${plain_bad_tex}" <<'EOF'
\\documentclass{article}
\\begin{document}
The data are taken from NNOline and we assign a uniform uncertainty of 1\\%.
\\end{document}
EOF
cat >"${plain_good_tex}" <<'EOF'
\\documentclass{article}
\\begin{document}
The data are taken from NNOline (source: `artifacts/manifest.json`) and we assign a uniform uncertainty of 1\\%.
\\end{document}
EOF
if python3 scripts/bin/check_latex_evidence_gate.py --tex "${plain_bad_tex}" --scan-all --fail >/dev/null 2>&1; then
  echo "ERROR: expected --scan-all evidence gate to fail on unanchored risky text" >&2
  exit 1
fi
python3 scripts/bin/check_latex_evidence_gate.py --tex "${plain_good_tex}" --scan-all --fail >/dev/null

echo "[smoke] scaffold: fixture project -> paper/"
proj="${tmp_root}/project"
out="${tmp_root}/paper"
cp -R "scripts/dev/fixtures/minimal_project" "${proj}"

python3 "${proj}/scripts/make_artifacts.py" --tag M2-smoke >/dev/null

bash scripts/bin/research_writer_scaffold.sh --project-root "${proj}" --tag M2-smoke --out "${out}"
test -f "${out}/main.tex"
test -f "${out}/references.bib"
test -f "${out}/latexmkrc"
test -f "${out}/README.md"
test -f "${out}/run.json"
test -f "${out}/export_manifest.json"
test -d "${out}/figures"
grep_re '^[[:space:]]*journal[[:space:]]*=[[:space:]]*\"\"' "${out}/references.bib"

echo "[smoke] scaffold: fixture project -> paper/ (with run-card)"
out_rc="${tmp_root}/paper_run_card"
bash scripts/bin/research_writer_scaffold.sh --project-root "${proj}" --tag M2-smoke --out "${out_rc}" --run-card "${run_card}"
test -f "${out_rc}/main.tex"
test -f "${out_rc}/run.json"
test -f "${out_rc}/export_manifest.json"
test -f "${out_rc}/run_card.json"
grep_re 'SMOKE-1' "${out_rc}/run.json"

echo "[smoke] consume paper manifest: ok fixture (default manifest path)"
pm_ok="${tmp_root}/paper_manifest_ok"
cp -R "scripts/dev/fixtures/paper_manifest/ok_root" "${pm_ok}"
(cd "${pm_ok}" && bash "${ROOT_DIR}/scripts/bin/research_writer_consume_paper_manifest.sh" --compile --run-card "${run_card}" >/dev/null)
test -f "${pm_ok}/paper/build_trace.jsonl"
test -f "${pm_ok}/paper/export_manifest.json"
test -f "${pm_ok}/paper/run_card.json"
test -f "${pm_ok}/paper/references_manual.bib"  # created if missing
grep_re '\\bibliography\{references_generated,references_manual\}' "${pm_ok}/paper/main.tex"
grep_re '\"event\": \"validate_ok\"' "${pm_ok}/paper/build_trace.jsonl"
grep_re 'SMOKE-1' "${pm_ok}/paper/build_trace.jsonl"
if command -v latexmk >/dev/null 2>&1; then
  test -f "${pm_ok}/paper/main.pdf"
else
  grep_re '\"event\": \"compile_skipped\"' "${pm_ok}/paper/build_trace.jsonl"
fi

echo "[smoke] consume paper manifest: versioned fixture (paper/v2 preferred)"
pm_ver="${tmp_root}/paper_manifest_versioned"
cp -R "scripts/dev/fixtures/paper_manifest/versioned_root" "${pm_ver}"
(cd "${pm_ver}" && bash "${ROOT_DIR}/scripts/bin/research_writer_consume_paper_manifest.sh" --run-card "${run_card}" >/dev/null)
test -f "${pm_ver}/paper/v2/build_trace.jsonl"
test -f "${pm_ver}/paper/v2/export_manifest.json"
test -f "${pm_ver}/paper/v2/run_card.json"
grep_re '\"manifest\": ".*paper/v2/paper_manifest.json\"' "${pm_ver}/paper/v2/build_trace.jsonl"
grep_re '\"schemaVersion\": 2' "${pm_ver}/paper/v2/export_manifest.json"
grep_re 'Fixture paper v2' "${pm_ver}/paper/v2/main.tex"

echo "[smoke] consume paper manifest: dual-manifest fixture prefers highest v*"
pm_dual="${tmp_root}/paper_manifest_dual"
cp -R "scripts/dev/fixtures/paper_manifest/dual_manifest_root" "${pm_dual}"
(cd "${pm_dual}" && bash "${ROOT_DIR}/scripts/bin/research_writer_consume_paper_manifest.sh" --run-card "${run_card}" >/dev/null)
test -f "${pm_dual}/paper/v2/build_trace.jsonl"
test -f "${pm_dual}/paper/v2/export_manifest.json"
grep_re '\"manifest\": ".*paper/v2/paper_manifest.json\"' "${pm_dual}/paper/v2/build_trace.jsonl"
grep_re '\"schemaVersion\": 2' "${pm_dual}/paper/v2/export_manifest.json"
if [[ -e "${pm_dual}/paper/export_manifest.json" ]]; then
  echo "ERROR: expected dual-manifest run to consume paper/v2, not paper/ root" >&2
  exit 1
fi

echo "[smoke] consume paper manifest: FAIL on hep:// in .tex"
pm_hep="${tmp_root}/paper_manifest_bad_hep"
cp -R "scripts/dev/fixtures/paper_manifest/bad_hep_uri_root" "${pm_hep}"
set +e
(cd "${pm_hep}" && bash "${ROOT_DIR}/scripts/bin/research_writer_consume_paper_manifest.sh" >/dev/null 2>&1)
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "ERROR: expected consume_paper_manifest to fail on hep:// in .tex" >&2
  exit 1
fi
test -f "${pm_hep}/paper/build_trace.jsonl"
grep_re 'hep://' "${pm_hep}/paper/build_trace.jsonl"

echo "[smoke] consume paper manifest: FAIL on citekey conflicts"
pm_conf="${tmp_root}/paper_manifest_bad_conflict"
cp -R "scripts/dev/fixtures/paper_manifest/bad_citekey_conflict_root" "${pm_conf}"
set +e
(cd "${pm_conf}" && bash "${ROOT_DIR}/scripts/bin/research_writer_consume_paper_manifest.sh" >/dev/null 2>&1)
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "ERROR: expected consume_paper_manifest to fail on citekey conflicts" >&2
  exit 1
fi
test -f "${pm_conf}/paper/build_trace.jsonl"
grep_re 'citekey conflict' "${pm_conf}/paper/build_trace.jsonl"

echo "[smoke] draft_sections: stub safe -> drafts/"
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root "${proj}" \
  --paper-dir "${out}" \
  --tag M2-smoke \
  --run-id smoke-safe \
  --section introduction \
  --run-card "${run_card}" \
  --stub-models \
  --stub-variant safe >/dev/null
test -f "${out}/drafts/smoke-safe/README.md"
test -f "${out}/drafts/smoke-safe/export_manifest.json"
test -f "${out}/drafts/smoke-safe/run_card.json"
test -f "${out}/drafts/smoke-safe/draft_introduction_writer.tex"
test -f "${out}/drafts/smoke-safe/draft_introduction_final.tex"
test -f "${out}/drafts/smoke-safe/draft_introduction.diff"
test -f "${out}/drafts/smoke-safe/trace.jsonl"

echo "[smoke] draft_sections: stub unsafe -> evidence gate fails and renames output"
set +e
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root "${proj}" \
  --paper-dir "${out}" \
  --tag M2-smoke \
  --run-id smoke-unsafe \
  --section introduction \
  --stub-models \
  --stub-variant unsafe >/dev/null 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "ERROR: expected draft_sections unsafe stub to fail evidence gate" >&2
  exit 1
fi
test -f "${out}/drafts/smoke-unsafe/evidence_gate_report_introduction.md"
test -f "${out}/drafts/smoke-unsafe/draft_introduction_unsafe.tex"

echo "[smoke] markdown double-backslash check: generated paper + skill assets"
bash scripts/bin/check_md_double_backslash.sh --root "${out}" --fail >/dev/null
bash scripts/bin/check_md_double_backslash.sh --root "assets" --fail >/dev/null

if command -v latexmk >/dev/null 2>&1; then
  echo "[smoke] latexmk: compile paper"
  latexmk_log="${tmp_root}/latexmk.log"
  if ! (cd "${out}" && latexmk -pdf main.tex >"${latexmk_log}" 2>&1); then
    echo "[smoke] FAIL: latexmk failed; log follows:" >&2
    cat "${latexmk_log}" >&2
    exit 1
  fi
  test -f "${out}/main.pdf"
  echo "[smoke] PASS: main.pdf generated"
  warn_count="$(grep -c 'LaTeX Warning' "${out}/main.log" 2>/dev/null || true)"
  overfull_count="$(grep -c 'Overfull \\\\hbox' "${out}/main.log" 2>/dev/null || true)"
  warn_count="${warn_count:-0}"
  overfull_count="${overfull_count:-0}"
  echo "[smoke] latexmk: warnings=${warn_count} overfull_hbox=${overfull_count}"
else
  echo "[smoke] SKIPPED: latexmk not found"
fi

echo "[smoke] bibtex fixer: adds journal field"
bib="${tmp_root}/references.bib"
cat >"${bib}" <<'EOF'
@article{Key1,
  title = {Test entry},
  year = {2020}
}
EOF
set +e
python3 scripts/bin/fix_bibtex_revtex4_2.py --bib "${bib}" >/dev/null 2>&1
code=$?
set -e
if [[ $code -ne 1 ]]; then
  echo "ERROR: expected exit 1 (fixes needed) for bibtex fixer; got ${code}" >&2
  exit 1
fi
python3 scripts/bin/fix_bibtex_revtex4_2.py --bib "${bib}" --in-place >/dev/null
grep_re '^[[:space:]]*journal[[:space:]]*=[[:space:]]*\"\"' "${bib}"

echo "[smoke] double-backslash checker+fixer: markdown math only"
md_dir="${tmp_root}/md"
mkdir -p "${md_dir}"
cat >"${md_dir}/t.md" <<'EOF'
Inline math: $\\Delta = 1$, $k^\\* = 0$.
Code span (must not change): `\\Delta`
$$
\\gamma_{\\rm lin} = 2
$$
EOF
set +e
bash scripts/bin/check_md_double_backslash.sh --root "${md_dir}" --fail >/dev/null 2>&1
code=$?
set -e
if [[ $code -ne 1 ]]; then
  echo "ERROR: expected exit 1 for --fail with bad escapes; got ${code}" >&2
  exit 1
fi
python3 scripts/bin/fix_md_double_backslash_math.py --root "${md_dir}" --in-place >/dev/null
bash scripts/bin/check_md_double_backslash.sh --root "${md_dir}" --fail >/dev/null
grep_re '\\\\Delta' "${md_dir}/t.md"  # should still exist in code spans (fixer must not touch inline code)

echo "[smoke] ok"
