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
from project_contracts.research_contract import (  # noqa: E402
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

    def test_fenced_examples_are_not_references(self):
        """A fenced illustration inside References is not bibliography: it
        once became a fictitious entry that a deliberate re-sync would write
        into a user's contract."""
        notebook = (
            "# NB\n\n## References\n\n"
            "1. Real one, [DOI](https://doi.org/10.1000/a)\n\n"
            "```\n1. fake code-block item\n- and this bullet is code\n```\n\n"
            "2. Real two, [DOI](https://doi.org/10.1000/b)\n"
        )
        _, references = _collect_notebook_sections(notebook)
        self.assertEqual(len(references), 2, references)
        self.assertIn("10.1000/a", references[0])
        self.assertIn("10.1000/b", references[1])

    def test_mismatched_fence_markers_do_not_close_each_other(self):
        """CommonMark: a ~~~ line inside a ``` block is content, not a
        closer. Toggling on any marker re-enabled collection mid-block."""
        notebook = (
            "# NB\n\n## References\n\n"
            "1. Real one, [DOI](https://doi.org/10.1000/a)\n\n"
            "```\n~~~\n1. still code, not a reference\n```\n\n"
            "2. Real two, [DOI](https://doi.org/10.1000/b)\n"
        )
        _, references = _collect_notebook_sections(notebook)
        self.assertEqual(len(references), 2, references)
        self.assertTrue(all("still code" not in ref for ref in references))

    def test_nested_annotation_folds_into_its_entry(self):
        notebook = (
            "# NB\n\n## References\n\n"
            "1. Primary, [DOI](https://doi.org/10.1000/a)\n"
            "   - annotation about it\n"
            "2. Second, [DOI](https://doi.org/10.1000/b)\n"
        )
        _, references = _collect_notebook_sections(notebook)
        self.assertEqual(len(references), 2, references)
        self.assertIn("annotation about it", references[0])

    def test_references_stop_at_the_next_heading(self):
        notebook = (
            "# Notebook\n\n## References\n\n"
            "1. Author, [DOI](https://doi.org/10.1000/a)\n\n"
            "## Appendix\n\n- not a reference\n"
        )
        headings, references = _collect_notebook_sections(notebook)
        self.assertEqual(len(references), 1)
        self.assertIn("Appendix", headings)


class SyncReportsLossTest(unittest.TestCase):
    def test_sync_reports_entries_it_drops(self):
        # A deliberate re-sync may legitimately shrink the block (the notebook
        # dropped a section), but never silently: the dropped entries come
        # back in the result so a caller can surface them.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            result = sync_research_contract(
                repo_root=root,
                create_missing=False,
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )
            dropped = result["dropped_entries"]
            self.assertTrue(dropped, "a shrinking sync reported no dropped entries")
            # The curated contract listed sections the notebook no longer has.
            self.assertIn("- Correction chain", dropped)
            self.assertEqual(result["reference_count"], 2)
            self.assertEqual(result["section_count"], 2)

    def test_sync_of_a_faithful_notebook_drops_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _mature_project(root)
            # Re-sync twice: the second pass sees the block the first wrote.
            sync_research_contract(
                repo_root=root, create_missing=False, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            result = sync_research_contract(
                repo_root=root, create_missing=False, project_policy=PROJECT_POLICY_REAL_PROJECT
            )
            self.assertEqual(result["dropped_entries"], [])


if __name__ == "__main__":
    unittest.main()
