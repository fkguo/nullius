from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from idea_core.contracts.validate import (
    ContractValidationError,
    DEFAULT_CONTRACT_DIR,
    run_validation,
)


def _copy_contract_tree(tmp_path: Path) -> Path:
    target = tmp_path / "schemas"
    shutil.copytree(DEFAULT_CONTRACT_DIR, target)
    return target


def test_validation_passes_for_vendored_snapshot() -> None:
    run_validation(DEFAULT_CONTRACT_DIR)


def test_drift_guard_rejects_inline_complex_schema(tmp_path: Path) -> None:
    contract_dir = _copy_contract_tree(tmp_path)
    openrpc_path = contract_dir / "idea_core_rpc_v1.openrpc.json"
    doc = json.loads(openrpc_path.read_text(encoding="utf-8"))

    for method in doc["methods"]:
        if method["name"] == "campaign.init":
            method["params"].append(
                {
                    "name": "bad_inline",
                    "required": False,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "x": {"type": "string"},
                        },
                    },
                }
            )
            break

    openrpc_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    with pytest.raises(ContractValidationError, match="drift-guard"):
        run_validation(contract_dir)


def test_ref_closure_fails_on_missing_target(tmp_path: Path) -> None:
    contract_dir = _copy_contract_tree(tmp_path)
    openrpc_path = contract_dir / "idea_core_rpc_v1.openrpc.json"
    doc = json.loads(openrpc_path.read_text(encoding="utf-8"))

    for method in doc["methods"]:
        if method["name"] == "campaign.status":
            method["result"]["schema"] = {"$ref": "./missing_schema_v1.schema.json"}
            break

    openrpc_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    with pytest.raises(ContractValidationError, match="missing referenced file"):
        run_validation(contract_dir)
