from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .project_policy import (
    PROJECT_POLICY_REAL_PROJECT,
    assert_path_allowed,
    assert_path_within_project,
    assert_project_root_allowed,
)
from .project_surface import RESEARCH_CONTRACT, RESEARCH_NOTEBOOK
from .scaffold_template_loader import load_scaffold_template


SYNC_START = "<!-- RESEARCH_NOTEBOOK_SYNC_START -->"
SYNC_END = "<!-- RESEARCH_NOTEBOOK_SYNC_END -->"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _replace_sync_block(contract_text: str, block: str) -> str:
    if SYNC_START not in contract_text or SYNC_END not in contract_text:
        raise ValueError("research_contract template is missing notebook sync markers")
    start = contract_text.index(SYNC_START) + len(SYNC_START)
    end = contract_text.index(SYNC_END)
    return contract_text[:start] + "\n" + block.strip() + "\n" + contract_text[end:]


# A reference item may open with a bullet OR an ordered marker ("1.", "2)"),
# and academic entries routinely carry the DOI link on a continuation line.
# Recognizing only bullets, and only their first line, made a numbered
# bibliography look like NO references at all — which then replaced real
# entries with the "(add references ...)" placeholder.
#
# DELIBERATELY NAIVE, and the naivety is the safety property. Three review
# rounds of a cleverer collector (fence tracking, indentation comparison,
# indented-code detection) each shipped a new way to LOSE a real reference:
# a shorter fence run closing a longer block, a tab-indented annotation
# absorbing the entry after it, an indented sub-item of a loose list being
# read as code. Hand-rolling CommonMark is how that happens, and this
# package must stay dependency-light, so it does not try.
#
# What is left cannot lose anything: every item line opens an entry, every
# other non-blank line folds into the open one. When it is wrong it is wrong
# by ADDING an entry (a fenced example, a nested annotation listed
# separately), never by dropping one — and a spurious entry is visible in
# the block a human reads, while a dropped reference is not.
_ORDERED_ITEM_RE = re.compile(r"^\d+[.)]\s+")
_BULLET_ITEM_RE = re.compile(r"^[-*]\s+")


def _collect_notebook_sections(notebook_text: str) -> tuple[list[str], list[str]]:
    headings: list[str] = []
    references: list[str] = []
    in_references = False
    current: list[str] = []

    def _flush() -> None:
        if not current:
            return
        joined = " ".join(part for part in current if part)
        current.clear()
        if joined:
            references.append(joined if joined.startswith(("- ", "* ")) else f"- {joined}")

    for line in notebook_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            _flush()
            if stripped.startswith("## References"):
                in_references = True
                continue
            in_references = False
            if stripped.startswith("## "):
                headings.append(stripped[3:].strip())
            continue
        if not in_references:
            continue
        if not stripped:
            _flush()
            continue
        if _BULLET_ITEM_RE.match(stripped) or _ORDERED_ITEM_RE.match(stripped):
            _flush()
            current.append(
                _ORDERED_ITEM_RE.sub("", stripped, count=1)
                if _ORDERED_ITEM_RE.match(stripped)
                else stripped
            )
        elif current:
            # Continuation of the open item — where the DOI link usually is.
            current.append(stripped)
    _flush()
    # No truncation: a silent cap dropped every section past the eighth from a
    # project with sixteen of them. A derived block lists what the notebook
    # actually has.
    return headings, references


def _existing_block_entries(contract_text: str) -> list[str]:
    """Bullet entries currently inside the notebook-sync block, if any."""
    if SYNC_START not in contract_text or SYNC_END not in contract_text:
        return []
    start = contract_text.index(SYNC_START) + len(SYNC_START)
    end = contract_text.index(SYNC_END)
    entries = []
    for line in contract_text[start:end].splitlines():
        stripped = line.strip()
        if stripped.startswith(("- ", "* ")) and not stripped.startswith("- Source notebook:"):
            if not stripped.startswith("- Notebook sha256:"):
                entries.append(stripped)
    return entries


def _dropped_block_entries(
    contract_text: str, *, headings: list[str], references: list[str]
) -> list[str]:
    """Entries the incoming derived block would remove from the existing one.

    Placeholder lines count as removals of everything they replace: the
    reported incident swapped three real DOI references for one placeholder.
    """
    previous = _existing_block_entries(contract_text)
    if not previous:
        return []
    incoming = {f"- {heading}" for heading in headings} | set(references)
    return [entry for entry in previous if entry not in incoming]


def sync_research_contract(
    *,
    repo_root: Path,
    notebook_path: Path | None = None,
    contract_path: Path | None = None,
    create_missing: bool,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
) -> dict[str, Any]:
    repo_root = repo_root.expanduser().resolve()
    assert_project_root_allowed(repo_root, project_policy=project_policy)

    notebook = (notebook_path.expanduser().resolve() if notebook_path else repo_root / RESEARCH_NOTEBOOK)
    contract = (contract_path.expanduser().resolve() if contract_path else repo_root / RESEARCH_CONTRACT)
    assert_path_allowed(notebook, project_policy=project_policy, label="research notebook")
    assert_path_allowed(contract, project_policy=project_policy, label="research contract")
    assert_path_within_project(notebook, project_root=repo_root, label="research notebook")
    assert_path_within_project(contract, project_root=repo_root, label="research contract")
    if not notebook.is_file():
        raise FileNotFoundError(f"research notebook not found: {notebook}")
    if not contract.exists():
        if not create_missing:
            raise FileNotFoundError(f"research contract not found: {contract}")
        contract.parent.mkdir(parents=True, exist_ok=True)
        contract.write_text(load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8")

    notebook_text = notebook.read_text(encoding="utf-8", errors="replace")
    headings, references = _collect_notebook_sections(notebook_text)
    lines = [
        "- Source notebook: [research_notebook.md](research_notebook.md)",
        f"- Notebook sha256: `{_sha256_file(notebook)}`",
        "",
        "### Notebook sections",
        "",
    ]
    if headings:
        lines.extend(f"- {heading}" for heading in headings)
    else:
        lines.append("- (none yet)")
    lines.extend(["", "### Notebook references", ""])
    if references:
        lines.extend(references)
    else:
        lines.append("- (add references in [research_notebook.md](research_notebook.md) when available)")

    contract_text = contract.read_text(encoding="utf-8", errors="replace")
    # A derived block that shrinks is legitimate (the notebook lost a section)
    # but must never be silent: this sync once replaced curated entries with
    # placeholders and nobody was told. Report what leaves the block so the
    # caller can surface it before the write becomes the only record.
    dropped = _dropped_block_entries(contract_text, headings=headings, references=references)
    updated = _replace_sync_block(contract_text, "\n".join(lines))
    contract.write_text(updated.rstrip() + "\n", encoding="utf-8")
    return {
        "contract_path": str(contract),
        "notebook_sha256": _sha256_file(notebook),
        "section_count": len(headings),
        "reference_count": len(references),
        "dropped_entries": dropped,
    }
