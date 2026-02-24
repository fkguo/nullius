from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from idea_core.contracts.bundle import BUNDLED_OPENRPC_FILE, write_bundle
from idea_core.contracts.validate import ContractValidationError, DEFAULT_CONTRACT_DIR, run_validation


def _copy_contract_tree(tmp_path: Path) -> Path:
    target = tmp_path / "schemas"
    shutil.copytree(DEFAULT_CONTRACT_DIR, target)
    return target


def test_bundle_can_be_generated_and_validated(tmp_path: Path) -> None:
    contract_dir = _copy_contract_tree(tmp_path)
    bundle_path = write_bundle(contract_dir)

    assert bundle_path.name == BUNDLED_OPENRPC_FILE
    bundle_doc = json.loads(bundle_path.read_text(encoding="utf-8"))
    assert isinstance(bundle_doc, dict)
    assert "methods" in bundle_doc
    assert "components" in bundle_doc
    assert "schemas" in bundle_doc["components"]

    run_validation(contract_dir)


def test_validate_fails_on_bundle_drift(tmp_path: Path) -> None:
    contract_dir = _copy_contract_tree(tmp_path)
    bundle_path = write_bundle(contract_dir)
    bundle_doc = json.loads(bundle_path.read_text(encoding="utf-8"))
    bundle_doc["info"]["title"] = "tampered-bundle"
    bundle_path.write_text(json.dumps(bundle_doc, indent=2), encoding="utf-8")

    with pytest.raises(ContractValidationError, match="bundle artifact drift detected"):
        run_validation(contract_dir)


def test_validate_recovers_after_rebundle(tmp_path: Path) -> None:
    contract_dir = _copy_contract_tree(tmp_path)
    bundle_path = write_bundle(contract_dir)
    bundle_doc = json.loads(bundle_path.read_text(encoding="utf-8"))
    bundle_doc["info"]["title"] = "tampered-bundle"
    bundle_path.write_text(json.dumps(bundle_doc, indent=2), encoding="utf-8")

    with pytest.raises(ContractValidationError, match="bundle artifact drift detected"):
        run_validation(contract_dir)

    write_bundle(contract_dir)
    run_validation(contract_dir)


def test_bundle_writer_does_not_leave_temp_files(tmp_path: Path) -> None:
    contract_dir = _copy_contract_tree(tmp_path)
    _ = write_bundle(contract_dir)
    _ = write_bundle(contract_dir)

    leftovers = sorted(path.name for path in contract_dir.glob("*.tmp*"))
    assert leftovers == []
