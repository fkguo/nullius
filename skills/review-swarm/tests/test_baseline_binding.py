"""Delta confirmation rounds are bound to the reviewed baseline.

A confirmation round reviews the exact delta from the previously reviewed
artifact state. `--baseline-review` verifies that every target file recorded
in the prior review's input manifest hashes, at the `--diff` BASE revision,
to exactly the reviewed sha256 — so a diff whose BASE is not the reviewed
state (which would let intervening changes escape confirmation) fails
closed instead of silently passing freshness.
"""

import hashlib
import importlib.util
import json
import os
import subprocess
import unittest
from pathlib import Path
import tempfile

_SKILL_ROOT = Path(__file__).resolve().parents[1]


def _load_module(name: str):
    module_path = _SKILL_ROOT / "scripts" / "bin" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *argv: str) -> str:
    proc = subprocess.run(
        ["git", *argv], cwd=repo, check=True, capture_output=True, text=True
    )
    return proc.stdout.strip()


class BaselineBindingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = _load_module("review_one")
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "t@example.invalid")
        _git(self.repo, "config", "user.name", "t")
        self.target = self.repo / "notes.md"
        self.target.write_text("reviewed content v1\n", encoding="utf-8")
        _git(self.repo, "add", "notes.md")
        _git(self.repo, "commit", "-qm", "v1")
        self.base_v1 = _git(self.repo, "rev-parse", "HEAD")
        self.reviewed_sha = hashlib.sha256(
            self.target.read_bytes()
        ).hexdigest()
        # Fabricate the prior review's manifest recording the reviewed hash.
        self.baseline_dir = self.repo / "review-r1"
        inputs = self.baseline_dir / "inputs"
        inputs.mkdir(parents=True)
        (inputs / "review_input_manifest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "file_inputs": [
                        {
                            "kind": "target_artifact",
                            "path": "notes.md",
                            "sha256": self.reviewed_sha,
                            "bytes": 20,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        # The fix batch: a second commit changing the target.
        self.target.write_text("reviewed content v1\nplus the fix batch\n", encoding="utf-8")
        _git(self.repo, "add", "notes.md")
        _git(self.repo, "commit", "-qm", "v2")
        self.head_v2 = _git(self.repo, "rev-parse", "HEAD")
        self._old_cwd = os.getcwd()
        os.chdir(self.repo)

    def tearDown(self) -> None:
        os.chdir(self._old_cwd)
        self.tmp.cleanup()

    def test_matching_base_passes_and_records_binding(self) -> None:
        binding = self.mod._verify_baseline_binding(
            self.baseline_dir, f"{self.base_v1}..{self.head_v2}"
        )
        self.assertEqual(binding["base_ref"], self.base_v1)
        self.assertEqual(
            binding["verified_targets"],
            [{"path": "notes.md", "sha256": self.reviewed_sha}],
        )

    def test_mismatched_base_fails_closed(self) -> None:
        # BASE = v2: the file content there differs from the reviewed hash, so
        # the delta measured from v2 would not cover every change since the
        # review — must fail, not silently pass.
        with self.assertRaisesRegex(ValueError, "does not match the reviewed baseline"):
            self.mod._verify_baseline_binding(
                self.baseline_dir, f"{self.head_v2}..{self.head_v2}"
            )

    def test_target_missing_at_base_fails_closed(self) -> None:
        manifest = self.baseline_dir / "inputs" / "review_input_manifest.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["file_inputs"][0]["path"] = "not-yet-created.md"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "not present at BASE"):
            self.mod._verify_baseline_binding(
                self.baseline_dir, f"{self.base_v1}..{self.head_v2}"
            )

    def test_diff_only_baseline_fails_closed(self) -> None:
        manifest = self.baseline_dir / "inputs" / "review_input_manifest.json"
        manifest.write_text(
            json.dumps({"schema_version": 1, "file_inputs": []}), encoding="utf-8"
        )
        with self.assertRaisesRegex(ValueError, "no target_artifact entries"):
            self.mod._verify_baseline_binding(
                self.baseline_dir, f"{self.base_v1}..{self.head_v2}"
            )

    def test_missing_manifest_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "manifest not found"):
            self.mod._verify_baseline_binding(
                self.repo / "no-such-review", f"{self.base_v1}..{self.head_v2}"
            )

    def test_range_without_base_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "explicit BASE"):
            self.mod._verify_baseline_binding(self.baseline_dir, f"..{self.head_v2}")


if __name__ == "__main__":
    unittest.main()
