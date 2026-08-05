from __future__ import annotations

import hashlib
import os
import re
import secrets
import stat
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
#     a "### Errata and corrections" subsection a curator adds.
# Entries written as a table, as running prose, inside a block quote, or as
# an HTML list are not recognized at all. It therefore UNDER-collects, at a
# rate an adversarial review put near 15% over generated notebooks.
#
# That is survivable because nothing downstream rewrites curated text on the
# strength of this scan. sync_research_contract replaces the block only while
# the block is byte-for-byte the scaffold template's, and refuses otherwise;
# propose_research_contract_block writes to a separate file and never opens the
# contract for writing. An incomplete scan therefore costs an incomplete
# reading, which a person discards.
#
# Four earlier versions of this comment promised more — that the scan could not
# lose anything, that a judge would refuse whenever it mattered, that retention
# made matching harmless, that a `drop_unreproduced` flag was the only path
# that removed anything. Each was an absolute about untested code and each was
# falsified by measurement within one review round; the flag itself no longer
# exists. The guarantee moved out of this scan entirely, which is the only
# reason anything here can be stated without measuring the scanner first.
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
    # No .strip(). The predicate is named byte-for-byte and the docstring says
    # byte-for-byte; tolerating whitespace made that false, and a claim stronger
    # than its code is the recurring defect of this file. A contract this run
    # just wrote from the template compares exactly, which is the only state the
    # in-place write is for.
    template_block = _block_text(load_scaffold_template(RESEARCH_CONTRACT))
    return _block_text(contract_text) == template_block


def _derived_block_lines(notebook_sha: str, notebook_text: str) -> list[str]:
    headings, references = _collect_notebook_sections(notebook_text)
    lines = [
        "- Source notebook: [research_notebook.md](research_notebook.md)",
        f"- Notebook sha256: `{notebook_sha}`",
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

    # newline="" keeps the file's own line endings, and strict decoding refuses
    # rather than replacing a byte it cannot read: both regions outside the
    # block belong to the project, and rewriting them is not this function's
    # business even when the block itself is still the template's.
    with contract.open(encoding="utf-8", errors="strict", newline="") as handle:
        contract_text = handle.read()
    if not _is_untouched_template_block(contract_text):
        raise ResearchContractBlockIsNotTemplate(contract)

    notebook_text = notebook.read_text(encoding="utf-8", errors="replace")
    notebook_sha = _sha256_file(notebook)
    headings, references = _collect_notebook_sections(notebook_text)
    lines = _derived_block_lines(notebook_sha, notebook_text)
    # Every byte outside the markers is carried through untouched, which is the
    # guarantee that matters: an earlier version normalized the whole file and
    # so rewrote owner-authored regions whenever their endings were mixed.
    #
    # The block itself is written LF, and that is not a choice — the write only
    # runs when the block is byte-for-byte the template's, which is LF, so a
    # CRLF block cannot reach here at all (a CRLF contract is refused, and the
    # proposal path applies to it). A previous comment claimed the block adopted
    # the surrounding ending; the branch that would have done so could not
    # execute, and this file has carried enough comments promising more than the
    # code delivers.
    updated = _replace_sync_block(contract_text, "\n".join(lines))
    _write_file_atomically(contract, updated, newline="")
    return {
        "contract_path": str(contract),
        "notebook_sha256": notebook_sha,
        "section_count": len(headings),
        "reference_count": len(references),
    }


PROPOSAL_SENTINEL = "<!-- Derived from research_notebook.md."
PROPOSAL_HEADER = (
    PROPOSAL_SENTINEL + " NOT applied to research_contract.md.\n"
    "     The scan that produced this reads `-`/`*`/`+` and numbered items; it does\n"
    "     not see references written as a table, as running prose, inside a block\n"
    "     quote, or as an HTML list. Merge what is right into the contract's sync\n"
    "     block by hand. -->\n\n"
)


class ProposalWouldOverwriteProjectFile(RuntimeError):
    """Raised instead of writing a derived block over something the project owns."""

    def __init__(self, proposal: Path, reason: str) -> None:
        self.proposal = proposal
        super().__init__(
            f"refusing to write the derived block to {proposal}: {reason}. Nothing was "
            "written. The proposal is generated output and must go to a path that "
            "holds nothing else — the contract is merged by hand from it."
        )


def _same_file(left: Path, right: Path) -> bool:
    """Same file, by identity rather than by spelling.

    Comparing resolved path strings misses a hardlink — a second name for one
    inode — and misses a case-fold alias on a case-insensitive filesystem. Both
    were demonstrated reaching the contract. `st_dev`/`st_ino` is the question
    actually being asked: is this destination the file the project owns.
    """
    try:
        a, b = left.stat(), right.stat()
    except OSError:
        return left.resolve() == right.resolve()
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def _assert_safe_proposal_destination(proposal: Path, *, contract: Path, notebook: Path) -> None:
    """The destination must not be a file the project already owns.

    Being inside the project root is the wrong question, and answering only
    that let a derived 585-byte block replace a ten-kilobyte curated contract
    through the shipped entry point, exit code zero. Symlinks are why the
    comparison is on RESOLVED paths: a link at the default proposal location
    pointing at the contract needed no unusual argument at all.
    """
    for owned, label in ((contract, "the research contract"), (notebook, "the research notebook")):
        if _same_file(proposal, owned):
            raise ProposalWouldOverwriteProjectFile(proposal, f"that is {label}")
    if proposal.exists():
        if not proposal.is_file():
            raise ProposalWouldOverwriteProjectFile(proposal, "that path is not a regular file")
        try:
            head = proposal.read_text(encoding="utf-8", errors="replace")[: len(PROPOSAL_SENTINEL)]
        except OSError as exc:  # unreadable: refuse rather than clobber
            raise ProposalWouldOverwriteProjectFile(proposal, f"it cannot be read ({exc})") from exc
        if head != PROPOSAL_SENTINEL:
            raise ProposalWouldOverwriteProjectFile(
                proposal, "a file already exists there and is not a previous proposal"
            )


def _carry_extended_attributes(source_fd: int, tmp_name: str, *, parent_fd: int) -> None:
    """Copy what a replaced inode would otherwise drop, beyond its mode.

    What is carried, stated from measurement because three earlier versions of
    this paragraph were written from expectation and each was wrong:

    * On Linux, every attribute `os.listxattr` exposes THAT THIS PROCESS CAN
      READ AND SET. Both exclusions are real and both are silent: a destination
      at mode 0200 lists an attribute whose `getxattr` raises EACCES, and
      `security.*` labels — SELinux contexts, file capabilities — usually raise
      EPERM on the way in for an unprivileged writer. What is carried does
      include `system.posix_acl_access`, so POSIX ACLs ARE carried here.
    * On macOS, nothing: those builds ship no `os.listxattr` at all, so Finder
      tags and resource forks are lost on every replacement.

    Both files are addressed by descriptor, never by path. `os.setxattr` takes
    no `dir_fd`, and `tmp_name` means nothing except against `parent_fd`, so the
    temp file is opened against it; the SOURCE is read through a descriptor for
    the same reason the parent is pinned — reading it by path lets a rename
    between the pin and the read return ENOENT, or worse, return a different
    file whose ACL would then be copied onto the destination.

    This MUST run before the destination's mode is restored, and that ordering
    is load-bearing rather than defensive. The obvious case — a read-only
    destination — is refused earlier, but a file owned by someone else at mode
    0460 in a shared group is not: it passes the writability check because the
    caller is in the group, while the temp file it produces belongs to the
    caller, whose own bits in 0460 are read-only. Attributes carried after that
    chmod would fail EACCES on every one of them, silently.
    """
    if not hasattr(os, "listxattr"):
        return
    try:
        names = os.listxattr(source_fd)
    except OSError:
        return
    if not names:
        return
    try:
        fd = os.open(tmp_name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
    except OSError:
        return
    try:
        for name in names:
            try:
                os.setxattr(fd, name, os.getxattr(source_fd, name))
            except OSError:
                # One attribute that cannot be read or set must not cost the
                # write; content is what is being protected here.
                continue
    finally:
        try:
            os.close(fd)
        except OSError:
            # Closing is bookkeeping for an attribute copy. An EIO here would
            # otherwise propagate into the caller's cleanup and destroy a
            # content write that had already succeeded.
            pass


def _write_file_atomically(target: Path, text: str, *, newline: str | None = None) -> None:
    """Write `target` through a pinned directory and a rename.

    Three separate captures had to be closed here, and each needed a different
    part of this:

    * the write must not re-open the path that was checked, or a symlink
      planted in between captures it — hence the temp file plus `os.replace`;
    * the temp name must be fresh and unshared, or an owner-authored neighbour
      is destroyed and concurrent runs delete each other's file mid-write;
    * and the destination's PARENT must be pinned, or swapping that directory
      for a symlink after validation redirects both the create and the rename
      into somewhere else entirely — a probe replaced an owner's file that way.

    So the destination's IMMEDIATE parent is opened once with O_NOFOLLOW, and
    every later operation is relative to that descriptor.

    The scope of that is worth stating exactly, because an earlier version of
    this paragraph claimed "renaming the directory afterwards cannot move where
    these writes land" and that is false. O_NOFOLLOW constrains only the FINAL
    component of the path being opened; the components above it are still
    walked normally. Swapping a GRANDparent for a symlink mid-run therefore
    still redirects both operations. What is closed is every construction that
    can be built ahead of time — a link anywhere in the chain is collapsed by
    resolve() and then judged by the within-project check — and a swap of the
    immediate parent. What remains is a live race whose winner must already
    hold write permission on a directory inside the project, and could
    therefore overwrite the file directly without any of this.
    """
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    parent_fd = os.open(target.parent, flags)
    try:
        # rename() needs write permission on the DIRECTORY, not on the file it
        # replaces, so it silently overwrites a destination the owner made
        # read-only where the previous open("w") raised. This module refuses
        # rather than clobbers everywhere else; keep that here.
        existing_mode: int | None = None
        source_fd: int | None = None
        try:
            existing = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            existing_mode = stat.S_IMODE(existing.st_mode)
            if not os.access(target.name, os.W_OK, dir_fd=parent_fd, follow_symlinks=False):
                raise PermissionError(
                    f"refusing to replace {target}: it is not writable"
                )
            try:
                source_fd = os.open(
                    target.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd
                )
            except OSError:
                source_fd = None
        tmp_name = f".{target.name}.{os.getpid()}.{secrets.token_hex(8)}.partial"
        create = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(tmp_name, create, 0o644, dir_fd=parent_fd)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline=newline) as handle:
                handle.write(text)
            if source_fd is not None:
                # A replaced inode inherits NOTHING from the one it displaces.
                # Permissions first, because losing those is the consequential
                # one: a contract its owner had chmod'd 0600 came back 0644, a
                # deliberately private file made world-readable with its content
                # byte-perfect — invisible to every content-hash observable, and
                # every test here was one.
                _carry_extended_attributes(source_fd, tmp_name, parent_fd=parent_fd)
            if existing_mode is not None:
                os.chmod(tmp_name, existing_mode, dir_fd=parent_fd)
            os.replace(tmp_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        except BaseException:
            try:
                os.unlink(tmp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            raise
    finally:
        if source_fd is not None:
            try:
                os.close(source_fd)
            except OSError:
                pass
        os.close(parent_fd)


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
        else (repo_root / "artifacts" / "research_contract_block.proposed.md").resolve()
    )
    assert_path_allowed(proposal, project_policy=project_policy, label="block proposal")
    assert_path_within_project(proposal, project_root=repo_root, label="block proposal")
    _assert_safe_proposal_destination(proposal, contract=contract, notebook=notebook)

    notebook_text = notebook.read_text(encoding="utf-8", errors="replace")
    notebook_sha = _sha256_file(notebook)
    headings, references = _collect_notebook_sections(notebook_text)
    lines = _derived_block_lines(notebook_sha, notebook_text)
    contract_before = _sha256_file(contract) if contract.is_file() else None
    proposal.parent.mkdir(parents=True, exist_ok=True)
    _write_file_atomically(proposal, PROPOSAL_HEADER + "\n".join(lines) + "\n")
    contract_after = _sha256_file(contract) if contract.is_file() else None
    return {
        "proposal_path": str(proposal),
        "contract_path": str(contract),
        # Observed, not asserted: an earlier version returned a hardcoded False
        # here, so the one field that would have reported the destination bug
        # was a constant, and the test asserting it could not fail.
        "contract_modified": contract_before != contract_after,
        "notebook_sha256": notebook_sha,
        "section_count": len(headings),
        "reference_count": len(references),
    }
