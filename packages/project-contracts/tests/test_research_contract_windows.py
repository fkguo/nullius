"""Native Windows coverage for research-contract atomic replacement.

These tests run only where the relevant OS sharing semantics exist. The POSIX
descriptor-pinned writer remains covered by test_scaffold_preserves_user_contract.
"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import mock

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from project_contracts import research_contract  # noqa: E402
from project_contracts.project_policy import PROJECT_POLICY_REAL_PROJECT  # noqa: E402
from project_contracts.project_scaffold import ensure_project_scaffold  # noqa: E402
from project_contracts.research_contract import (  # noqa: E402
    PROPOSAL_SENTINEL,
    propose_research_contract_block,
    sync_research_contract,
)
from project_contracts.scaffold_template_loader import load_scaffold_template  # noqa: E402
from project_contracts.project_surface import RESEARCH_CONTRACT  # noqa: E402


pytestmark = pytest.mark.skipif(os.name != "nt", reason="native Windows capability coverage")


def _fresh_sync_root(base: Path) -> Path:
    root = base / "project"
    root.mkdir()
    (root / "research_contract.md").write_bytes(
        load_scaffold_template(RESEARCH_CONTRACT).encode("utf-8")
    )
    (root / "research_notebook.md").write_text(
        "# Notebook\n\n## Scope\n\nWindows.\n", encoding="utf-8"
    )
    return root


def _powershell_for_path(script: str, path: Path) -> str:
    environment = os.environ.copy()
    environment["NULLIUS_DACL_TEST_TARGET"] = os.fspath(path)
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    return result.stdout.strip()


def _set_protected_current_user_dacl(path: Path) -> str:
    return _powershell_for_path(
        """
$ErrorActionPreference = 'Stop'
$target = $env:NULLIUS_DACL_TEST_TARGET
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRuleAll($_) }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
(Get-Acl -LiteralPath $target).Sddl
""",
        path,
    )


def _dacl_sddl(path: Path) -> str:
    return _powershell_for_path(
        "$ErrorActionPreference = 'Stop'; "
        "(Get-Acl -LiteralPath $env:NULLIUS_DACL_TEST_TARGET).Sddl",
        path,
    )


def test_windows_uses_the_explicit_path_guard_capability() -> None:
    assert os.open not in os.supports_dir_fd
    assert research_contract._CAN_PIN_PARENT_DIRECTORY is False


def test_fresh_scaffold_syncs_without_descriptor_relative_operations() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "fresh"
        root.mkdir()

        result = ensure_project_scaffold(
            repo_root=root,
            project_name="Windows project",
            project_policy=PROJECT_POLICY_REAL_PROJECT,
        )

        assert result["contract_sync"] is not None
        contract = (root / "research_contract.md").read_text(encoding="utf-8")
        assert "- Notebook sha256: `" in contract
        assert "- (refresh to populate)" not in contract
        assert not list(root.glob(".*.partial"))
        assert not list(root.glob(".*.write-guard"))


def test_windows_revalidates_the_contract_after_releasing_its_read_handle() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = _fresh_sync_root(Path(td))
        contract = root / "research_contract.md"
        curated = root / "curated.md"
        curated.write_text("# CURATED\n", encoding="utf-8")
        real_writer = research_contract._write_file_atomically_windows

        def swap_before_write(target, text, **kwargs):
            os.replace(curated, contract)
            return real_writer(target, text, **kwargs)

        with mock.patch.object(
            research_contract, "_write_file_atomically_windows", swap_before_write
        ):
            with pytest.raises(FileExistsError, match="changed identity"):
                sync_research_contract(
                    repo_root=root,
                    create_missing=False,
                    project_policy=PROJECT_POLICY_REAL_PROJECT,
                )

        assert contract.read_text(encoding="utf-8") == "# CURATED\n"


def test_windows_open_guard_blocks_immediate_parent_rename_during_replace() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "project"
        root.mkdir()
        (root / "research_contract.md").write_text("# Contract\n", encoding="utf-8")
        (root / "research_notebook.md").write_text(
            "# Notebook\n\n## Scope\n\nWindows.\n", encoding="utf-8"
        )
        proposal = root / "artifacts" / "proposal.md"
        attempted = []
        real_replace = research_contract._replace_file_windows

        def probe_replace(target, replacement, **kwargs):
            attempted.append(True)
            with pytest.raises(PermissionError):
                os.rename(proposal.parent, root / "artifacts-moved")
            return real_replace(target, replacement, **kwargs)

        with mock.patch.object(research_contract, "_replace_file_windows", probe_replace):
            propose_research_contract_block(
                repo_root=root,
                proposal_path=proposal,
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )

        assert attempted == [True]
        assert proposal.read_bytes().startswith(PROPOSAL_SENTINEL.encode("utf-8"))
        assert not list(proposal.parent.glob(".*.partial"))
        assert not list(proposal.parent.glob(".*.write-guard"))


def test_windows_rechecks_an_existing_proposal_immediately_before_replace() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "project"
        root.mkdir()
        (root / "research_contract.md").write_text("# Contract\n", encoding="utf-8")
        (root / "research_notebook.md").write_text(
            "# Notebook\n\n## Scope\n\nWindows.\n", encoding="utf-8"
        )
        first = propose_research_contract_block(
            repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
        )
        proposal = Path(first["proposal_path"])
        real_chmod = os.chmod

        def edit_after_temporary_write(path, mode, *args, **kwargs):
            result = real_chmod(path, mode, *args, **kwargs)
            proposal.write_bytes(b"OWNER EDIT\n")
            return result

        with mock.patch.object(os, "chmod", edit_after_temporary_write):
            with pytest.raises(FileExistsError, match="no longer an earlier proposal"):
                propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )

        assert proposal.read_bytes() == b"OWNER EDIT\n"
        assert not list(proposal.parent.glob(".*.partial"))
        assert not list(proposal.parent.glob(".*.write-guard"))


def test_windows_replacement_preserves_ntfs_named_streams() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = _fresh_sync_root(Path(td))
        contract = root / "research_contract.md"
        stream = Path(f"{contract}:nullius_test")
        try:
            stream.write_bytes(b"owner metadata")
        except OSError as exc:
            pytest.skip(f"temporary filesystem does not expose NTFS named streams: {exc}")

        sync_research_contract(
            repo_root=root,
            create_missing=False,
            project_policy=PROJECT_POLICY_REAL_PROJECT,
        )

        assert stream.read_bytes() == b"owner metadata"
        assert not list(root.glob(".*.backup"))


def test_windows_replacement_preserves_a_protected_dacl() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = _fresh_sync_root(Path(td))
        contract = root / "research_contract.md"
        before = _set_protected_current_user_dacl(contract)

        sync_research_contract(
            repo_root=root,
            create_missing=False,
            project_policy=PROJECT_POLICY_REAL_PROJECT,
        )

        assert _dacl_sddl(contract) == before
        assert not list(root.glob(".*.backup"))


def test_windows_replace_failure_restores_the_original_from_backup() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = _fresh_sync_root(Path(td))
        contract = root / "research_contract.md"
        original = contract.read_bytes()

        def fail_after_moving_original(target, replacement, backup):
            os.rename(target, backup)
            return 1177  # ERROR_UNABLE_TO_MOVE_REPLACEMENT_2

        with mock.patch.object(
            research_contract, "_call_replace_file_windows", fail_after_moving_original
        ):
            with pytest.raises(OSError, match="restored from the recovery backup"):
                sync_research_contract(
                    repo_root=root,
                    create_missing=False,
                    project_policy=PROJECT_POLICY_REAL_PROJECT,
                )

        assert contract.read_bytes() == original
        assert not list(root.glob(".*.backup"))
        assert not list(root.glob(".*.partial"))
        assert not list(root.glob(".*.write-guard"))
