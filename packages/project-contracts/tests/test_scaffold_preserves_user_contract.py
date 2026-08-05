"""`init` never rewrites a user-owned research contract, and the notebook
sync never loses content silently.

Reported from a live project (decision D37): running ``nullius init`` on a
mature project — to declare a mode, with every seed file already present —
rewrote the notebook-sync block inside the user-owned research_contract.md,
deleting curated section entries and replacing verified DOI references with
the "(add references ...)" placeholder. The mutation was restored byte-for-
byte from committed HEAD and the project's goal was formally blocked until
the mutation path was eliminated.

Three independent mechanisms produced that single loss:
  1. plain init ran the notebook->contract sync unconditionally, including
     over a contract it had NOT created;
  2. the section collector truncated at eight entries, so a project with
     more than eight sections lost the rest;
  3. the reference collector recognized only "- "/"* " bullets on a single
     line, so a numbered bibliography whose DOI links sit on continuation
     lines parsed as NO references at all — and an empty parse writes the
     placeholder over real entries.
"""

import sys
import hashlib
import os
import stat
import tempfile
from unittest import mock
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_scaffold import ensure_project_scaffold  # noqa: E402
from project_contracts.project_policy import PROJECT_POLICY_REAL_PROJECT  # noqa: E402
from project_contracts.scaffold_template_loader import load_scaffold_template  # noqa: E402
from project_contracts.project_surface import RESEARCH_CONTRACT  # noqa: E402
from project_contracts import research_contract  # noqa: E402
from project_contracts.research_contract import (
    PROPOSAL_SENTINEL,
    ProposalWouldOverwriteProjectFile,
    _block_text,
    ResearchContractBlockIsNotTemplate,
    propose_research_contract_block,
    _collect_notebook_sections,
    sync_research_contract,
)


CURATED_CONTRACT = """# Research contract

## Notebook sync

<!-- RESEARCH_NOTEBOOK_SYNC_START -->
- Source notebook: [research_notebook.md](research_notebook.md)
- Notebook sha256: `deadbeef`

### Notebook sections

- Scope and question
- Source coverage
- Correction chain
- Verified baseline problem
- Baseline results at printed precision
- Continuation and the defining equation
- Adjacent-branch results
- Bounded conclusion
- Reusable production operations
- Remaining work

### Notebook references

- Author A and Author B (2001), [DOI](https://doi.org/10.1000/example-a)
- Author A, Author B, and Author C (2002), [DOI](https://doi.org/10.1000/example-b)
- Author A (2003), [DOI](https://doi.org/10.1000/example-c)
<!-- RESEARCH_NOTEBOOK_SYNC_END -->

## Owner-authored acceptance criteria

- The bounded result closes the milestone.
"""

# A numbered bibliography whose DOI link sits on a continuation line: the
# style that parsed as zero references.
NUMBERED_REFERENCE_NOTEBOOK = """# Research notebook

## Scientific question and present scope

Text.

## Primary sources and reading coverage

Text.

## References

1. E. Author, K. Second, and T. Third,
   ["First study," *Journal of Examples* **17**, 3090 (2001)](https://doi.org/10.1000/example-a).

2. E. Author and K. Second,
   ["Second study," *Journal of Examples* **21**, 203 (2002)](https://doi.org/10.1000/example-b).
"""


def _mature_project(root: Path) -> None:
    """A project whose seed files all exist, as on any real re-init."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "research_contract.md").write_text(CURATED_CONTRACT, encoding="utf-8")
    (root / "research_notebook.md").write_text(NUMBERED_REFERENCE_NOTEBOOK, encoding="utf-8")
    for name in ("project_charter.md", "project_index.md", "research_plan.md", "AGENTS.md", ".gitignore"):
        (root / name).write_text(f"# owner-authored {name}\n", encoding="utf-8")
    reports = root / "reports"
    reports.mkdir(exist_ok=True)
    (reports / "main_research_report_template.md").write_text("# owner-authored report\n", encoding="utf-8")


class InitPreservesUserContractTest(unittest.TestCase):
    def test_init_on_mature_project_leaves_contract_byte_identical(self):
        # The D37 guarantee: an init over an existing project mutates nothing
        # the project owns. Byte-for-byte, because the reported loss was a
        # rewrite *inside* a file that kept its name and its outer structure.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            before = {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path in sorted(root.rglob("*"))
                if path.is_file()
            }

            ensure_project_scaffold(
                repo_root=root,
                project_name="Mature Project",
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )

            after = {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path in sorted(root.rglob("*"))
                if path.is_file()
            }
            self.assertEqual(
                before["research_contract.md"],
                after["research_contract.md"],
                "init rewrote the user-owned research contract",
            )
            for rel, blob in before.items():
                self.assertEqual(blob, after.get(rel), f"init mutated pre-existing {rel}")

    def test_init_still_syncs_a_contract_it_just_created(self):
        # The sync is not removed, only bound to a contract this init wrote:
        # a fresh project still gets its notebook-derived block.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "fresh"
            root.mkdir(parents=True)
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Fresh Project",
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )
            self.assertIn("research_contract.md", result["created"])
            self.assertIsNotNone(result["contract_sync"])
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            self.assertIn("Notebook sha256", contract)

    def test_init_reports_no_sync_when_contract_pre_exists(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Mature Project",
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )
            self.assertIn("research_contract.md", result["skipped"])
            self.assertIsNone(result["contract_sync"])


class NotebookSectionCollectorTest(unittest.TestCase):
    def test_sections_are_not_truncated(self):
        notebook = "# Notebook\n\n" + "\n\n".join(
            f"## Section {i}\n\nBody." for i in range(1, 17)
        )
        headings, _ = _collect_notebook_sections(notebook)
        self.assertEqual(len(headings), 16, "section list was silently truncated")
        self.assertEqual(headings[-1], "Section 16")

    def test_numbered_references_with_continuation_lines_are_collected(self):
        _, references = _collect_notebook_sections(NUMBERED_REFERENCE_NOTEBOOK)
        self.assertEqual(len(references), 2, f"numbered bibliography parsed as {references}")
        self.assertTrue(all(ref.startswith("- ") for ref in references))
        # The DOI lives on the continuation line and must survive.
        self.assertIn("10.1000/example-a", references[0])
        self.assertIn("10.1000/example-b", references[1])

    def test_bullet_references_still_supported(self):
        notebook = (
            "# Notebook\n\n## Scope\n\nText.\n\n## References\n\n"
            "- Author (1978), [DOI](https://doi.org/10.1000/a)\n"
            "* Author (1980), [DOI](https://doi.org/10.1000/b)\n"
        )
        _, references = _collect_notebook_sections(notebook)
        self.assertEqual(len(references), 2)
        self.assertIn("10.1000/a", references[0])
        self.assertIn("10.1000/b", references[1])

    def test_collector_handles_these_six_layouts_without_loss(self):
        """Six layouts, each of which broke one attempt at a cleverer
        parser: a shorter fence run closing a longer block, a tab-indented
        annotation absorbing the entry after it, an indented sub-item of a
        loose list read as code.

        This proves those six cases and nothing more — the collector is a
        line scanner and DOES under-collect on shapes it cannot see (tables,
        prose bibliographies, "#"-prefixed lines inside the section). The
        guarantee that under-collection cannot destroy content lives in
        test_a_table_shaped_bibliography_is_kept_not_dropped, not here."""
        layouts = {
            "loose list with a nested item": (
                "# NB\n\n## References\n\n- Ref A\n\n    - Ref B\n\n- Ref C\n",
                ("Ref A", "Ref B", "Ref C"),
            ),
            "grouped bibliography": (
                "# NB\n\n## References\n\n- Primary sources:\n\n    - Ref A\n    - Ref B\n",
                ("Ref A", "Ref B"),
            ),
            "tab-indented annotation": (
                "# NB\n\n## References\n\n  - Ref A\n\t- annotation\n  - Ref B\n",
                ("Ref A", "Ref B"),
            ),
            "longer fence containing a shorter run": (
                "# NB\n\n## References\n\n1. Ref A\n\n````\n```\n- fenced\n````\n\n2. Ref B\n",
                ("Ref A", "Ref B"),
            ),
            "indented fence line": (
                "# NB\n\n## References\n\n- Ref A\n    ```\n- Ref B\n",
                ("Ref A", "Ref B"),
            ),
            "info-string fence with a trailing-text line": (
                "# NB\n\n## References\n\n1. Ref A\n\n```python\n``` not-a-closer\n```\n\n2. Ref B\n",
                ("Ref A", "Ref B"),
            ),
        }
        for label, (notebook, must_survive) in layouts.items():
            _, references = _collect_notebook_sections(notebook)
            blob = " || ".join(references)
            for needle in must_survive:
                self.assertIn(needle, blob, f"{label}: lost {needle!r} from {references}")

    def test_references_stop_at_the_next_heading(self):
        notebook = (
            "# Notebook\n\n## References\n\n"
            "1. Author, [DOI](https://doi.org/10.1000/a)\n\n"
            "## Appendix\n\n- not a reference\n"
        )
        headings, references = _collect_notebook_sections(notebook)
        self.assertEqual(len(references), 1)
        self.assertIn("Appendix", headings)


def _project_with(root: Path, contract_entries: list[str], notebook_references: str) -> None:
    """A project whose block already holds `contract_entries`, paired with a
    notebook whose References section is written as `notebook_references`."""
    root.mkdir(parents=True, exist_ok=True)
    block = "\n".join(
        [
            "<!-- RESEARCH_NOTEBOOK_SYNC_START -->",
            "- Source notebook: [research_notebook.md](research_notebook.md)",
            "- Notebook sha256: `deadbeef`",
            "",
            "### Notebook sections",
            "",
            "- Scope",
            "",
            "### Notebook references",
            "",
            *contract_entries,
            "<!-- RESEARCH_NOTEBOOK_SYNC_END -->",
        ]
    )
    (root / "research_contract.md").write_text(
        f"# Research contract\n\n## Notebook sync\n\n{block}\n\n## Owner section\n\n- Owned.\n",
        encoding="utf-8",
    )
    (root / "research_notebook.md").write_text(
        f"# Research notebook\n\n## Scope\n\nText.\n\n## References\n\n{notebook_references}",
        encoding="utf-8",
    )


def _project_digest(root: Path) -> dict[str, str]:
    """sha256 of every file in the project — the observable for "nothing the
    project owns changed", which no path-shaped check can stand in for."""
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }


def _project_modes(root: Path) -> dict[str, int]:
    """Permission bits of every project file.

    A SECOND observable, deliberately not a content hash. Every other test here
    compares bytes, and a whole class of damage is invisible to that: replacing
    an inode by rename does not carry the old one's mode, so a contract its
    owner had made private came back world-readable with its content perfectly
    intact. However many byte-comparing tests were added, none of them could
    have seen it.
    """
    return {
        path.relative_to(root).as_posix(): stat.S_IMODE(path.stat().st_mode)
        for path in sorted(root.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }


def _sync(root: Path, **kwargs):
    return sync_research_contract(
        repo_root=root, create_missing=False, project_policy=PROJECT_POLICY_REAL_PROJECT, **kwargs
    )


class MatureContractIsNeverRewrittenTest(unittest.TestCase):
    """The decomposition that ended four rounds of blocking defects.

    Every one of those defects came from a derived region and a curated region
    sharing the same lines, arbitrated by a text heuristic. None of the
    heuristics survived measurement, and they could not: a false positive there
    is neither kept nor re-derived, so it disappears. The two regions are now
    separated instead — in-place writing is allowed only while the block is
    still exactly the template's, and a mature contract gets a proposal file.
    """

    def test_sync_fills_a_freshly_created_block(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            root.mkdir(parents=True)
            (root / "research_contract.md").write_text(
                load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8"
            )
            (root / "research_notebook.md").write_text(
                "# N\n\n## Scope\n\nT.\n\n## References\n\n- A, [DOI](https://ex.org/a)\n",
                encoding="utf-8",
            )
            result = _sync(root)
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            self.assertEqual(result["reference_count"], 1)
            self.assertIn("- Scope", contract)
            self.assertNotIn("(refresh to populate)", contract)

    def test_sync_refuses_a_block_that_is_no_longer_the_template(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            before = (root / "research_contract.md").read_bytes()
            with self.assertRaises(ResearchContractBlockIsNotTemplate):
                _sync(root)
            self.assertEqual(before, (root / "research_contract.md").read_bytes())

    def test_proposal_leaves_the_contract_byte_identical(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            before = (root / "research_contract.md").read_bytes()
            result = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            self.assertFalse(result["contract_modified"])
            self.assertEqual(before, (root / "research_contract.md").read_bytes())
            proposal = Path(result["proposal_path"]).read_text(encoding="utf-8")
            self.assertIn("NOT applied to research_contract.md", proposal)
            self.assertIn("- Scientific question and present scope", proposal)

    def test_a_shape_the_scan_cannot_read_costs_a_reading_not_a_bibliography(self):
        # A table-shaped bibliography: the scan sees none of it. Under every
        # earlier design this cost the curated entries; now it costs an
        # incomplete proposal file that a reader can simply ignore.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            (root / "research_notebook.md").write_text(
                "# N\n\n## Scope\n\nT.\n\n## References\n\n"
                "| Source | Link |\n| --- | --- |\n"
                "| Author A (2001) | [DOI](https://doi.org/10.1000/example-a) |\n",
                encoding="utf-8",
            )
            before = (root / "research_contract.md").read_bytes()
            result = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            self.assertEqual(result["reference_count"], 0)
            self.assertEqual(before, (root / "research_contract.md").read_bytes())

    def test_the_proposal_never_overwrites_a_file_the_project_owns(self):
        # The observable is "did any pre-existing project file change", not "was
        # the path outside the project root". The earlier test asked the second
        # question, which is the same question assert_path_within_project asks,
        # so it could only confirm that check exists — and every destination in
        # this test is INSIDE the project, where the damage was.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            (root / "artifacts").mkdir()
            (root / "artifacts" / "someone_elses.md").write_text("owned\n", encoding="utf-8")
            link = root / "artifacts" / "research_contract_block.proposed.md"

            destinations = [
                ("the contract itself", root / "research_contract.md", None),
                ("the notebook", root / "research_notebook.md", None),
                ("an unrelated existing file", root / "artifacts" / "someone_elses.md", None),
                ("a symlink at the default location", None, link),
            ]
            for label, dest, symlink in destinations:
                with self.subTest(destination=label):
                    if symlink is not None:
                        symlink.unlink(missing_ok=True)
                        symlink.symlink_to(Path("..") / "research_contract.md")
                    before = _project_digest(root)
                    with self.assertRaises(ProposalWouldOverwriteProjectFile):
                        propose_research_contract_block(
                            repo_root=root,
                            proposal_path=dest,
                            project_policy=PROJECT_POLICY_REAL_PROJECT,
                        )
                    self.assertEqual(before, _project_digest(root), f"{label}: a file changed")
            link.unlink(missing_ok=True)

    def test_an_alias_of_the_contract_is_recognized_as_the_contract(self):
        # A hardlink is a second NAME for one inode, so comparing resolved path
        # strings misses it — and the file it aliases was the contract. The
        # question the guard has to ask is identity, not spelling. The alias
        # also carries this tool's own header, which is the one thing that
        # otherwise makes an existing destination replaceable.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            (root / "artifacts").mkdir()
            contract = root / "research_contract.md"
            contract.write_text(
                PROPOSAL_SENTINEL + " pasted while merging -->\n"
                + contract.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            alias = root / "artifacts" / "research_contract_block.proposed.md"
            os.link(contract, alias)

            before = _project_digest(root)
            with self.assertRaises(ProposalWouldOverwriteProjectFile):
                propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertEqual(before, _project_digest(root))

    def test_a_case_variant_of_the_contract_is_recognized_as_the_contract(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            variant = root / "RESEARCH_CONTRACT.MD"
            if not variant.exists():
                self.skipTest("case-sensitive filesystem: no alias to recognize")
            before = _project_digest(root)
            with self.assertRaises(ProposalWouldOverwriteProjectFile):
                propose_research_contract_block(
                    repo_root=root,
                    proposal_path=variant,
                    project_policy=PROJECT_POLICY_REAL_PROJECT,
                )
            self.assertEqual(before, _project_digest(root))

    def test_the_proposal_still_escapes_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            with self.assertRaises(ValueError):
                propose_research_contract_block(
                    repo_root=root,
                    proposal_path=Path(td) / "outside.md",
                    project_policy=PROJECT_POLICY_REAL_PROJECT,
                )

    def test_a_previous_proposal_is_the_one_thing_it_may_replace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            again = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            self.assertEqual(first["proposal_path"], again["proposal_path"])
            self.assertFalse(again["contract_modified"])

    def test_contract_modified_is_observed_and_not_a_constant(self):
        # A previous version returned a hardcoded False here, and the test that
        # asserted it could not fail in any circumstance. Reverting the field to
        # a literal must break this: the contract really does change during the
        # call, and the receipt has to say so.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            contract = root / "research_contract.md"
            real_write = research_contract._write_file_atomically

            def write_and_disturb(proposal, text, **kwargs):
                real_write(proposal, text, **kwargs)
                contract.write_text("disturbed\n", encoding="utf-8")

            with mock.patch.object(
                research_contract, "_write_file_atomically", write_and_disturb
            ):
                result = propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertTrue(result["contract_modified"])

    def test_the_notebook_digest_is_taken_once(self):
        # The receipt's digest and the one embedded in the proposal must be the
        # same reading: an earlier version hashed the notebook twice, so a
        # concurrent edit made the receipt disagree with the block beside it.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            calls = []
            real_sha = research_contract._sha256_file

            def counting_sha(path):
                calls.append(Path(path).name)
                return real_sha(path)

            with mock.patch.object(research_contract, "_sha256_file", counting_sha):
                result = propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertEqual(calls.count("research_notebook.md"), 1)
            proposal = Path(result["proposal_path"]).read_text(encoding="utf-8")
            self.assertIn(result["notebook_sha256"], proposal)

    def test_a_link_planted_after_the_check_cannot_capture_the_write(self):
        # The atomicity control. The destination check and the write are separate
        # operations; the write must not be a second open() of the checked path,
        # or a symlink planted in between captures it. Gutting the atomic write
        # while keeping its name passes every other test in this file.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            contract = root / "research_contract.md"
            proposal = root / "artifacts" / "research_contract_block.proposed.md"
            proposal.parent.mkdir()
            real_guard = research_contract._assert_safe_proposal_destination

            def plant_after_check(dest, **kwargs):
                real_guard(dest, **kwargs)
                dest.symlink_to(contract)

            before = _project_digest(root)
            with mock.patch.object(
                research_contract, "_assert_safe_proposal_destination", plant_after_check
            ):
                propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertEqual(
                before[Path("research_contract.md").as_posix()],
                _project_digest(root)[Path("research_contract.md").as_posix()],
                "a link planted after the destination check captured the write",
            )

    def test_an_owned_neighbour_of_the_destination_survives(self):
        # The temp file used to be a fixed `<destination>.partial` sibling that
        # the destination guard never validated and that was unlinked anyway.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            (root / "artifacts").mkdir()
            neighbour = root / "artifacts" / "derived.md.partial"
            neighbour.write_text("owner-authored\n", encoding="utf-8")
            propose_research_contract_block(
                repo_root=root,
                proposal_path=root / "artifacts" / "derived.md",
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )
            self.assertTrue(neighbour.is_file())
            self.assertEqual("owner-authored\n", neighbour.read_text(encoding="utf-8"))

    def test_no_temporary_file_is_left_behind(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            leftovers = [p.name for p in (root / "artifacts").iterdir() if ".partial" in p.name]
            self.assertEqual([], leftovers)

    def test_byte_for_byte_means_byte_for_byte(self):
        # The predicate is named and documented byte-for-byte. It used .strip(),
        # so one added newline, space or tab at a block boundary produced a
        # non-template block that was accepted and rewritten anyway — the fifth
        # time this file has carried a claim stronger than its code.
        template = load_scaffold_template(RESEARCH_CONTRACT)
        self.assertTrue(research_contract._is_untouched_template_block(template))
        mutations = {
            "a blank line after the start marker": lambda s: s.replace(
                "RESEARCH_NOTEBOOK_SYNC_START -->\n", "RESEARCH_NOTEBOOK_SYNC_START -->\n\n", 1
            ),
            "a trailing space before the end marker": lambda s: s.replace(
                "\n<!-- RESEARCH_NOTEBOOK_SYNC_END", " \n<!-- RESEARCH_NOTEBOOK_SYNC_END", 1
            ),
            "a trailing tab before the end marker": lambda s: s.replace(
                "\n<!-- RESEARCH_NOTEBOOK_SYNC_END", "\t\n<!-- RESEARCH_NOTEBOOK_SYNC_END", 1
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(mutation=label):
                self.assertFalse(research_contract._is_untouched_template_block(mutate(template)))

    def test_swapping_the_destination_directory_cannot_redirect_the_write(self):
        # Pinning only the destination leaf is not enough: renaming its PARENT
        # to a symlink after validation redirected both the temp create and the
        # rename into an owner's directory, and replaced their file.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            (root / "safe").mkdir()
            (root / "owned").mkdir()
            owned = root / "owned" / "result.md"
            owned.write_text("OWNER\n", encoding="utf-8")
            real_guard = research_contract._assert_safe_proposal_destination

            def swap_parent(dest, **kwargs):
                real_guard(dest, **kwargs)
                os.rename(root / "safe", root / "safe_gone")
                os.symlink(root / "owned", root / "safe")

            with mock.patch.object(
                research_contract, "_assert_safe_proposal_destination", swap_parent
            ):
                with self.assertRaises(OSError):
                    propose_research_contract_block(
                        repo_root=root,
                        proposal_path=root / "safe" / "result.md",
                        project_policy=PROJECT_POLICY_REAL_PROJECT,
                    )
            self.assertEqual("OWNER\n", owned.read_text(encoding="utf-8"))

    def test_a_link_planted_after_the_template_check_cannot_capture_the_sync(self):
        # The in-place write had the same capture the proposal path was fixed
        # for: it re-opened the checked path with open("w").
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            root.mkdir(parents=True)
            contract = root / "research_contract.md"
            contract.write_text(load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8")
            (root / "research_notebook.md").write_text("# N\n\n## Scope\n\nT.\n", encoding="utf-8")
            victim = root / "victim.md"
            victim.write_text("VICTIM\n", encoding="utf-8")
            real_check = research_contract._is_untouched_template_block

            def check_then_plant(text):
                verdict = real_check(text)
                if verdict and not contract.is_symlink():
                    contract.unlink()
                    contract.symlink_to(victim)
                return verdict

            # The descriptor is held from the content check through to the
            # write, so the name no longer matching what was validated is now
            # refused outright rather than merely landing somewhere safe.
            with mock.patch.object(
                research_contract, "_is_untouched_template_block", check_then_plant
            ):
                with self.assertRaises(FileExistsError):
                    _sync(root)
            self.assertEqual("VICTIM\n", victim.read_text(encoding="utf-8"))

    def test_a_private_contract_stays_private(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            root.mkdir(parents=True)
            contract = root / "research_contract.md"
            contract.write_text(load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8")
            (root / "research_notebook.md").write_text("# N\n\n## Scope\n\nT.\n", encoding="utf-8")
            contract.chmod(0o600)

            _sync(root)

            self.assertEqual(0o600, _project_modes(root)["research_contract.md"])

    @unittest.skipIf(os.geteuid() == 0, "root holds CAP_DAC_OVERRIDE: os.access ignores the mode")
    def test_a_read_only_destination_is_refused_rather_than_replaced(self):
        # rename() needs write permission on the directory, not on the file it
        # replaces, so the atomic writer silently overwrote where the previous
        # open("w") raised. This module refuses rather than clobbers elsewhere.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            root.mkdir(parents=True)
            contract = root / "research_contract.md"
            contract.write_text(load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8")
            (root / "research_notebook.md").write_text("# N\n\n## Scope\n\nT.\n", encoding="utf-8")
            contract.chmod(0o444)
            before = contract.read_bytes()

            with self.assertRaises(PermissionError):
                _sync(root)

            self.assertEqual(before, contract.read_bytes())

    def test_a_proposal_replacing_an_earlier_one_keeps_its_mode(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            proposal = Path(first["proposal_path"])
            proposal.chmod(0o600)
            propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            self.assertEqual(0o600, stat.S_IMODE(proposal.stat().st_mode))

    @unittest.skipUnless(hasattr(os, "listxattr"), "platform exposes no extended attributes")
    def test_extended_attributes_survive_the_replacement(self):
        # A replaced inode inherits nothing from the one it displaces. Mode is
        # the consequential loss and is covered above; this covers the rest,
        # where the standard library can see it. macOS ships no os.listxattr,
        # so this skips there and the docstring says so rather than implying
        # the attributes are carried everywhere.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            proposal = Path(first["proposal_path"])
            os.setxattr(proposal, "user.nullius_test", b"kept")
            propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            self.assertEqual(b"kept", os.getxattr(proposal, "user.nullius_test"))

    def test_attributes_are_carried_before_the_mode_is_restored(self):
        """The ordering, locked by observing the call sequence.

        A review seat found that nothing locked it: the only attribute test uses
        a caller-owned proposal, where the order cannot matter, so a later edit
        merging the chmod up next to the stat would pass the whole suite while
        silently losing attributes on a shared-group destination at mode 0460.
        Establishing that took an entire review round; this keeps it.
        """
        calls: list[str] = []
        real_chmod, real_carry = os.chmod, research_contract._carry_extended_attributes

        def note_chmod(*a, **k):
            calls.append("chmod")
            return real_chmod(*a, **k)

        def note_carry(*a, **k):
            calls.append("carry")
            return real_carry(*a, **k)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            calls.clear()
            with mock.patch.object(os, "chmod", note_chmod), mock.patch.object(
                research_contract, "_carry_extended_attributes", note_carry
            ):
                propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertIn("carry", calls)
            self.assertIn("chmod", calls)
            self.assertLess(
                calls.index("carry"), calls.index("chmod"), f"order was {calls}"
            )

    @unittest.skipUnless(hasattr(os, "setxattr"), "platform exposes no extended attributes")
    def test_an_attribute_that_cannot_be_set_does_not_cost_the_write(self):
        # `security.*` on an unprivileged writer raises EPERM for real. The
        # carry must swallow it: content is what is being protected.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            proposal = Path(first["proposal_path"])
            os.setxattr(proposal, "user.kept", b"v")

            def refusing_setxattr(*args, **kwargs):
                raise OSError(1, "Operation not permitted")

            with mock.patch.object(os, "setxattr", refusing_setxattr):
                result = propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertIn(
                "### Notebook sections",
                Path(result["proposal_path"]).read_text(encoding="utf-8"),
            )

    @unittest.skipUnless(hasattr(os, "setxattr"), "platform exposes no extended attributes")
    def test_a_close_error_on_the_attribute_descriptor_does_not_cost_the_write(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            # Without an attribute the carry early-returns and never opens the
            # descriptor whose close is under test — the first version of this
            # test passed against a mutant for exactly that reason.
            os.setxattr(Path(first["proposal_path"]), "user.probe", b"1")
            real_close = os.close
            state = {"raised": False}

            def flaky_close(fd):
                real_close(fd)
                if not state["raised"]:
                    state["raised"] = True
                    raise OSError(5, "EIO")

            with mock.patch.object(os, "close", flaky_close):
                result = propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            self.assertTrue(state["raised"], "the probe never exercised a close")
            self.assertIn(
                "### Notebook sections",
                Path(result["proposal_path"]).read_text(encoding="utf-8"),
            )

    def test_a_destination_swapped_during_validation_is_refused(self):
        # The mode, the attributes and the refusal are all bound to one
        # descriptor. Putting a different inode at the name between the open and
        # the identity check made the descriptor bind the intruder, whose ACL
        # was then copied onto the destination.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            proposal = Path(first["proposal_path"])
            intruder = root / "artifacts" / "intruder.md"
            intruder.write_text("INTRUDER\n", encoding="utf-8")
            real_open = os.open

            def swap_after_open(*args, **kwargs):
                fd = real_open(*args, **kwargs)
                if args and args[0] == proposal.name and "dir_fd" in kwargs:
                    os.replace(intruder, proposal)
                return fd

            with mock.patch.object(os, "open", swap_after_open):
                with self.assertRaises(FileExistsError):
                    propose_research_contract_block(
                        repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                    )

    def test_a_file_swapped_in_after_the_content_check_is_not_overwritten(self):
        """The decision and the file it was about must be the same file.

        This function's judgement is "that block is still the template, so
        overwriting it loses nothing". Reading by path and writing by path let a
        rename in between apply that judgement to a file it was never about — a
        curated contract, overwritten because a different file passed the check.
        That is the incident this whole package exists for, arriving through the
        one gap the writer's own identity check could not see: the writer bound
        its open to its own stat, not to the caller's content read.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            root.mkdir(parents=True)
            contract = root / "research_contract.md"
            contract.write_text(load_scaffold_template(RESEARCH_CONTRACT), encoding="utf-8")
            (root / "research_notebook.md").write_text("# N\n\n## Scope\n\nT.\n", encoding="utf-8")
            curated = root / "curated.md"
            curated.write_text("# CURATED — eighteen months of work\n", encoding="utf-8")
            swapped = {"done": False}
            real_check = research_contract._is_untouched_template_block

            def check_then_swap(text):
                verdict = real_check(text)
                if verdict and not swapped["done"]:
                    os.replace(curated, contract)
                    swapped["done"] = True
                return verdict

            with mock.patch.object(
                research_contract, "_is_untouched_template_block", check_then_swap
            ):
                with self.assertRaises(FileExistsError):
                    _sync(root)

            self.assertTrue(swapped["done"], "the probe never swapped")
            self.assertEqual(
                "# CURATED — eighteen months of work\n",
                contract.read_text(encoding="utf-8"),
            )

    @unittest.skipUnless(hasattr(os, "listxattr"), "platform exposes no extended attributes")
    def test_the_attribute_read_uses_the_descriptor_not_the_path(self):
        # The property the descriptor design exists for. Reverting the carry to
        # read the source by path passed the entire suite while copying an
        # intruder's attributes onto the destination — the shape this round
        # closed, behind a suite that accepted it.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            first = propose_research_contract_block(
                repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            proposal = Path(first["proposal_path"])
            os.setxattr(proposal, "user.victim", b"mine")
            intruder = root / "artifacts" / "intruder.md"
            intruder.write_text("x\n", encoding="utf-8")
            os.setxattr(intruder, "user.intruder", b"theirs")
            real_carry = research_contract._carry_extended_attributes

            def swap_then_carry(source_fd, tmp_name, *, parent_fd):
                # The name now points at the intruder; a path-based read would
                # pick up its attributes, a descriptor read cannot.
                os.replace(intruder, proposal)
                return real_carry(source_fd, tmp_name, parent_fd=parent_fd)

            with mock.patch.object(
                research_contract, "_carry_extended_attributes", swap_then_carry
            ):
                propose_research_contract_block(
                    repo_root=root, project_policy=PROJECT_POLICY_REAL_PROJECT
                )
            carried = [n for n in os.listxattr(proposal) if n.startswith("user.")]
            self.assertIn("user.victim", carried)
            self.assertNotIn("user.intruder", carried)

    def test_the_template_block_carries_no_render_placeholder(self):
        # The in-place precondition compares the RAW template while the scaffold
        # writes the RENDERED one. They agree only while the block contains no
        # substitution token; adding one would make every init raise.
        block = _block_text(load_scaffold_template(RESEARCH_CONTRACT))
        for token in ("<PROJECT_NAME>", "<PROJECT_ROOT>", "<PROFILE>", "<YYYY-MM-DD>"):
            self.assertNotIn(token, block)


class ForceReportsWhatItReplacedTest(unittest.TestCase):
    def test_force_names_the_files_it_overwrote(self):
        # `--force` stays destructive: it is an explicit request. But it
        # replaces the contract BEFORE the notebook sync looks at it, so the
        # sync then truthfully reports removing nothing, and the run as a whole
        # reads clean while a curated block is gone.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Mature Project",
                project_policy=PROJECT_POLICY_REAL_PROJECT,
                force=True,
            )
            self.assertIn("research_contract.md", result["overwritten"])

    def test_a_plain_init_overwrites_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Mature Project",
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )
            self.assertEqual(result["overwritten"], [])


if __name__ == "__main__":
    unittest.main()
