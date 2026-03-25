from __future__ import annotations

import datetime as dt
import json
import pathlib
import shutil
import tempfile
from typing import Any

from .python_runtime import create_isolated_venv
from .skill_note import inject_python_runtime_note
from .source_payload import safe_remove


def _copy_payload(stage_root: pathlib.Path, source_dir: pathlib.Path, files: list[pathlib.Path]) -> None:
    for source_file in files:
        if source_file.is_symlink():
            raise RuntimeError(f"refuse to copy symlink payload file: {source_file}")
        rel = source_file.relative_to(source_dir)
        out = stage_root / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, out, follow_symlinks=False)


def install_payload(
    *,
    package_id: str,
    target_root: pathlib.Path,
    source_dir: pathlib.Path,
    files: list[pathlib.Path],
    metadata: dict[str, Any],
    python_runtime: dict[str, Any] | None,
    install_mode: str,
    auto_safe_evaluation: dict[str, Any] | None,
    force: bool,
    dry_run: bool,
) -> None:
    destination = target_root / package_id
    if destination.exists() or destination.is_symlink():
        if not force:
            if dry_run:
                print(f"[dry-run] {package_id}: target exists and would fail without --force: {destination}")
                return
            raise RuntimeError(f"target already exists: {destination} (use --force to replace)")

    if dry_run:
        runtime_msg = ""
        if python_runtime is not None:
            runtime_msg = f" with isolated Python runtime ({len(python_runtime['packages'])} package(s))"
        print(f"[dry-run] {package_id}: would install {len(files)} files to {destination}{runtime_msg}")
        return

    target_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{package_id}-stage-", dir=str(target_root)) as tmp:
        stage_dir = pathlib.Path(tmp)
        stage_root = stage_dir / package_id
        stage_root.mkdir()
        _copy_payload(stage_root, source_dir, files)

        install_record = {
            "package_id": package_id,
            "installed_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "install_mode": install_mode,
            **metadata,
            "file_count": len(files),
        }
        if auto_safe_evaluation is not None:
            install_record["auto_safe_evaluation"] = auto_safe_evaluation

        if python_runtime is not None:
            runtime_record = create_isolated_venv(stage_root, python_runtime["packages"])
            inject_python_runtime_note(stage_root / "SKILL.md", runtime_record["venv_python"])
            install_record["python_runtime"] = runtime_record

        (stage_root / ".market_install.json").write_text(
            json.dumps(install_record, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        if destination.exists() or destination.is_symlink():
            safe_remove(destination)
        stage_root.rename(destination)
    print(f"[ok] installed {package_id} -> {destination}")
