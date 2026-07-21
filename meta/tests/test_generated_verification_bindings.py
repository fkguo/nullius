from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from meta.generated.python.step_execution_snapshot_v1 import StepexecutionsnapshotV1
from meta.generated.python.verification_check_run_v1 import VerificationcheckrunV1


def _artifact_ref(name: str) -> dict[str, object]:
    return {
        "uri": f"rep://runs/test/artifact/{name}",
        "sha256": "a" * 64,
    }


def _check_run(role: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "check_run_id": "check:test",
        "run_id": "test",
        "subject_id": "subject:test",
        "subject_ref": _artifact_ref("subject.json"),
        "check_kind": "test_check",
        "check_role": role,
        "status": "passed",
        "summary": "Test check completed.",
        "executor_provenance": {"component": "test", "surface": "generated-binding"},
        "evidence_refs": [_artifact_ref("evidence.json")],
        "confidence": {"level": "high"},
        "started_at": "2026-07-21T00:00:00Z",
        "finished_at": "2026-07-21T00:00:01Z",
    }


def test_generated_python_binding_requires_receipt_for_decisive_check() -> None:
    with pytest.raises(ValidationError):
        VerificationcheckrunV1.model_validate(_check_run("decisive"))

    decisive = _check_run("decisive")
    decisive["validation_chain_binding_ref"] = _artifact_ref("binding.json")
    assert VerificationcheckrunV1.model_validate(decisive).root.check_role == "decisive"


def test_generated_python_binding_keeps_nondecisive_receipt_optional() -> None:
    supporting = deepcopy(_check_run("supporting"))
    assert VerificationcheckrunV1.model_validate(supporting).root.check_role == "supporting"


def _step_snapshot(phase: str) -> dict[str, object]:
    workspace_ref = {
        "relative_path": "manifest.json",
        "sha256": "b" * 64,
        "size_bytes": 128,
    }
    return {
        "schema_version": 1,
        "phase": phase,
        "step_id": "step:test",
        "captured_at": "2026-07-21T00:00:00Z",
        "manifest_ref": workspace_ref,
        "script_ref": {
            "relative_path": "scripts/run.py",
            "sha256": "c" * 64,
            "size_bytes": 64,
        },
        "runtime_identity": {
            "requested_token": "python3",
            "canonical_path": "/usr/bin/python3",
            "sha256": "d" * 64,
            "size_bytes": 1024,
            "executable_format": "mach_o",
        },
        "execution_environment": {
            "policy": "nullius_production_allowlist_v1",
            "variables": {"PATH": "/usr/bin:/bin"},
            "sha256": "e" * 64,
        },
        "external_dependency_closure": "declared_and_locked_not_syscall_traced",
    }


def test_generated_python_binding_requires_pre_spawn_workspace_refs() -> None:
    pre_spawn = _step_snapshot("pre_spawn")
    with pytest.raises(ValidationError):
        StepexecutionsnapshotV1.model_validate(pre_spawn)

    pre_spawn["workspace_file_refs"] = [deepcopy(pre_spawn["manifest_ref"])]
    assert StepexecutionsnapshotV1.model_validate(pre_spawn).root.phase == "pre_spawn"


def test_generated_python_binding_requires_post_exit_workspace_and_output_refs() -> None:
    post_exit = _step_snapshot("post_exit")
    post_exit["output_refs"] = []
    with pytest.raises(ValidationError):
        StepexecutionsnapshotV1.model_validate(post_exit)

    post_exit["workspace_file_refs"] = [deepcopy(post_exit["manifest_ref"])]
    del post_exit["output_refs"]
    with pytest.raises(ValidationError):
        StepexecutionsnapshotV1.model_validate(post_exit)

    post_exit["output_refs"] = []
    assert StepexecutionsnapshotV1.model_validate(post_exit).root.phase == "post_exit"
