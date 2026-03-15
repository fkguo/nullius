from __future__ import annotations

from pathlib import Path


def scaffold_template_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "scaffold_templates"


def load_scaffold_template(name: str) -> str:
    path = scaffold_template_dir() / name
    if not path.is_file():
        raise FileNotFoundError(f"scaffold template not found: {path}")
    return path.read_text(encoding="utf-8")
