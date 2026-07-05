"""Tests for gaia_package_scaffold.py that need no Gaia installation."""

from __future__ import annotations

import pytest

import gaia_package_scaffold as scaffold

SUB_CRITERIA = (
    "tension_resolution",
    "downstream_reach",
    "mechanism_insight",
    "testability_timing",
    "verification_cost",
)

# Wording that must never appear in tool-repository templates: neither
# project-specific physics vocabulary nor process jargon.
FORBIDDEN_TEMPLATE_WORDS = (
    "quark",
    "hadron",
    "lattice",
    "Hamiltonian",
    "oracle",
    "rubric",
    "ceremony",
    "fail-closed",
    "provenance",
)


def test_template_declares_worth_and_all_sub_criteria() -> None:
    text = scaffold.render_template("example-idea")
    assert 'title="worth"' in text
    assert "worth = claim(" in text
    for name in SUB_CRITERIA:
        assert f"{name} = claim(" in text, name
        assert f'title="{name}"' in text, name


def test_template_restates_the_three_likelihood_grades() -> None:
    text = scaffold.render_template("example-idea")
    assert "p_e_given_h=0.75, p_e_given_not_h=0.25" in text
    assert "p_e_given_h=0.90, p_e_given_not_h=0.09" in text
    assert "p_e_given_h=0.90, p_e_given_not_h=0.03" in text


def test_template_carries_anchor_and_exclusivity_guidance() -> None:
    text = scaffold.render_template("example-idea")
    assert "anchor:" in text
    assert "pairwise" in text
    assert "exclusive()" in text
    assert "0.5.0a4" in text  # the pin is restated in authored guidance


def test_template_is_domain_neutral_and_jargon_free() -> None:
    text = scaffold.render_template("example-idea").lower()
    for word in FORBIDDEN_TEMPLATE_WORDS:
        assert word.lower() not in text, word


def test_template_interpolates_slug() -> None:
    text = scaffold.render_template("my-special-slug")
    assert "my-special-slug" in text


def test_find_module_dir_single_module(tmp_path) -> None:
    module = tmp_path / "src" / "example_idea"
    module.mkdir(parents=True)
    (module / "__init__.py").write_text("", encoding="utf-8")
    assert scaffold.find_module_dir(tmp_path) == module


def test_find_module_dir_rejects_zero_and_many(tmp_path) -> None:
    (tmp_path / "src").mkdir()
    with pytest.raises(RuntimeError, match="refusing to guess"):
        scaffold.find_module_dir(tmp_path)
    for name in ("mod_a", "mod_b"):
        module = tmp_path / "src" / name
        module.mkdir()
        (module / "__init__.py").write_text("", encoding="utf-8")
    with pytest.raises(RuntimeError, match="refusing to guess"):
        scaffold.find_module_dir(tmp_path)


def test_find_module_dir_requires_src(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        scaffold.find_module_dir(tmp_path)


def test_missing_gaia_binary_prints_pin_install_hint(tmp_path, capsys) -> None:
    with pytest.raises(SystemExit) as excinfo:
        scaffold.main(
            [
                "--slug", "example-idea",
                "--dest", str(tmp_path),
                "--gaia-bin", str(tmp_path / "no-such-gaia"),
            ]
        )
    assert excinfo.value.code == 2
    err = capsys.readouterr().err
    assert "gaia-lang==0.5.0a4" in err
