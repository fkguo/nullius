"""Tests for gaia_package_scaffold.py that need no Gaia installation."""

from __future__ import annotations

from pathlib import Path

import pytest

import gaia_package_scaffold as scaffold

SKILL_ROOT = Path(__file__).resolve().parent.parent

SUB_CRITERIA = (
    "tension_resolution",
    "downstream_reach",
    "mechanism_insight",
    "testability_timing",
    "verification_cost",
)

# Wording that must never appear in this skill's prose or templates: neither
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
    "boilerplate",
)

# Prose surfaces of the skill itself, locked by the same word scan.
PROSE_FILES = (
    SKILL_ROOT / "SKILL.md",
    SKILL_ROOT / "scripts" / "gaia_package_scaffold.py",
    SKILL_ROOT / "scripts" / "run_infer_and_extract.py",
    SKILL_ROOT / "scripts" / "posterior_writeback.py",
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


def test_skill_prose_is_domain_neutral_and_jargon_free() -> None:
    for path in PROSE_FILES:
        text = path.read_text(encoding="utf-8").lower()
        for word in FORBIDDEN_TEMPLATE_WORDS:
            assert word.lower() not in text, f"{word} in {path.name}"
        # Generic use of "harness" is banned; the existing skill name
        # research-harness is the only allowed occurrence.
        residue = text.replace("research-harness", "")
        assert "harness" not in residue, f"generic 'harness' in {path.name}"


def test_version_check_rejects_near_miss_banner(tmp_path, capsys) -> None:
    fake = tmp_path / "fake-gaia"
    fake.write_text("#!/bin/sh\necho 'gaia-lang 0.5.0a41'\n", encoding="utf-8")
    fake.chmod(0o755)
    with pytest.raises(SystemExit) as excinfo:
        scaffold.check_gaia_version(str(fake))
    assert excinfo.value.code == 2
    assert "version mismatch" in capsys.readouterr().err


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


GENERATED_PYPROJECT = """\
[project]
name = "example-idea-gaia"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = [
    "gaia-lang>=0.4.4",
]
"""


def write_generated_package(tmp_path):
    """A package directory shaped like fresh `gaia build init` output."""
    package = tmp_path / "example-idea-gaia"
    (package / ".git").mkdir(parents=True)
    (package / ".git" / "HEAD").write_text(
        "ref: refs/heads/main\n", encoding="utf-8"
    )
    (package / ".venv" / "bin").mkdir(parents=True)
    (package / "uv.lock").write_text("", encoding="utf-8")
    (package / ".python-version").write_text("3.13\n", encoding="utf-8")
    (package / "pyproject.toml").write_text(
        GENERATED_PYPROJECT, encoding="utf-8"
    )
    return package


def test_harden_package_strips_git_and_retargets_pins(tmp_path) -> None:
    package = write_generated_package(tmp_path)
    scaffold.harden_package(package)
    # The zero-commit nested repository is absorbed into the project's own
    # version control by removing it; the init-time env is dropped so the
    # next gaia run re-syncs from the corrected pins.
    assert not (package / ".git").exists()
    assert not (package / ".venv").exists()
    assert not (package / "uv.lock").exists()
    text = (package / "pyproject.toml").read_text(encoding="utf-8")
    assert f'"gaia-lang=={scaffold.GAIA_PIN}"' in text
    assert "gaia-lang>=0.4.4" not in text
    assert f'requires-python = ">={scaffold.PACKAGE_PYTHON}"' in text
    assert (package / ".python-version").read_text(
        encoding="utf-8"
    ).strip() == scaffold.PACKAGE_PYTHON


def test_harden_package_stops_on_template_drift(tmp_path) -> None:
    package = write_generated_package(tmp_path)
    (package / "pyproject.toml").write_text(
        GENERATED_PYPROJECT.replace(
            '"gaia-lang>=0.4.4"', '"gaia-lang>=9.9.9"'
        ),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="template"):
        scaffold.harden_package(package)
    # Wrong pins must never silently pass through.
    assert "9.9.9" in (package / "pyproject.toml").read_text(encoding="utf-8")


def test_harden_package_requires_pyproject(tmp_path) -> None:
    package = tmp_path / "example-idea-gaia"
    package.mkdir()
    with pytest.raises(RuntimeError, match="pyproject"):
        scaffold.harden_package(package)


def test_untracked_project_note_is_advisory_only(tmp_path, capsys) -> None:
    scaffold.note_when_project_untracked(tmp_path / "definitely-not-a-repo")
    err = capsys.readouterr().err
    assert "not under version control" in err
    assert "never runs it for you" in err


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
