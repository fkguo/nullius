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
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_scaffold import ensure_project_scaffold  # noqa: E402
from project_contracts.project_policy import PROJECT_POLICY_REAL_PROJECT  # noqa: E402
from project_contracts.research_contract import (
    RETAINED_HEADING,
    SYNC_END,
    SYNC_START,
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


def _sync(root: Path, **kwargs):
    return sync_research_contract(
        repo_root=root, create_missing=False, project_policy=PROJECT_POLICY_REAL_PROJECT, **kwargs
    )


class RetainsWhatItCannotDeriveTest(unittest.TestCase):
    """The guarantee, and why it is structural rather than a judgement call.

    Rounds four and five each disproved a text heuristic that decided whether a
    vanished entry had been deleted on purpose. Both shipped; both were measured
    destroying real references on input the tool itself had written. So nothing
    decides that any more: a line the new parse does not reproduce is written
    back. Every case below is a shape the scanner genuinely cannot read.
    """

    def test_a_table_shaped_bibliography_is_kept_not_dropped(self):
        entry = "- Author A and Author B (2001), [DOI](https://doi.org/10.1000/example-a)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(
                root,
                [entry],
                "| Source | Link |\n| --- | --- |\n"
                "| Author A and Author B (2001) | [DOI](https://doi.org/10.1000/example-a) |\n",
            )
            result = _sync(root)
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            self.assertIn(entry, result["retained_entries"])
            self.assertIn("https://doi.org/10.1000/example-a", contract)
            self.assertIn(RETAINED_HEADING, contract)

    def test_an_entry_opening_with_a_qualifier_is_protected(self):
        # Every Markdown inline link ends with ")", so a placeholder test asking
        # "starts with ( and ends with )" silently unprotected every entry whose
        # first token is a qualifier. Placeholders are matched by exact text now.
        entry = "- (Erratum) Author A (2004), [DOI](https://doi.org/10.1000/example-erratum)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "| Source |\n| --- |\n| (Erratum) Author A (2004) |\n")
            result = _sync(root)
            self.assertIn(entry, result["retained_entries"])
            self.assertIn(entry, (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_a_prefix_related_target_does_not_count_as_reproduction(self):
        # Sequential identifiers stand in a prefix relation. Substring matching
        # let the longer one absolve the shorter, which destroyed the shorter.
        entry = "- Dataset A, [record](https://zenodo.org/record/117532)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "- Dataset B, [record](https://zenodo.org/record/1175321)\n")
            result = _sync(root)
            self.assertIn(entry, result["retained_entries"])
            self.assertIn("https://zenodo.org/record/117532)", (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_a_numbered_block_entry_is_protected(self):
        # The incident's own bibliography style. Protecting only bullet lines
        # meant the diagnostic told operators to hand-edit the block, and the
        # most natural bibliography form turned the protection off.
        entry = "1. Author A (2001), [DOI](https://doi.org/10.1000/example-a)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "| Source |\n| --- |\n| Author A (2001) |\n")
            result = _sync(root)
            self.assertIn(entry, result["retained_entries"])

    def test_an_unlinked_entry_reformatted_into_cells_is_protected(self):
        entry = "- Smith (2020), Canonical study"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "| Smith (2020) | Canonical study |\n| --- | --- |\n")
            result = _sync(root)
            self.assertIn(entry, result["retained_entries"])

    def test_a_faithful_resync_retains_nothing(self):
        entry = "- Author A (2001), [DOI](https://doi.org/10.1000/example-a)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], f"{entry}\n")
            result = _sync(root)
            self.assertEqual(result["retained_entries"], [])
            self.assertNotIn(RETAINED_HEADING, (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_retained_entries_are_stable_and_do_not_multiply(self):
        entry = "- Author A (2001), [DOI](https://doi.org/10.1000/example-a)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "| Source |\n| --- |\n| Author A (2001) |\n")
            for _ in range(3):
                _sync(root)
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            self.assertEqual(contract.count(entry), 1)
            self.assertEqual(contract.count(RETAINED_HEADING), 1)

    def test_drop_unreproduced_is_the_only_path_that_removes(self):
        entry = "- Author A (2001), [DOI](https://doi.org/10.1000/example-a)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "| Source |\n| --- |\n| Author A (2001) |\n")
            result = _sync(root, drop_unreproduced=True)
            self.assertIn(entry, result["dropped_entries"])
            self.assertNotIn(entry, (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_a_template_placeholder_is_not_retained(self):
        # Otherwise a fresh project would carry its own placeholder forever.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, ["- (refresh to populate)"], "- Author A (2001)\n")
            result = _sync(root)
            self.assertEqual(result["retained_entries"], [])
            self.assertNotIn("(refresh to populate)", (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_a_plus_bullet_is_not_emitted_as_a_nested_list(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [], "+ Author A (2001), [DOI](https://doi.org/10.1000/example-a)\n")
            _sync(root)
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            self.assertNotIn("- + Author A", contract)
            self.assertIn("+ Author A (2001)", contract)


class MatchingMistakesMustNotDeleteTest(unittest.TestCase):
    """A false POSITIVE match deletes: the line is judged reproduced, so it is
    not retained, and if the judgement was wrong it was never re-derived either.
    Every case here has a SURVIVING derived entry that a looser rule would let
    absolve the vanished one — the structure the previous suite lacked, which is
    why an any-overlap mutant passed all of it."""

    def test_an_erratum_is_not_absolved_by_the_paper_it_corrects(self):
        erratum = "- (Erratum) Author (1980), [DOI](https://doi.org/10.1000/eichten)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(
                root,
                [erratum],
                # The article survives in the derived block carrying the SAME target.
                "- Author (1978), [DOI](https://doi.org/10.1000/eichten)\n",
            )
            result = _sync(root)
            self.assertIn(erratum, result["retained_entries"])
            self.assertIn(erratum, (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_a_curator_annotation_is_not_absolved_by_the_bare_entry(self):
        # The derived body is a strict SUBSTRING of the existing one, which is
        # what a curator's added note looks like. Substring matching — the
        # round-5 bug — reads that as reproduced and deletes the annotation.
        annotated = "- Author (1978), [DOI](https://ex.org/e) — superseded by the 1980 erratum"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [annotated], "- Author (1978), [DOI](https://ex.org/e)\n")
            result = _sync(root)
            self.assertIn(annotated, result["retained_entries"])
            self.assertIn(annotated, (root / "research_contract.md").read_text(encoding="utf-8"))

    def test_entries_do_not_absolve_one_another_collectively(self):
        combined = "- Gamma (2003) combined, [x](https://ex.org/x), [y](https://ex.org/y)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(
                root,
                [combined],
                "- Alpha, [x](https://ex.org/x)\n\n- Beta, [y](https://ex.org/y)\n",
            )
            result = _sync(root)
            self.assertIn(combined, result["retained_entries"])

    def test_two_targets_differing_after_a_parenthesis_are_distinct(self):
        other = "- Epsilon (2005), [Rept](https://doi.org/10.1016/S0370-1573(01)00010-2)"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(
                root,
                [other],
                "- Delta (2004), [Rept](https://doi.org/10.1016/S0370-1573(01)00009-6)\n",
            )
            result = _sync(root)
            self.assertIn(other, result["retained_entries"])


class StructureIsIdentityNotShapeTest(unittest.TestCase):
    """Excluding a line from retention deletes it, so "is this the module's own
    output" must be answered by what the module writes, not by how a line looks."""

    def test_user_content_shaped_like_structure_survives(self):
        lines = [
            "#### Reviews and errata",
            "<!-- Zeta (2006), unpublished note, no public link -->",
            "#1729 internal report, no DOI, see lab archive",
            "- Source notebook: [archived scan](https://example.org/scan-1729)",
        ]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, lines, "- Unrelated (2009), [DOI](https://ex.org/u)\n")
            _sync(root)
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            for line in lines:
                self.assertIn(line, contract, f"structure-shaped user content deleted: {line}")

    def test_a_hard_break_is_written_back_verbatim(self):
        entry = "- Eta (2007), trailing hard break  "
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, [entry], "- Unrelated (2009), [DOI](https://ex.org/u)\n")
            result = _sync(root)
            self.assertIn(entry, result["retained_entries"])

    def test_reversed_markers_are_refused_rather_than_duplicated(self):
        # Each marker index was taken independently, so an END before a START
        # duplicated the span between them on every sync, unbounded.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, ["- A, [DOI](https://ex.org/a)"], "- A, [DOI](https://ex.org/a)\n")
            contract = root / "research_contract.md"
            text = contract.read_text(encoding="utf-8")
            swapped = text.replace(SYNC_START, "@@S@@").replace(SYNC_END, SYNC_START).replace("@@S@@", SYNC_END)
            contract.write_text(swapped, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "out of order"):
                _sync(root)
            self.assertEqual(swapped, contract.read_text(encoding="utf-8"))

    def test_crlf_line_endings_are_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project_with(root, ["- A, [DOI](https://ex.org/a)"], "- A, [DOI](https://ex.org/a)\n")
            contract = root / "research_contract.md"
            contract.write_bytes(contract.read_text(encoding="utf-8").replace("\n", "\r\n").encode())
            _sync(root)
            self.assertIn(b"\r\n", contract.read_bytes())
            self.assertNotIn(b"\n\n\n", contract.read_bytes().replace(b"\r", b""))


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
