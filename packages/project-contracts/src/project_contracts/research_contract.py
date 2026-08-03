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
    if end < start:
        # Each index was taken independently, so a contract whose END marker
        # precedes its START marker duplicated the span between them on every
        # sync — unbounded growth, and the real block never refreshed.
        raise ValueError(
            "research_contract sync markers are out of order: "
            f"{SYNC_END} precedes {SYNC_START}; fix the markers before syncing"
        )
    return contract_text[:start] + "\n" + block.strip() + "\n" + contract_text[end:]


# WHAT THIS SCAN RECOGNIZES — a deterministic line scanner, not a CommonMark
# parser:
#   * an entry starts at a line whose first non-space characters are "-",
#     "*", "+", or an ordered marker such as "1." / "2)";
#   * any other non-blank line folds into the entry above it, which is where
#     a DOI link on a continuation line survives;
#   * a blank line closes the open entry;
#   * the References section ENDS at any line beginning with "#" — including
#     a "### Errata and corrections" subsection a curator adds, and a lazy
#     continuation line that merely starts with "#".
# Entries written as a table, as running prose, inside a block quote, or as
# an HTML list are not recognized at all. It therefore UNDER-collects, at a
# rate an adversarial review put near 15% over generated notebooks.
#
# WHAT sync_research_contract GUARANTEES, and this is now bounded on purpose:
# a content line inside the block is removed only if the new parse derived a
# line with exactly the same text, or drop_unreproduced was passed. Everything
# else is written back verbatim. The named exceptions, which are the whole of
# them: lines this module itself emits (the source-notebook line, the sha256
# line, its three headings, the retained-list note, and its three placeholder
# strings) are module output and are replaced each sync; and a contract whose
# markers are out of order is refused rather than synced.
#
# Three earlier comments here claimed more than that and each was falsified by
# measurement within one review round: that the scan "cannot lose anything";
# that a judge would refuse whenever it mattered; and that retention made
# matching harmless. The last one failed for a reason worth keeping: retention
# only disarms a false NEGATIVE. A false POSITIVE — a line wrongly judged
# already-derived — is neither retained nor re-derived, so it disappears. That
# is why matching is exact text here and consults no link targets: target-set
# matching treated an erratum as reproduced by the article it corrects, and a
# union over all derived entries let entries absolve each other collectively.
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


SOURCE_LINE = "- Source notebook: [research_notebook.md](research_notebook.md)"
# The key belongs to this module; the value varies (a digest, or the
# template's own placeholder before the first sync).
_SHA_LINE_RE = re.compile(r"^- Notebook sha256: `[^`]*`$")
SECTIONS_HEADING = "### Notebook sections"
REFERENCES_HEADING = "### Notebook references"


def _is_module_structure(line: str) -> bool:
    """Is this line one this module itself emits?

    Matched by EXACT identity, never by shape. An earlier version skipped any
    line starting with "#", "<!--", or "- Source notebook:", which silently
    deleted real content: a sub-heading a curator added to organize the block,
    a reference commented out with a reason, a bibliography entry beginning
    "#1729 internal report", and a notebook reference that genuinely read
    "- Source notebook: [archived scan](...)". Whether a line is this module's
    output is a question about what this module writes, not about how the line
    looks.
    """
    stripped = line.strip()
    return (
        stripped in (SOURCE_LINE, SECTIONS_HEADING, REFERENCES_HEADING, RETAINED_HEADING, RETAINED_NOTE)
        or bool(_SHA_LINE_RE.match(stripped))
        or _entry_body(stripped) in _PLACEHOLDER_BODIES
    )


def _existing_block_lines(contract_text: str) -> list[str]:
    """Every content line currently inside the notebook-sync block, verbatim.

    Verbatim matters: trailing double spaces are a Markdown hard break, and an
    earlier version rstripped them off the lines it wrote back.
    """
    if SYNC_START not in contract_text or SYNC_END not in contract_text:
        return []
    start = contract_text.index(SYNC_START) + len(SYNC_START)
    end = contract_text.index(SYNC_END)
    if end < start:
        return []
    return [
        line
        for line in contract_text[start:end].splitlines()
        if line.strip() and not _is_module_structure(line)
    ]


def _entry_body(entry: str) -> str:
    """The comparable text of a block entry: list marker off, spaces collapsed."""
    body = _ORDERED_ITEM_RE.sub("", entry.strip(), count=1)
    return _normalize_ws(body.lstrip("-*+ "))


def _normalize_ws(text: str) -> str:
    return " ".join(text.split())


def _reproduced(line: str, derived_bodies: set[str]) -> bool:
    """Did the new parse derive a line with exactly this text?

    Link targets are NOT consulted. Two rounds tried to be cleverer than exact
    text and both deleted real references. Matching by target set treated an
    erratum as reproduced by the article it corrects, since they share a DOI;
    taking the union over all derived entries let entries absolve each other
    collectively; and the target regex truncated at the first ")", so two
    Elsevier DOIs differing after "(01)" became one key.

    The deeper reason those failed is that a false POSITIVE here deletes. A
    line judged reproduced is neither retained nor, if the judgement is wrong,
    re-derived — so it simply disappears. Only exact text makes a false
    positive impossible: if some derived line reads the same, nothing is lost
    by dropping this one, whatever it means.
    """
    return _entry_body(line) in derived_bodies


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

    Removes a content line only when the new parse derived a line with exactly
    the same text, or when `drop_unreproduced` is set. See the module comment
    above for the named exceptions and for why matching consults nothing but
    exact text.

    The scan above reads some valid Markdown wrongly, and no text heuristic
    reliably decides whether a vanished entry was deleted on purpose — each one
    tried was measured destroying real references. So nothing decides that
    here: unreproduced lines are written back under RETAINED_HEADING, and a
    scanner blind spot costs a stale line a reader can delete.

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

    # newline="" so the file's own line endings survive the round trip: the
    # default universal-newline translation turns CRLF into LF on READ, which
    # made a CRLF contract come back rewritten in regions this function has no
    # business touching.
    with contract.open(encoding="utf-8", errors="replace", newline="") as handle:
        contract_text = handle.read()
    derived_bodies = {_entry_body(item) for item in (*(f"- {h}" for h in headings), *references)}
    retained = [
        line for line in _existing_block_lines(contract_text) if not _reproduced(line, derived_bodies)
    ]
    if retained and not drop_unreproduced:
        lines.extend(["", RETAINED_HEADING, "", RETAINED_NOTE, ""])
        lines.extend(retained)

    updated = _replace_sync_block(contract_text, "\n".join(lines)).rstrip() + "\n"
    if "\r\n" in contract_text:
        # The contract belongs to the project. Rewriting its line endings edits
        # regions this function has no business touching.
        updated = updated.replace("\r\n", "\n").replace("\n", "\r\n")
    contract.write_text(updated, encoding="utf-8", newline="")
    return {
        "contract_path": str(contract),
        "notebook_sha256": _sha256_file(notebook),
        "section_count": len(headings),
        "reference_count": len(references),
        "retained_entries": [] if drop_unreproduced else retained,
        "dropped_entries": retained if drop_unreproduced else [],
    }
