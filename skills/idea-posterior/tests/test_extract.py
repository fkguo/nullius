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


def test_extract_posterior_requires_ir_hash(tmp_path, fixtures_dir) -> None:
    gaia_dir = tmp_path / "pkg" / ".gaia"
    gaia_dir.mkdir(parents=True)
    shutil.copy(fixtures_dir / "beliefs_sample.json", gaia_dir / "beliefs.json")
    ir = json.loads((fixtures_dir / "ir_sample.json").read_text())
    del ir["ir_hash"]
    (gaia_dir / "ir.json").write_text(json.dumps(ir), encoding="utf-8")
    with pytest.raises(ValueError, match="ir_hash"):
        extract.extract_posterior(tmp_path / "pkg", "worth")
