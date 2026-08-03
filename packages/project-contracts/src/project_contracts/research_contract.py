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


class ResearchContractBlockIsNotTemplate(RuntimeError):
    """Raised instead of rewriting a block this module did not just write."""

    def __init__(self, contract: Path) -> None:
        self.contract = contract
        super().__init__(
            f"refusing to rewrite the notebook-sync block in {contract}: it no longer "
            "matches the scaffold template, so it holds content this module did not "
            "write. Nothing was written. Use the refresh entry point, which derives a "
            "block into a separate proposal file and leaves the contract alone."
        )


def _block_text(contract_text: str) -> str:
    """The raw text between the sync markers, or "" when there is no block."""
    if SYNC_START not in contract_text or SYNC_END not in contract_text:
        return ""
    start = contract_text.index(SYNC_START) + len(SYNC_START)
    end = contract_text.index(SYNC_END)
    return contract_text[start:end] if end >= start else ""


def _is_untouched_template_block(contract_text: str) -> bool:
    """Is this block still exactly the one the scaffold template ships?

    This is the whole precondition for writing in place, and it is deliberately
    a comparison against a FIXED KNOWN STRING rather than against a parse. Four
    review rounds were spent on rules that tried to decide, entry by entry,
    which lines in a mature block were machine-derived and which were curated.
    Every one of them was measured deleting real references, because each was a
    text heuristic and a false positive deletes. There is no heuristic here and
    nothing to be wrong about: either the block is byte-for-byte what the
    template ships, in which case there is nothing to lose, or it is not, in
    which case this refuses and the proposal path applies.
    """
    template_block = _block_text(load_scaffold_template(RESEARCH_CONTRACT))
    return _block_text(contract_text).strip() == template_block.strip()


def _derived_block_lines(notebook: Path, notebook_text: str) -> list[str]:
    headings, references = _collect_notebook_sections(notebook_text)
    lines = [
        "- Source notebook: [research_notebook.md](research_notebook.md)",
        f"- Notebook sha256: `{_sha256_file(notebook)}`",
        "",
        "### Notebook sections",
        "",
    ]
    lines.extend(f"- {heading}" for heading in headings) if headings else lines.append(
        f"- {PLACEHOLDER_NO_SECTIONS}"
    )
    lines.extend(["", "### Notebook references", ""])
    lines.extend(references) if references else lines.append(f"- {PLACEHOLDER_NO_REFERENCES}")
    return lines


def _resolve_pair(
    repo_root: Path,
    notebook_path: Path | None,
    contract_path: Path | None,
    project_policy: str | None,
) -> tuple[Path, Path, Path]:
    repo_root = repo_root.expanduser().resolve()
    assert_project_root_allowed(repo_root, project_policy=project_policy)
    notebook = notebook_path.expanduser().resolve() if notebook_path else repo_root / RESEARCH_NOTEBOOK
    contract = contract_path.expanduser().resolve() if contract_path else repo_root / RESEARCH_CONTRACT
    assert_path_allowed(notebook, project_policy=project_policy, label="research notebook")
    assert_path_allowed(contract, project_policy=project_policy, label="research contract")
    assert_path_within_project(notebook, project_root=repo_root, label="research notebook")
    assert_path_within_project(contract, project_root=repo_root, label="research contract")
    if not notebook.is_file():
        raise FileNotFoundError(f"research notebook not found: {notebook}")
    return repo_root, notebook, contract


def sync_research_contract(
    *,
    repo_root: Path,
    notebook_path: Path | None = None,
    contract_path: Path | None = None,
    create_missing: bool,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
) -> dict[str, Any]:
    """Fill the notebook-derived block of a contract this run just created.

    Writes in place ONLY while the block is still byte-for-byte the one the
    scaffold template ships — the state it is in immediately after creation,
    where there is nothing to lose. Any other block is refused.

    That precondition replaces four rounds of rules that tried to decide, line
    by line, which entries in a mature block were machine-derived and which
    were curated. Each was a text heuristic; each was measured deleting real
    references; and the reason is structural, not incidental: a false positive
    there is neither kept nor re-derived, so it simply disappears. Comparing
    against a fixed known string cannot fail that way. For a mature contract,
    derive into a proposal instead — see propose_research_contract_block.
    """
    repo_root, notebook, contract = _resolve_pair(
        repo_root, notebook_path, contract_path, project_policy
    )
    if not contract.exists():
        if not create_missing:
            raise FileNotFoundError(f"research contract not found: {contract}")
        contract.parent.mkdir(parents=True, exist_ok=True)
        contract.write_text(load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8")

    contract_text = contract.read_text(encoding="utf-8", errors="replace")
    if not _is_untouched_template_block(contract_text):
        raise ResearchContractBlockIsNotTemplate(contract)

    notebook_text = notebook.read_text(encoding="utf-8", errors="replace")
    headings, references = _collect_notebook_sections(notebook_text)
    lines = _derived_block_lines(notebook, notebook_text)
    contract.write_text(
        _replace_sync_block(contract_text, "\n".join(lines)).rstrip() + "\n", encoding="utf-8"
    )
    return {
        "contract_path": str(contract),
        "notebook_sha256": _sha256_file(notebook),
        "section_count": len(headings),
        "reference_count": len(references),
    }


def propose_research_contract_block(
    *,
    repo_root: Path,
    notebook_path: Path | None = None,
    contract_path: Path | None = None,
    proposal_path: Path | None = None,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
) -> dict[str, Any]:
    """Derive the block a refresh would produce, and write it somewhere else.

    The contract is never opened for writing. Refreshing a mature contract in
    place was the source of every blocking defect in this area, and they all
    shared one cause: a derived region and a curated region occupying the same
    lines, with no reliable way to tell them apart. Deriving into a separate
    file removes the ambiguity instead of arbitrating it — the reader merges
    what they want, and a blind spot in the scan costs a reading, never a
    bibliography.
    """
    repo_root, notebook, contract = _resolve_pair(
        repo_root, notebook_path, contract_path, project_policy
    )
    proposal = (
        proposal_path.expanduser().resolve()
        if proposal_path
        else repo_root / "artifacts" / "research_contract_block.proposed.md"
    )
    assert_path_allowed(proposal, project_policy=project_policy, label="block proposal")
    assert_path_within_project(proposal, project_root=repo_root, label="block proposal")

    notebook_text = notebook.read_text(encoding="utf-8", errors="replace")
    headings, references = _collect_notebook_sections(notebook_text)
    lines = _derived_block_lines(notebook, notebook_text)
    proposal.parent.mkdir(parents=True, exist_ok=True)
    proposal.write_text(
        "<!-- Derived from research_notebook.md. NOT applied to research_contract.md.\n"
        "     The scan that produced this reads `-`/`*`/`+` and numbered items; it does\n"
        "     not see references written as a table, as running prose, inside a block\n"
        "     quote, or as an HTML list. Merge what is right into the contract's sync\n"
        "     block by hand. -->\n\n" + "\n".join(lines) + "\n",
        encoding="utf-8",
    )
    return {
        "proposal_path": str(proposal),
        "contract_path": str(contract),
        "contract_modified": False,
        "notebook_sha256": _sha256_file(notebook),
        "section_count": len(headings),
        "reference_count": len(references),
    }
