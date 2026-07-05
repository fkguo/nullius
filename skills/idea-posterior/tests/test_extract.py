"""Tests for run_infer_and_extract.py parsing against checked-in fixtures."""

from __future__ import annotations

import json
import shutil

import pytest

import run_infer_and_extract as extract


@pytest.fixture()
def beliefs(fixtures_dir) -> dict:
    return json.loads((fixtures_dir / "beliefs_sample.json").read_text())


@pytest.fixture()
def ir(fixtures_dir) -> dict:
    return json.loads((fixtures_dir / "ir_sample.json").read_text())


def test_worth_belief_extracted_by_label(beliefs) -> None:
    value = extract.extract_worth_belief(beliefs, "worth")
    assert value == pytest.approx(0.8499370175790979)


def test_custom_worth_label(beliefs) -> None:
    value = extract.extract_worth_belief(beliefs, "tension_resolution")
    assert value == pytest.approx(0.9374212719738726)


def test_missing_worth_label_lists_available_labels(beliefs) -> None:
    for entry in beliefs["beliefs"]:
        if entry["label"] == "worth":
            entry["label"] = "renamed"
    with pytest.raises(ValueError) as excinfo:
        extract.extract_worth_belief(beliefs, "worth")
    message = str(excinfo.value)
    assert "ev_tension" in message and "renamed" in message


def test_out_of_range_belief_rejected(beliefs) -> None:
    for entry in beliefs["beliefs"]:
        if entry["label"] == "worth":
            entry["belief"] = 1.7
    with pytest.raises(ValueError, match="not in"):
        extract.extract_worth_belief(beliefs, "worth")


def test_observation_count_from_ir(ir) -> None:
    assert extract.count_observations(ir) == 2


def test_observation_count_ignores_non_observation_supports(ir) -> None:
    ir["knowledges"][2]["metadata"]["supported_by"][0]["pattern"] = "inference"
    assert extract.count_observations(ir) == 1


def test_extract_posterior_end_shape(tmp_path, fixtures_dir) -> None:
    gaia_dir = tmp_path / "pkg" / ".gaia"
    gaia_dir.mkdir(parents=True)
    shutil.copy(fixtures_dir / "beliefs_sample.json", gaia_dir / "beliefs.json")
    shutil.copy(fixtures_dir / "ir_sample.json", gaia_dir / "ir.json")

    posterior = extract.extract_posterior(tmp_path / "pkg", "worth")

    assert set(posterior) == {"value", "evidence_count", "gaia_package_ref"}
    assert posterior["value"] == pytest.approx(0.8499370175790979)
    assert posterior["evidence_count"] == 2
    ref = posterior["gaia_package_ref"]
    assert ref.startswith(str((tmp_path / "pkg").resolve()))
    assert ref.endswith(
        "#sha256:e314d88c63c80b8845d2c1347e0f20b77db5825076d847ecd1c143a925afc676"
    )


def test_extract_posterior_requires_artifacts(tmp_path) -> None:
    (tmp_path / "pkg").mkdir()
    with pytest.raises(FileNotFoundError, match="run the inference stages"):
        extract.extract_posterior(tmp_path / "pkg", "worth")


CLEAN_MODULE = '''
from gaia.engine.lang import claim, infer, observe, register_prior

worth = claim("The idea merits sustained verification effort.", title="worth")
sub = claim("A sub-criterion holds.", title="sub")
ev = observe("An anchored fact.", rationale="context. anchor: survey artifact")
infer(ev, hypothesis=sub, p_e_given_h=0.90, p_e_given_not_h=0.09,
      rationale="substantial grade. anchor: survey artifact")
register_prior(sub, value=0.7,
               justification="external estimate. anchor: cited source")
'''


def test_discipline_scan_passes_clean_module() -> None:
    assert extract.scan_discipline(CLEAN_MODULE) == []


def test_discipline_scan_flags_off_grade_pair() -> None:
    source = CLEAN_MODULE.replace("p_e_given_h=0.90", "p_e_given_h=0.85")
    findings = extract.scan_discipline(source)
    assert any("off-grade pair" in f for f in findings)


def test_discipline_scan_flags_missing_anchor_note() -> None:
    source = CLEAN_MODULE.replace(
        'rationale="context. anchor: survey artifact"',
        'rationale="context with no note"',
    )
    findings = extract.scan_discipline(source)
    assert any("lacks an 'anchor:' note" in f for f in findings)


def test_discipline_scan_flags_missing_justification_anchor() -> None:
    source = CLEAN_MODULE.replace(
        'justification="external estimate. anchor: cited source"',
        'justification="just a feeling"',
    )
    findings = extract.scan_discipline(source)
    assert any(
        "register_prior" in f and "anchor" in f for f in findings
    )


def test_discipline_scan_surfaces_non_literal_arguments() -> None:
    source = CLEAN_MODULE + "\nnote = 'anchor: x'\nobserve('More.', rationale=note)\n"
    findings = extract.scan_discipline(source)
    assert any("flag for review" in f for f in findings)


def test_discipline_scan_accepts_reversed_grades() -> None:
    source = CLEAN_MODULE.replace(
        "p_e_given_h=0.90, p_e_given_not_h=0.09",
        "p_e_given_h=0.09, p_e_given_not_h=0.90",
    )
    assert extract.scan_discipline(source) == []


def test_discipline_scan_covers_generated_template() -> None:
    import gaia_package_scaffold as scaffold

    assert extract.scan_discipline(scaffold.render_template("x-idea")) == []


def test_extract_posterior_requires_ir_hash(tmp_path, fixtures_dir) -> None:
    gaia_dir = tmp_path / "pkg" / ".gaia"
    gaia_dir.mkdir(parents=True)
    shutil.copy(fixtures_dir / "beliefs_sample.json", gaia_dir / "beliefs.json")
    ir = json.loads((fixtures_dir / "ir_sample.json").read_text())
    del ir["ir_hash"]
    (gaia_dir / "ir.json").write_text(json.dumps(ir), encoding="utf-8")
    with pytest.raises(ValueError, match="ir_hash"):
        extract.extract_posterior(tmp_path / "pkg", "worth")
