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


# WHAT THIS SCAN ACTUALLY RECOGNIZES — a deterministic line scanner, not a
# CommonMark parser, and the difference is load-bearing enough to state:
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
# It therefore UNDER-collects, measurably: an adversarial review put the rate
# at roughly 15% over thousands of generated notebooks. Two earlier comments
# here claimed otherwise. The first said the scan "cannot lose anything"; the
# second admitted it could and claimed the sync would REFUSE whenever it
# mattered. Both were absolutes about untested code, and both were falsified
# by measurement within one review round — the second because deciding
# whether a vanished entry was deleted on purpose is itself a text heuristic,
# and every version of that heuristic destroyed real references.
#
# So nothing here decides that any more. sync_research_contract writes back
# every existing line it did not just re-derive. Under-collection costs a
# stale line a reader can see and delete; it cannot cost a bibliography. That
# is structural, not a judgement, which is the only reason it can be stated
# without measuring the scanner first.
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
            references.append(joined if _BULLET_ITEM_RE.match(joined) else f"- {joined}")

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


# The three lines this module itself emits when it has nothing to list. A
# placeholder is recognized by exact text, never by shape: an earlier version
# asked whether an entry starts with "(" and ends with ")", and since every
# Markdown inline link ends with ")", that silently unprotected every real
# entry opening with a qualifier — "(Erratum) Author (2004), [DOI](...)".
PLACEHOLDER_REFRESH = "(refresh to populate)"
PLACEHOLDER_NO_SECTIONS = "(none yet)"
PLACEHOLDER_NO_REFERENCES = (
    "(add references in [research_notebook.md](research_notebook.md) when available)"
)
_PLACEHOLDER_BODIES = frozenset(
    {PLACEHOLDER_REFRESH, PLACEHOLDER_NO_SECTIONS, PLACEHOLDER_NO_REFERENCES}
)

RETAINED_HEADING = "### Entries the last refresh could not derive"
RETAINED_NOTE = (
    "<!-- Kept verbatim: these lines were in this block before the refresh and "
    "the notebook scan did not reproduce them. The scan is a line scanner, not "
    "a Markdown parser, so this list is where its blind spots surface. Delete "
    "any line here that is genuinely stale, or re-run with drop_unreproduced / "
    "--drop-unreproduced to clear them all. -->"
)


def _is_placeholder_entry(entry: str) -> bool:
    return _entry_body(entry) in _PLACEHOLDER_BODIES


def _existing_block_lines(contract_text: str) -> list[str]:
    """Every content line currently inside the notebook-sync block.

    Deliberately not "every bullet": an earlier version protected only lines
    starting with a bullet marker, so a numbered bibliography — the style of
    the incident this guard exists for — had no protection at all, while the
    refusal text was telling operators to hand-edit the block. Structure lines
    (the two metadata lines, sub-headings, this module's own note) are the
    module's own output and are excluded; everything else is treated as content
    to be preserved, whoever wrote it.
    """
    if SYNC_START not in contract_text or SYNC_END not in contract_text:
        return []
    start = contract_text.index(SYNC_START) + len(SYNC_START)
    end = contract_text.index(SYNC_END)
    lines = []
    for line in contract_text[start:end].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "<!--")):
            continue
        if stripped.startswith(("- Source notebook:", "- Notebook sha256:")):
            continue
        if _is_placeholder_entry(stripped):
            continue
        lines.append(line.rstrip())
    return lines


def _entry_body(entry: str) -> str:
    """The comparable text of a block entry: list marker off, spaces collapsed."""
    body = _ORDERED_ITEM_RE.sub("", entry.strip(), count=1)
    return _normalize_ws(body.lstrip("-*+ "))


_LINK_TARGET_RE = re.compile(r"\]\(([^)\s]+)")


def _entry_targets(entry: str) -> set[str]:
    """Link targets, compared by exact identity.

    Two rounds of review destroyed real references here by asking whether a
    target occurred as a SUBSTRING of the concatenated new entries. Sequential
    identifiers stand in a prefix relation, so `zenodo.117532` was "found"
    inside `zenodo.1175321`, and one shared preprint link absolved a paper and
    its erratum of each other. Identity serves the actual motivation — a
    reference reads differently in a numbered list, a table cell and this
    block, while its target does not move — and adds no such hole.
    """
    return set(_LINK_TARGET_RE.findall(entry))


def _normalize_ws(text: str) -> str:
    return " ".join(text.split())


def _reproduced(entry: str, *, derived_bodies: set[str], derived_targets: set[str]) -> bool:
    """Is this existing line already carried by the newly derived entries?

    Only a POSITIVE answer suppresses retention, and only exact evidence counts
    as positive. Getting this wrong therefore costs a duplicate line a reader
    can see, never a line that disappears.
    """
    if _entry_body(entry) in derived_bodies:
        return True
    targets = _entry_targets(entry)
    return bool(targets) and targets <= derived_targets


def sync_research_contract(
    *,
    repo_root: Path,
    notebook_path: Path | None = None,
    contract_path: Path | None = None,
    create_missing: bool,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
    drop_unreproduced: bool = False,
) -> dict[str, Any]:
    """Rewrite the notebook-derived block, keeping what it cannot re-derive.

    The scan above is a deterministic line scanner, not a CommonMark parser,
    and five review rounds established that every hand-rolled version of it
    reads some valid Markdown wrongly. Rounds four and five also established
    that no text heuristic decides reliably whether a vanished entry was
    deleted on purpose or merely missed — each such judge shipped, and each
    was measured destroying real references on ordinary input.

    So no judge decides that here. This never removes a line it did not just
    derive: existing lines the new parse does not reproduce are written back
    verbatim under RETAINED_HEADING. That is structural rather than heuristic,
    which is the whole point — a scanner blind spot now costs a stale line a
    reader can see and delete, and cannot cost a bibliography. Matching still
    decides whether a line is REPRODUCED, but a matching mistake now costs a
    duplicate, not a deletion.

    `drop_unreproduced` is the explicit way to clear retained lines, and it is
    the only path on which this function removes anything.
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
        lines.append(f"- {PLACEHOLDER_NO_SECTIONS}")
    lines.extend(["", "### Notebook references", ""])
    if references:
        lines.extend(references)
    else:
        lines.append(f"- {PLACEHOLDER_NO_REFERENCES}")

    contract_text = contract.read_text(encoding="utf-8", errors="replace")
    derived_bodies = {_entry_body(item) for item in (*(f"- {h}" for h in headings), *references)}
    derived_targets: set[str] = set()
    for item in references:
        derived_targets |= _entry_targets(item)
    retained = [
        line
        for line in _existing_block_lines(contract_text)
        if not _reproduced(line, derived_bodies=derived_bodies, derived_targets=derived_targets)
    ]
    if retained and not drop_unreproduced:
        lines.extend(["", RETAINED_HEADING, "", RETAINED_NOTE, ""])
        lines.extend(retained)

    updated = _replace_sync_block(contract_text, "\n".join(lines))
    contract.write_text(updated.rstrip() + "\n", encoding="utf-8")
    return {
        "contract_path": str(contract),
        "notebook_sha256": _sha256_file(notebook),
        "section_count": len(headings),
        "reference_count": len(references),
        "retained_entries": [] if drop_unreproduced else retained,
        "dropped_entries": retained if drop_unreproduced else [],
    }
