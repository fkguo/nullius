"""Tests for the deterministic RevTeX 4.2 BibTeX journal-field hygiene helper."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "bin" / "fix_bibtex_revtex4_2.py"
_spec = importlib.util.spec_from_file_location("fix_bibtex_revtex4_2", _MOD)
fx = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = fx  # dataclasses on 3.12 needs the module registered
_spec.loader.exec_module(fx)


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_MOD), *args],
        capture_output=True,
        text=True,
        check=False,
    )


# --- core transformation: the missing journal field is inserted ---

def test_article_without_journal_gets_empty_journal_inserted():
    src = "@article{Doe2020,\n  author = {Doe, J.},\n  title = {A Title},\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    # exactly one entry patched, by key
    assert [p.key for p in patches] == ["Doe2020"]
    # the inserted field is literally journal = "",
    assert 'journal = "",' in new
    # the original fields survive unchanged
    assert "author = {Doe, J.}" in new
    assert "title = {A Title}" in new
    # inserted immediately after the key comma, before the first real field
    assert new.index('journal = ""') < new.index("author = {Doe, J.}")


def test_article_with_journal_is_left_unchanged():
    src = '@article{Has2019,\n  author = {Roe, R.},\n  journal = {Phys. Rev. D},\n}\n'
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src


def test_non_article_entry_is_never_patched():
    # @book lacking a journal must NOT be touched: only @article is in scope.
    src = "@book{Knuth1984,\n  author = {Knuth, D.},\n  title = {TeX},\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src
    assert 'journal' not in new


def test_entry_type_is_case_insensitive():
    src = "@ARTICLE{Up2021,\n  author = {A, B},\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["Up2021"]
    assert 'journal = ""' in new


def test_single_article_with_real_journal_before_it_is_left_alone():
    # A first entry that already has journal is emitted unchanged; the
    # second-entry case is covered below.
    src = '@article{HasJ,\n  journal = {J. Phys.},\n  title = {T},\n}\n'
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src


def test_second_consecutive_article_missing_journal_should_also_be_patched():
    # Two @article entries, BOTH missing journal: both must be patched. Regression
    # for the _find_entry `at + m.end()` double-count that silently dropped every
    # entry after the first.
    src = (
        "@article{One,\n  title = {T1},\n}\n\n"
        "@article{Two,\n  title = {T2},\n}\n"
    )
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["One", "Two"]
    assert new.count('journal = ""') == 2


def test_article_after_preamble_should_be_patched():
    # A comment/blank preamble puts the sole @article at at>0 (ordinary INSPIRE .bib
    # shape). Regression for the same _find_entry double-count.
    src = "% INSPIRE-HEP bibliography export\n\n@article{Solo,\n  title = {T},\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["Solo"]
    assert 'journal = ""' in new


def test_published_article_that_is_not_first_is_left_unchanged():
    # A published @article WITH a real journal, but NOT the first entry (start>0),
    # must be recognised and left untouched. Regression for the body slice using the
    # ABSOLUTE body_start against the relative `entry`, which truncated the scanned
    # body of every non-first entry and inserted a DUPLICATE journal="".
    src = (
        '@article{First,\n  journal = "J1",\n}\n\n'
        '@article{Second,\n  journal = "Phys. Rev. D",\n  title = "T2",\n}\n'
    )
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src
    assert new.count("journal") == 2  # exactly the two originals, no inserted empty


def test_published_article_after_preamble_is_left_unchanged():
    # Same class of bug via a comment preamble: the sole published entry already has
    # a journal and must not receive a duplicate empty one.
    src = "% INSPIRE-HEP export\n\n@article{Pub,\n  journal = \"Nature\",\n  title = \"T\",\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src


def test_mixed_preprints_and_published_only_preprints_patched():
    # Realistic INSPIRE .bib: comment preamble, then a preprint (no journal), a
    # published entry (real journal), and another preprint. Only the two preprints
    # get journal="" and the published entry is untouched (no duplicate field).
    src = (
        "% INSPIRE-HEP bibliography export\n\n"
        '@article{PreA,\n  eprint = "2301.11111",\n  title = "A",\n}\n\n'
        '@article{Pub,\n  journal = "Phys. Rev. D",\n  title = "B",\n}\n\n'
        '@article{PreB,\n  eprint = "2404.22222",\n  title = "C",\n}\n'
    )
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["PreA", "PreB"]
    assert new.count('journal = ""') == 2
    # the published entry keeps exactly one journal field, no empty duplicate
    pub = new[new.index("@article{Pub,"):new.index("@article{PreB,")]
    assert pub.count("journal") == 1
    assert 'journal = "Phys. Rev. D"' in pub


def test_paren_delimited_article_is_supported():
    # BibTeX also allows @article(...) with parentheses as the outer delimiter.
    src = "@article(ParenKey,\n  title = {Paren},\n)\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["ParenKey"]
    assert 'journal = ""' in new
    # outer paren delimiter preserved
    assert new.rstrip().endswith(")")


def test_nested_braces_do_not_hide_top_level_journal():
    # A brace-nested 'journal' inside another field value must NOT count as a
    # top-level journal field, so the entry is still patched.
    src = "@article{Nest,\n  note = {see journal = {x} inside},\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["Nest"]
    assert 'journal = ""' in new


def test_journal_substring_in_other_key_is_not_a_journal_field():
    # A field named 'journaltitle' must not satisfy the top-level journal check.
    src = "@article{Sub,\n  journaltitle = {X},\n}\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert [p.key for p in patches] == ["Sub"]
    assert 'journal = ""' in new
    assert "journaltitle = {X}" in new


# --- edge / negative cases ---

def test_empty_input_produces_no_patches():
    new, patches = fx.normalize_revtex4_2_bibtex("")
    assert patches == []
    assert new == ""


def test_text_without_entries_is_untouched():
    src = "% just a comment, no @ entries here\nplain text line\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src


def test_stray_at_sign_not_a_valid_entry_is_preserved():
    # A lone '@' not starting a real entry must be preserved verbatim.
    src = "email a@b in prose\n"
    new, patches = fx.normalize_revtex4_2_bibtex(src)
    assert patches == []
    assert new == src


# --- CLI contract: exit codes 0/1/2 ---

def test_cli_missing_file_exits_2(tmp_path):
    r = _run_cli(["--bib", str(tmp_path / "nope.bib")])
    assert r.returncode == 2
    assert "not found" in (r.stdout + r.stderr)


def test_cli_reports_needed_fix_without_in_place_exit_1(tmp_path):
    bib = tmp_path / "refs.bib"
    bib.write_text("@article{NeedsFix,\n  title = {T},\n}\n", encoding="utf-8")
    r = _run_cli(["--bib", str(bib)])
    assert r.returncode == 1
    assert "NeedsFix" in r.stdout
    # dry run: file must NOT be modified
    assert 'journal = ""' not in bib.read_text(encoding="utf-8")


def test_cli_in_place_applies_and_exits_0(tmp_path):
    bib = tmp_path / "refs.bib"
    bib.write_text("@article{NeedsFix,\n  title = {T},\n}\n", encoding="utf-8")
    r = _run_cli(["--bib", str(bib), "--in-place"])
    assert r.returncode == 0, r.stdout + r.stderr
    text = bib.read_text(encoding="utf-8")
    assert 'journal = ""' in text
    # idempotent: a second in-place pass finds nothing to do and still exits 0
    r2 = _run_cli(["--bib", str(bib), "--in-place"])
    assert r2.returncode == 0
    assert bib.read_text(encoding="utf-8") == text  # byte-identical, no double insert


def test_cli_clean_bib_exits_0(tmp_path):
    bib = tmp_path / "clean.bib"
    bib.write_text('@article{Ok,\n  journal = {Nature},\n}\n', encoding="utf-8")
    r = _run_cli(["--bib", str(bib)])
    assert r.returncode == 0
    assert "no missing journal" in r.stdout
