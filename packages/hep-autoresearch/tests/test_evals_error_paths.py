from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))
for name in [key for key in sys.modules if key == "hep_autoresearch" or key.startswith("hep_autoresearch.")]:
    sys.modules.pop(name)

from hep_autoresearch.toolkit.evals import _json_pointer_get, _schema_validate, run_eval_case


def _seed_specs(root: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    (root / "specs").mkdir(parents=True, exist_ok=True)
    (root / "specs" / "eval_case.schema.json").write_text(
        (repo_root / "specs" / "eval_case.schema.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )


def _write_case(root: Path, case: dict[str, object]) -> Path:
    case_dir = root / "case"
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "case.json").write_text(json.dumps(case, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return case_dir


def test_json_pointer_get_rejects_non_numeric_list_tokens() -> None:
    with pytest.raises(KeyError, match="expected list index"):
        _json_pointer_get({"items": [1]}, "items.nope")


def test_schema_validate_reports_invalid_minimum_and_min_length_configs() -> None:
    min_errors = _schema_validate(1, {"type": "number", "minimum": "bad"}, "payload", root_schema={})
    assert "payload: cannot compare minimum for value 1" in min_errors

    length_errors = _schema_validate("abc", {"type": "string", "minLength": "bad"}, "payload", root_schema={})
    assert "payload: cannot validate minLength for value 'abc'" in length_errors


def test_run_eval_case_reports_case_schema_load_error(tmp_path: Path) -> None:
    _seed_specs(tmp_path)
    (tmp_path / "specs" / "eval_case.schema.json").write_text("{\n", encoding="utf-8")
    case_dir = _write_case(tmp_path, {"schema_version": 1, "case_id": "TMP-case", "workflow": "custom", "acceptance": {}})

    result = run_eval_case(case_dir, repo_root=tmp_path)

    assert not result.ok
    assert any(msg.startswith("case.json schema validation error:") for msg in result.messages)


def test_run_eval_case_reports_artifact_schema_read_error(tmp_path: Path) -> None:
    _seed_specs(tmp_path)
    (tmp_path / "summary.json").write_text("{}\n", encoding="utf-8")
    (tmp_path / "specs" / "artifact_summary.schema.json").write_text("{\n", encoding="utf-8")
    case_dir = _write_case(
        tmp_path,
        {
            "schema_version": 1,
            "case_id": "TMP-summary",
            "workflow": "custom",
            "acceptance": {"required_paths_exist": ["summary.json"]},
        },
    )

    result = run_eval_case(case_dir, repo_root=tmp_path)

    assert not result.ok
    assert any(msg.startswith("schema validation error for summary.json:") for msg in result.messages)


def test_run_eval_case_reports_json_read_and_pointer_errors(tmp_path: Path) -> None:
    _seed_specs(tmp_path)
    (tmp_path / "numbers.json").write_text("{\n", encoding="utf-8")
    case_dir = _write_case(
        tmp_path,
        {
            "schema_version": 1,
            "case_id": "TMP-json-errors",
            "workflow": "custom",
            "acceptance": {
                "json_numeric_checks": [{"path": "numbers.json", "pointer": "/items/0"}],
                "json_value_checks": [{"path": "missing.json", "pointer": "/value"}],
            },
        },
    )

    result = run_eval_case(case_dir, repo_root=tmp_path)

    assert not result.ok
    assert any("json_numeric_checks[0] could not read json: numbers.json" in msg for msg in result.messages)
    assert any("json_value_checks[0] missing file: missing.json" in msg for msg in result.messages)


def test_run_eval_case_reports_pointer_and_min_length_errors(tmp_path: Path) -> None:
    _seed_specs(tmp_path)
    (tmp_path / "payload.json").write_text(json.dumps({"items": ["abc"]}) + "\n", encoding="utf-8")
    case_dir = _write_case(
        tmp_path,
        {
            "schema_version": 1,
            "case_id": "TMP-pointer-errors",
            "workflow": "custom",
            "acceptance": {
                "json_numeric_checks": [{"path": "payload.json", "pointer": "/items/nope"}],
                "json_value_checks": [{"path": "payload.json", "pointer": "/items/0", "min_length": "bad"}],
            },
        },
    )

    result = run_eval_case(case_dir, repo_root=tmp_path)

    assert not result.ok
    assert any("json_numeric_checks[0] missing pointer: payload.json/items/nope" in msg for msg in result.messages)
    assert any("json_value_checks[0] min_length must be integer at payload.json/items/0" in msg for msg in result.messages)


def test_run_eval_case_reports_text_read_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_specs(tmp_path)
    target = tmp_path / "notes.md"
    target.write_text("hello\n", encoding="utf-8")
    case_dir = _write_case(
        tmp_path,
        {
            "schema_version": 1,
            "case_id": "TMP-text-read",
            "workflow": "custom",
            "acceptance": {"text_contains_checks": [{"path": "notes.md", "contains": ["hello"]}]},
        },
    )
    original_read_text = Path.read_text

    def _patched_read_text(path: Path, *args: object, **kwargs: object) -> str:
        if path == target:
            raise OSError("boom")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _patched_read_text)
    result = run_eval_case(case_dir, repo_root=tmp_path)

    assert not result.ok
    assert any("text_contains_checks[0] could not read file: notes.md (boom)" == msg for msg in result.messages)


def test_run_eval_case_reports_bad_zip_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_specs(tmp_path)
    (tmp_path / "bundle.zip").write_bytes(b"not-a-zip")
    case_dir = _write_case(
        tmp_path,
        {
            "schema_version": 1,
            "case_id": "TMP-zip-read",
            "workflow": "custom",
            "acceptance": {"zip_contains_checks": [{"path": "bundle.zip", "required_entries": ["a.txt"]}]},
        },
    )

    def _raise_bad_zip(*args: object, **kwargs: object) -> zipfile.ZipFile:
        raise zipfile.BadZipFile("broken zip")

    monkeypatch.setattr(zipfile, "ZipFile", _raise_bad_zip)
    result = run_eval_case(case_dir, repo_root=tmp_path)

    assert not result.ok
    assert any("zip_contains_checks[0] could not read zip: bundle.zip (broken zip)" == msg for msg in result.messages)
