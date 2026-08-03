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


# WHAT THIS COLLECTOR ACTUALLY RECOGNIZES — a deterministic line scanner,
# not a CommonMark parser, and the difference is load-bearing enough to
# state exactly:
#   * an entry starts at a line whose first non-space characters are "-",
#     "*", "+", or an ordered marker such as "1." / "2)";
#   * any other non-blank line folds into the entry above it, which is where
#     a DOI link on a continuation line survives;
#   * a blank line closes the open entry;
#   * the References section ENDS at any line beginning with "#" — including
#     a "### Primary sources" subsection, a "# comment" inside a fenced
#     example, and a lazy continuation line that merely starts with "#".
# Entries written as a table, as running prose, inside a block quote, or as
# an HTML list are not recognized at all.
#
# So it can UNDER-collect, and an adversarial review measured that on
# thousands of generated notebooks. An earlier version of this comment
# claimed it "cannot lose anything"; that claim was false, and asserting it
# was worse than the gap itself, because it invited the next maintainer to
# skip the guard below.
#
# The guarantee lives in sync_research_contract instead, where it can
# actually hold: a sync that would drop entries the block already carries
# REFUSES TO WRITE. Under-collection therefore costs a refusal and a
# diagnostic, never a curated bibliography. Four rounds of a cleverer
# parser each shipped a new way to lose data; moving the guarantee off the
# parser is what ends that.
_ORDERED_ITEM_RE = re.compile(r"^\d+[.)]\s+")
_BULLET_ITEM_RE = re.compile(r"^[-*+]\s+")


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


class ResearchContractSyncWouldLoseEntries(RuntimeError):
    """Raised instead of writing a block that drops existing entries."""

    def __init__(self, contract: Path, dropped: list[str]) -> None:
        self.contract = contract
        self.dropped = dropped
        listed = "\n".join(f"  {entry}" for entry in dropped)
        super().__init__(
            f"refusing to sync {contract}: the derived block would drop "
            f"{len(dropped)} existing entr{'y' if len(dropped) == 1 else 'ies'} "
            f"that the notebook parse did not reproduce:\n{listed}\n"
            "Nothing was written. Either the notebook really lost that content "
            "(then pass allow_entry_loss / --allow-entry-loss to confirm), or "
            "the notebook uses a Markdown shape this deterministic collector "
            "does not recognize — in which case editing the block by hand is "
            "correct and the sync must not overwrite it."
        )


def _is_placeholder_entry(entry: str) -> bool:
    """A template/placeholder line is not curated content: dropping it is
    not a loss, so a freshly created contract can still be synced."""
    body = entry.lstrip("-*+ ").strip()
    return body.startswith("(") and body.endswith(")")


def _existing_block_entries(contract_text: str) -> list[str]:
    """Curated bullet entries currently inside the notebook-sync block."""
    if SYNC_START not in contract_text or SYNC_END not in contract_text:
        return []
    start = contract_text.index(SYNC_START) + len(SYNC_START)
    end = contract_text.index(SYNC_END)
    entries = []
    for line in contract_text[start:end].splitlines():
        stripped = line.strip()
        if not stripped.startswith(("- ", "* ", "+ ")):
            continue
        if stripped.startswith(("- Source notebook:", "- Notebook sha256:")):
            continue
        if _is_placeholder_entry(stripped):
            continue
        entries.append(stripped)
    return entries


def _entry_body(entry: str) -> str:
    """The comparable text of a block entry: bullet marker off, spaces collapsed."""
    return _normalize_ws(entry.lstrip("-*+ "))


_LINK_TARGET_RE = re.compile(r"\]\(([^)\s]+)")


def _entry_tokens(entry: str) -> list[str]:
    """What identifies an entry across reformatting.

    Comparing whole entry text is too brittle: a bibliography line reads
    differently in a numbered list, in a table cell and in the derived block,
    while its link target stays put. So a linked entry is identified by its
    targets and an unlinked one — a section heading, typically — by its text.
    """
    targets = _LINK_TARGET_RE.findall(entry)
    return targets or [_entry_body(entry)]


def _normalize_ws(text: str) -> str:
    return " ".join(text.split())


def _removed_and_unreproduced(
    contract_text: str,
    *,
    headings: list[str],
    references: list[str],
    notebook_text: str,
) -> tuple[list[str], list[str]]:
    """Split what a sync would take out of the block into its two meanings.

    `removed` is everything the re-derived block no longer lists, for any
    reason — informational, and the normal outcome when a notebook section is
    deleted on purpose. `unreproduced` is the subset whose text is STILL in the
    notebook, which can only mean the collector failed to see it. Only the
    second one is a reason to refuse: the first is the sync doing its job.
    """
    # Compare on the entry body: the collector emits items already carrying a
    # bullet marker, and the block is written with one, so comparing raw lines
    # would depend on how many markers each side happens to have.
    derived_items = (*headings, *references)
    derived_bodies = {_entry_body(item) for item in derived_items}
    derived_blob = _normalize_ws(" ".join(derived_items))
    notebook_norm = _normalize_ws(notebook_text)
    removed: list[str] = []
    unreproduced: list[str] = []
    for entry in _existing_block_entries(contract_text):
        if _entry_body(entry) in derived_bodies or _is_placeholder_entry(entry):
            continue
        tokens = [token for token in _entry_tokens(entry) if token]
        if any(token in derived_blob for token in tokens):
            # Same source, written differently by the new parse. Not a loss.
            continue
        removed.append(entry)
        if any(token in notebook_norm for token in tokens):
            unreproduced.append(entry)
    return removed, unreproduced


def sync_research_contract(
    *,
    repo_root: Path,
    notebook_path: Path | None = None,
    contract_path: Path | None = None,
    create_missing: bool,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
    allow_entry_loss: bool = False,
) -> dict[str, Any]:
    """Rewrite the notebook-derived block, refusing to lose curated entries.

    The collector below is a deterministic line scanner, not a CommonMark
    parser, and four review rounds established that every hand-rolled
    version of it has some Markdown shape it reads wrongly. That is
    survivable only because parser accuracy is NOT load-bearing here: if the
    parse comes back with fewer entries than the block already holds, this
    refuses to write and says so. A collector bug therefore costs a refusal
    and a diagnostic, never a curated bibliography — which is exactly what
    the incident behind this guard destroyed.
    """
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
    # placeholders and nobody was told. Report what leaves the block, and stop
    # outright when what leaves is still sitting in the notebook.
    removed, unreproduced = _removed_and_unreproduced(
        contract_text, headings=headings, references=references, notebook_text=notebook_text
    )
    if unreproduced and not allow_entry_loss:
        raise ResearchContractSyncWouldLoseEntries(contract, unreproduced)
    updated = _replace_sync_block(contract_text, "\n".join(lines))
    contract.write_text(updated.rstrip() + "\n", encoding="utf-8")
    return {
        "contract_path": str(contract),
        "notebook_sha256": _sha256_file(notebook),
        "section_count": len(headings),
        "reference_count": len(references),
        "removed_entries": removed,
        "unreproduced_entries": unreproduced,
    }
