from __future__ import annotations

import pathlib
import re

NOTE_START = "<!-- skills-market:python-runtime-note start -->"
NOTE_END = "<!-- skills-market:python-runtime-note end -->"
NOTE_BLOCK_RE = re.compile(
    rf"{re.escape(NOTE_START)}.*?{re.escape(NOTE_END)}\n*",
    re.DOTALL,
)


def build_python_runtime_note(venv_python: str) -> str:
    return (
        f"{NOTE_START}\n"
        "> Runtime note: this installed skill includes a skill-local Python environment. "
        f"Prefer `{venv_python}` when invoking bundled Python scripts from this skill directory. "
        "See `.market_install.json` for the recorded runtime details.\n"
        f"{NOTE_END}\n\n"
    )


def _split_frontmatter(text: str) -> tuple[str, str]:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return "", text
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "".join(lines[: idx + 1]), "".join(lines[idx + 1 :])
    return "", text


def inject_python_runtime_note(skill_md_path: pathlib.Path, venv_python: str) -> None:
    original = skill_md_path.read_text(encoding="utf-8")
    cleaned = NOTE_BLOCK_RE.sub("", original)
    frontmatter, remainder = _split_frontmatter(cleaned)
    note = build_python_runtime_note(venv_python)
    if frontmatter:
        separator = "\n" if remainder and not remainder.startswith("\n") else ""
        updated = f"{frontmatter}\n{note}{separator}{remainder}"
    else:
        updated = f"{note}{remainder}"
    skill_md_path.write_text(updated, encoding="utf-8")
