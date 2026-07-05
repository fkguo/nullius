"""Tests for the deterministic LaTeX cross-reference + citation integrity checker."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "bin" / "check_latex_xrefs.py"
_spec = importlib.util.spec_from_file_location("check_latex_xrefs", _MOD)
cx = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cx  # dataclasses on 3.12 needs the module registered
_spec.loader.exec_module(cx)


def _paper(tmp_path: Path, tex: str, *, bib: str | None = None) -> Path:
    paper = tmp_path / "paper"
    paper.mkdir(parents=True)
    (paper / "main.tex").write_text(tex, encoding="utf-8")
    if bib is not None:
        (paper / "refs.bib").write_text(bib, encoding="utf-8")
    return paper


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_MOD), *args],
        capture_output=True,
        text=True,
        check=False,
    )


_BIB = r"""
@article{Alpha2020,
  author = "A. Author",
  title  = "A title",
  journal = "J. Phys.",
  year = 2020,
}
@book{Beta2019, author = "B. Writer", title = "A book", year = 2019}
"""


_GREEN_TEX = r"""
\documentclass{revtex4-2}
\begin{document}
\section{Intro}\label{sec:intro}
As shown in Sec.~\ref{sec:intro} and Eq.~\eqref{eq:main}, see also
Refs.~\cite{Alpha2020,Beta2019}.
\begin{equation}\label{eq:main} E = mc^2 \end{equation}
\bibliography{refs}
\end{document}
"""


# --- green path -----------------------------------------------------------

def test_green_path_ok(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX, bib=_BIB)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert res.ok
    assert res.errors == []
    assert res.warnings == []
    assert res.n_labels == 2
    assert res.n_cites == 2
    assert res.cite_check_skipped is False


def test_green_path_cli_exit0(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX, bib=_BIB)
    res = _run_cli(["--root", str(paper)])
    assert res.returncode == 0, res.stdout + res.stderr
    assert "[latex-xrefs] ok" in res.stdout


# --- dangling reference (FAIL, exit 2) ------------------------------------

_DANGLING_TEX = r"""
\documentclass{revtex4-2}
\begin{document}
\section{Intro}\label{sec:intro}
See Sec.~\ref{sec:missing} for details.  % target never defined
\end{document}
"""


def test_dangling_ref_fails(tmp_path):
    paper = _paper(tmp_path, _DANGLING_TEX)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert not res.ok
    kinds = {f.kind for f in res.errors}
    assert "dangling_ref" in kinds
    dangling = [f for f in res.errors if f.kind == "dangling_ref"]
    assert dangling[0].key == "sec:missing"


def test_dangling_ref_cli_exit2(tmp_path):
    paper = _paper(tmp_path, _DANGLING_TEX)
    res = _run_cli(["--root", str(paper)])
    assert res.returncode == 2, res.stdout + res.stderr
    assert "dangling_ref" in res.stdout


# --- duplicate label (FAIL, exit 2) ---------------------------------------

_DUP_TEX = r"""
\documentclass{revtex4-2}
\begin{document}
\section{A}\label{sec:x}
\section{B}\label{sec:x}   % duplicate
See Sec.~\ref{sec:x}.
\end{document}
"""


def test_duplicate_label_fails(tmp_path):
    paper = _paper(tmp_path, _DUP_TEX)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert not res.ok
    dups = [f for f in res.errors if f.kind == "duplicate_label"]
    assert len(dups) == 1
    assert dups[0].key == "sec:x"


def test_duplicate_label_cli_exit2(tmp_path):
    paper = _paper(tmp_path, _DUP_TEX)
    res = _run_cli(["--root", str(paper)])
    assert res.returncode == 2, res.stdout + res.stderr
    assert "duplicate_label" in res.stdout


# --- unused label (WARN only, exit 0) -------------------------------------

_UNUSED_TEX = r"""
\documentclass{revtex4-2}
\begin{document}
\section{Intro}\label{sec:intro}
\section{Unref}\label{sec:orphan}   % defined, never referenced
See Sec.~\ref{sec:intro}.
\end{document}
"""


def test_unused_label_is_warning_only(tmp_path):
    paper = _paper(tmp_path, _UNUSED_TEX)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert res.ok  # warnings do not flip ok/exit code
    assert res.errors == []
    warns = [f for f in res.warnings if f.kind == "unused_label"]
    assert len(warns) == 1
    assert warns[0].key == "sec:orphan"
    assert warns[0].severity == "warning"


def test_unused_label_cli_exit0(tmp_path):
    paper = _paper(tmp_path, _UNUSED_TEX)
    res = _run_cli(["--root", str(paper)])
    assert res.returncode == 0, res.stdout + res.stderr
    assert "unused_label" in res.stdout
    assert "[latex-xrefs] ok" in res.stdout


# --- undefined citation (FAIL, exit 2) ------------------------------------

_UNDEF_CITE_TEX = r"""
\documentclass{revtex4-2}
\begin{document}
Cited works: \cite{Alpha2020} and \citep{Ghost1999}.  % Ghost1999 not in bib
\bibliography{refs}
\end{document}
"""


def test_undefined_citation_fails(tmp_path):
    paper = _paper(tmp_path, _UNDEF_CITE_TEX, bib=_BIB)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert not res.ok
    undef = [f for f in res.errors if f.kind == "undefined_citation"]
    assert len(undef) == 1
    assert undef[0].key == "Ghost1999"
    assert res.cite_check_skipped is False


def test_undefined_citation_cli_exit2(tmp_path):
    paper = _paper(tmp_path, _UNDEF_CITE_TEX, bib=_BIB)
    res = _run_cli(["--root", str(paper)])
    assert res.returncode == 2, res.stdout + res.stderr
    assert "undefined_citation" in res.stdout


def test_bibitem_keys_satisfy_citations(tmp_path):
    # thebibliography \bibitem provides bib keys even without a .bib file.
    tex = r"""
\documentclass{revtex4-2}
\begin{document}
See \cite{KnownKey}.
\begin{thebibliography}{9}
\bibitem{KnownKey} A. Author, Title (2020).
\end{thebibliography}
\end{document}
"""
    paper = _paper(tmp_path, tex)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert res.ok
    assert res.cite_check_skipped is False
    assert res.n_bib_keys == 1


def test_cite_check_skipped_when_no_bib_source(tmp_path):
    tex = r"""
\documentclass{revtex4-2}
\begin{document}
See \cite{SomeKey}.  % no \bibitem, no .bib -> check skipped, not failed
\end{document}
"""
    paper = _paper(tmp_path, tex)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert res.ok  # absence of bib source is a warning, not a failure
    assert res.cite_check_skipped is True


# --- comment stripping (odd-parity backslash rule) ------------------------

def test_commented_out_reference_is_ignored(tmp_path):
    tex = r"""
\documentclass{revtex4-2}
\begin{document}
\section{Intro}\label{sec:intro}
% \ref{sec:phantom} is commented out and must not count as a dangling ref
See Sec.~\ref{sec:intro}.
A literal percent \% here is not a comment.
\end{document}
"""
    paper = _paper(tmp_path, tex)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    assert res.ok
    assert not any(f.key == "sec:phantom" for f in res.findings)


# --- multi-target \cref ---------------------------------------------------

def test_cref_multi_target_split(tmp_path):
    tex = r"""
\documentclass{revtex4-2}
\begin{document}
\section{A}\label{sec:a}
\section{B}\label{sec:b}
See \cref{sec:a,sec:b,sec:c}.  % sec:c is dangling
\end{document}
"""
    paper = _paper(tmp_path, tex)
    res = cx.evaluate(tex_files=[paper / "main.tex"], bib_files=[])
    dangling = [f for f in res.errors if f.kind == "dangling_ref"]
    assert len(dangling) == 1
    assert dangling[0].key == "sec:c"


# --- JSON output ----------------------------------------------------------

def test_json_output_shape_and_exit(tmp_path):
    paper = _paper(tmp_path, _DANGLING_TEX)
    res = _run_cli(["--root", str(paper), "--json"])
    assert res.returncode == 2, res.stdout + res.stderr
    payload = json.loads(res.stdout)
    assert payload["ok"] is False
    assert payload["summary"]["n_errors"] >= 1
    assert any(f["kind"] == "dangling_ref" for f in payload["findings"])
