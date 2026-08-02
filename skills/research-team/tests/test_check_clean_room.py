from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_gate_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "gates" / "check_clean_room.py"
    spec = importlib.util.spec_from_file_location("check_clean_room", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _run_main_with_argv(mod, argv: list[str]) -> int:
    old_argv = sys.argv
    try:
        sys.argv = argv
        return mod.main()
    finally:
        sys.argv = old_argv


def _write_project(tmp_path: Path, *, features: dict | None = None, review_access_mode: str = "full_access") -> tuple[Path, Path]:
    root = tmp_path / "proj"
    root.mkdir()
    notes = root / "research_contract.md"
    notes.write_text("# Notes\n", encoding="utf-8")
    config = {
        "features": {"clean_room_gate": True, **(features or {})},
        "review_access_mode": review_access_mode,
    }
    (root / "research_team_config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return root, notes


def _write_evidence(path: Path, payload: dict) -> Path:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def _write_audit(path: Path, *, tc_id: str, workspace: str) -> Path:
    entry = {
        "tc_id": tc_id,
        "tool_name": "file_read",
        "args_hash": "a" * 64,
        "result_hash": "b" * 64,
        "workspace": workspace,
        "timestamp_utc": "2026-04-14T00:00:00.000000Z",
    }
    path.write_text(json.dumps(entry) + "\n", encoding="utf-8")
    return path


def test_skip_when_gate_disabled(tmp_path: Path) -> None:
    mod = _load_gate_module()
    root, notes = _write_project(tmp_path, features={"clean_room_gate": False})
    member_a = _write_evidence(root / "member_a.json", {})
    member_b = _write_evidence(root / "member_b.json", {})

    code = _run_main_with_argv(
        mod,
        ["check_clean_room.py", "--notes", str(notes), "--member-a", str(member_a), "--member-b", str(member_b)],
    )
    assert code == 0


def test_skip_when_not_full_access(tmp_path: Path) -> None:
    mod = _load_gate_module()
    root, notes = _write_project(tmp_path, review_access_mode="packet_only")
    member_a = _write_evidence(root / "member_a.json", {})
    member_b = _write_evidence(root / "member_b.json", {})

    code = _run_main_with_argv(
        mod,
        ["check_clean_room.py", "--notes", str(notes), "--member-a", str(member_a), "--member-b", str(member_b)],
    )
    assert code == 0


def test_hard_fail_on_cross_member_path_contamination(tmp_path: Path) -> None:
    mod = _load_gate_module()
    root, notes = _write_project(tmp_path)
    member_a = _write_evidence(
        root / "member_a.json",
        {"files_read": [{"path": "team/runs/T123/member_b/report.md"}]},
    )
    member_b = _write_evidence(root / "member_b.json", {})

    code = _run_main_with_argv(
        mod,
        [
            "check_clean_room.py",
            "--notes",
            str(notes),
            "--member-a",
            str(member_a),
            "--member-b",
            str(member_b),
            "--safe-tag",
            "T123",
        ],
    )
    assert code == 3


def test_hard_fail_on_modern_run_layout_cross_member_contamination(tmp_path: Path) -> None:
    """Today's lifecycle-root mirror layout (artifacts/runs/<tag>/research_team/<other>)
    is a contamination surface too — the one path pattern added on main after
    the original tests were written, previously uncovered."""
    mod = _load_gate_module()
    root, notes = _write_project(tmp_path)
    member_a = _write_evidence(
        root / "member_a.json",
        {"files_read": [{"path": "artifacts/runs/T123/research_team/member_b/report.md"}]},
    )
    member_b = _write_evidence(root / "member_b.json", {})

    code = _run_main_with_argv(
        mod,
        [
            "check_clean_room.py",
            "--notes",
            str(notes),
            "--member-a",
            str(member_a),
            "--member-b",
            str(member_b),
            "--safe-tag",
            "T123",
        ],
    )
    assert code == 3


def test_hard_fail_when_workspace_has_tcids_but_audit_missing(tmp_path: Path) -> None:
    mod = _load_gate_module()
    root, notes = _write_project(tmp_path)
    member_a = _write_evidence(root / "member_a.json", {"files_read": [{"path": "research_contract.md", "tc_id": "tc-a"}]})
    member_b = _write_evidence(root / "member_b.json", {})

    code = _run_main_with_argv(
        mod,
        [
            "check_clean_room.py",
            "--notes",
            str(notes),
            "--member-a",
            str(member_a),
            "--member-b",
            str(member_b),
            "--workspace-id-a",
            "workspace-a",
        ],
    )
    assert code == 4


def test_passes_with_clean_evidence_and_matching_audits(tmp_path: Path) -> None:
    mod = _load_gate_module()
    root, notes = _write_project(tmp_path)
    member_a = _write_evidence(
        root / "member_a.json",
        {"files_read": [{"path": "research_contract.md", "tc_id": "tc-a"}]},
    )
    member_b = _write_evidence(
        root / "member_b.json",
        {"commands_run": [{"command": "echo ok", "cwd": ".", "output_path": "artifacts/member_b.txt", "tc_id": "tc-b"}]},
    )
    audit_a = _write_audit(root / "audit_a.jsonl", tc_id="tc-a", workspace="workspace-a")
    audit_b = _write_audit(root / "audit_b.jsonl", tc_id="tc-b", workspace="workspace-b")

    code = _run_main_with_argv(
        mod,
        [
            "check_clean_room.py",
            "--notes",
            str(notes),
            "--member-a",
            str(member_a),
            "--member-b",
            str(member_b),
            "--workspace-id-a",
            "workspace-a",
            "--workspace-id-b",
            "workspace-b",
            "--audit-a",
            str(audit_a),
            "--audit-b",
            str(audit_b),
        ],
    )
    assert code == 0
