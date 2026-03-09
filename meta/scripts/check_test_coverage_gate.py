#!/usr/bin/env python3
"""NEW-R07: hep-autoresearch test coverage gate.

Ensures every Python source file in ``packages/hep-autoresearch/src/`` has a
corresponding test file in ``packages/hep-autoresearch/tests/``.

Exit codes:
    0 — all new source files have tests (or are exempted)
    1 — one or more new source files are missing tests
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PACKAGE_ROOT = Path("packages/hep-autoresearch")
SRC_DIR = PACKAGE_ROOT / "src" / "hep_autoresearch"
TESTS_DIR = PACKAGE_ROOT / "tests"

# Files always exempt from the test-file requirement.
SKIP_FILES = frozenset({"__init__.py", "__main__.py"})

# Subdirectories to skip entirely (e.g. specs contain JSON, not Python).
SKIP_DIRS = frozenset({"specs", "__pycache__"})

# Baseline whitelist: source modules that existed before the gate was
# introduced and do not yet have tests.  These are grandfathered in but
# should be progressively reduced.  Each entry is relative to SRC_DIR
# (e.g. "toolkit/ingest.py").
BASELINE_WHITELIST: frozenset[str] = frozenset({
    "cli.py",
    "orchestrator_cli.py",
    "toolkit/_git.py",
    "toolkit/_http.py",
    "toolkit/_json.py",
    "toolkit/_paths.py",
    "toolkit/_time.py",
    "toolkit/adapters/artifacts.py",
    "toolkit/adapters/base.py",
    "toolkit/adapters/registry.py",
    "toolkit/artifact_report.py",
    "toolkit/context_pack.py",
    "toolkit/ecosystem_bundle.py",
    "toolkit/evolution_proposal.py",
    "toolkit/kb_index.py",
    "toolkit/literature_survey_export.py",
    "toolkit/literature_survey_polish.py",
    "toolkit/mcp_stdio_client.py",
    "toolkit/method_design.py",
    "toolkit/orchestrator_regression.py",
    "toolkit/orchestrator_state.py",
    "toolkit/project_scaffold.py",
    "toolkit/redaction.py",
    "toolkit/retry.py",
    "toolkit/run_card_schema.py",
    "toolkit/skill_proposal.py",
    "toolkit/units.py",
    "toolkit/ingest.py",
    "toolkit/reproduce.py",
    "toolkit/paper_reviser.py",
    "toolkit/paper_reviser_evidence.py",
    "toolkit/paper_reviser_utils.py",
    "toolkit/revision.py",
    "toolkit/workflow_context.py",
    "web/app.py",
})


def _module_stem(rel_path: str) -> str:
    """Extract the final module name without extension.

    ``"toolkit/computation.py"`` → ``"computation"``
    """
    return Path(rel_path).stem


def _find_test_files(tests_dir: Path) -> set[str]:
    """Return the set of module stems covered by existing ``test_*.py`` files."""
    covered: set[str] = set()
    if not tests_dir.is_dir():
        return covered
    for f in tests_dir.rglob("test_*.py"):
        # test_foo.py → "foo"
        stem = f.stem
        if stem.startswith("test_"):
            covered.add(stem[5:])  # strip "test_" prefix
    return covered


def main() -> int:
    repo_root = Path(os.environ.get("REPO_ROOT", ".")).resolve()
    src_dir = repo_root / SRC_DIR
    tests_dir = repo_root / TESTS_DIR

    if not src_dir.is_dir():
        print(f"ERROR: source directory not found: {src_dir}", file=sys.stderr)
        return 1

    covered_stems = _find_test_files(tests_dir)

    missing: list[str] = []
    whitelisted: list[str] = []
    covered: list[str] = []

    for py_file in sorted(src_dir.rglob("*.py")):
        if py_file.name in SKIP_FILES:
            continue
        # Skip exempted directories.
        rel = py_file.relative_to(src_dir)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue

        rel_str = str(rel)
        module_stem = _module_stem(rel_str)

        # Check if any test file covers this module.
        # Convention: test_<module_stem>.py OR test_<module_stem>_*.py
        has_test = False
        for cs in covered_stems:
            if cs == module_stem or cs.startswith(module_stem + "_"):
                has_test = True
                break

        if has_test:
            covered.append(rel_str)
        elif rel_str in BASELINE_WHITELIST:
            whitelisted.append(rel_str)
        else:
            missing.append(rel_str)

    # Report
    total = len(covered) + len(whitelisted) + len(missing)
    print(f"Test coverage gate: {len(covered)}/{total} source files have tests")
    print(f"  Whitelisted (baseline): {len(whitelisted)}")

    if missing:
        print(f"\nERROR: {len(missing)} source file(s) missing tests:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        print(
            "\nAdd a test file (tests/test_<module>.py) or add to the "
            "BASELINE_WHITELIST in this script.",
            file=sys.stderr,
        )
        return 1

    print("OK: All source files have tests or are whitelisted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
