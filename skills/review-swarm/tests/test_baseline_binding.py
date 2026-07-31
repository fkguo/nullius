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

    def test_candidate_commit_resolves_ref_and_pins_the_range(self) -> None:
        # A movable ref pins to its full commit id at dispatch; the returned
        # range substitutes resolved ids for both sides, so ref movement
        # between resolution and diff execution cannot drift the content.
        oid, pinned = self.mod._resolve_candidate_commit(
            "HEAD", f"{self.base_v1}..{self.head_v2}"
        )
        self.assertEqual(oid, self.head_v2)
        self.assertEqual(pinned, f"{self.base_v1}..{self.head_v2}")
        oid_short, pinned_none = self.mod._resolve_candidate_commit(self.head_v2[:10], None)
        self.assertEqual(oid_short, self.head_v2)
        self.assertIsNone(pinned_none)

    def test_candidate_commit_mismatching_diff_head_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "must name exactly the state the diff measures"):
            self.mod._resolve_candidate_commit(self.base_v1, f"{self.base_v1}..{self.head_v2}")

    def test_candidate_commit_one_sided_range_fails_closed(self) -> None:
        # `git diff <ref>` compares against the WORKING TREE — a commit header
        # over worktree bytes is the exact mis-binding this refusal closes.
        with self.assertRaisesRegex(ValueError, "one-sided range diffs against the working tree"):
            self.mod._resolve_candidate_commit(self.base_v1, self.base_v1)

    def test_candidate_commit_three_dot_range_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "three-dot"):
            self.mod._resolve_candidate_commit(
                self.head_v2, f"{self.base_v1}...{self.head_v2}"
            )

    def test_candidate_commit_unresolvable_ref_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot resolve"):
            self.mod._resolve_candidate_commit("no-such-ref-anywhere", None)

    def test_candidate_commit_option_like_value_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "starts with '-'"):
            self.mod._resolve_candidate_commit("--output=x", None)

    def test_artifact_binding_refuses_uncommitted_bytes(self) -> None:
        # An artifact whose disk bytes differ from the blob at the candidate
        # commit may not carry that commit's header.
        import hashlib as _hashlib

        disk_text = self.target.read_text(encoding="utf-8")
        artifacts = [
            (
                Path("notes.md"),
                disk_text,
                _hashlib.sha256(disk_text.encode()).hexdigest(),
                len(disk_text),
            )
        ]
        # Bytes match at head_v2: passes.
        self.mod._verify_artifacts_at_commit(artifacts, self.head_v2)
        # Same bytes claimed at base_v1 (older content): refused.
        with self.assertRaisesRegex(ValueError, "may not cover uncommitted bytes"):
            self.mod._verify_artifacts_at_commit(artifacts, self.base_v1)
        # Uncommitted edit on disk: refused against any commit.
        self.target.write_text(disk_text + "uncommitted tail\n", encoding="utf-8")
        new_text = self.target.read_text(encoding="utf-8")
        dirty = [
            (
                Path("notes.md"),
                new_text,
                _hashlib.sha256(new_text.encode()).hexdigest(),
                len(new_text),
            )
        ]
        with self.assertRaisesRegex(ValueError, "may not cover uncommitted bytes"):
            self.mod._verify_artifacts_at_commit(dirty, self.head_v2)

    def test_three_dot_range_fails_closed(self) -> None:
        # `git diff A...B` measures from the merge base, not from tree A, so
        # hashes verified at A would not describe what the diff covers.
        with self.assertRaisesRegex(ValueError, "three-dot"):
            self.mod._verify_baseline_binding(
                self.baseline_dir, f"{self.base_v1}...{self.head_v2}"
            )

    def _add_context_entry(self, path: str, sha256: str) -> None:
        manifest = self.baseline_dir / "inputs" / "review_input_manifest.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["file_inputs"].append(
            {"kind": "additional_context", "path": path, "sha256": sha256, "bytes": 1}
        )
        manifest.write_text(json.dumps(data), encoding="utf-8")

    def test_late_base_with_changed_context_fails_closed(self) -> None:
        # The escape this closes: pick a BASE *later* than the reviewed state,
        # where the target files happen to be unchanged but a reviewed context
        # input changed in between — the target hashes at BASE still match, so
        # without context binding the delta would silently omit the context
        # change. Layout: review at v1 (target + ctx) → ctx changes (target
        # untouched) → fix batch. BASE = the ctx-changed commit.
        ctx = self.repo / "context.md"
        # Rebuild history from the reviewed state: reset to v1 and add ctx.
        _git(self.repo, "checkout", "-q", self.base_v1)
        ctx.write_text("context v1\n", encoding="utf-8")
        _git(self.repo, "add", "context.md")
        _git(self.repo, "commit", "-qm", "reviewed state with ctx")
        reviewed_commit = _git(self.repo, "rev-parse", "HEAD")
        reviewed_ctx_sha = hashlib.sha256(ctx.read_bytes()).hexdigest()
        self._add_context_entry("context.md", reviewed_ctx_sha)
        # Context changes; targets untouched.
        ctx.write_text("context v2 — changed between review and BASE\n", encoding="utf-8")
        _git(self.repo, "add", "context.md")
        _git(self.repo, "commit", "-qm", "ctx v2, targets untouched")
        late_base = _git(self.repo, "rev-parse", "HEAD")
        # Fix batch on the target.
        self.target.write_text("reviewed content v1\nplus the fix batch\n", encoding="utf-8")
        _git(self.repo, "add", "notes.md")
        _git(self.repo, "commit", "-qm", "fix batch")
        head = _git(self.repo, "rev-parse", "HEAD")
        # Sanity: target hashes at the late BASE still match the review, so
        # target binding alone would pass — the context binding must catch it.
        with self.assertRaisesRegex(ValueError, "context context.md"):
            self.mod._verify_baseline_binding(self.baseline_dir, f"{late_base}..{head}")
        # The honest BASE (the reviewed commit) passes: the context change then
        # lies inside the delta the reviewers will see.
        binding = self.mod._verify_baseline_binding(
            self.baseline_dir, f"{reviewed_commit}..{head}"
        )
        self.assertEqual(len(binding["verified_contexts"]), 1)

    def test_changed_out_of_repo_context_fails_closed(self) -> None:
        outside = Path(self.tmp.name) / "outside-context.md"
        outside.write_text("outside v1\n", encoding="utf-8")
        reviewed_sha = hashlib.sha256(outside.read_bytes()).hexdigest()
        self._add_context_entry(str(outside), reviewed_sha)
        outside.write_text("outside v2 — changed after review\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "differs from the reviewed"):
            self.mod._verify_baseline_binding(
                self.baseline_dir, f"{self.base_v1}..{self.head_v2}"
            )

    def test_unchanged_contexts_pass_and_are_recorded(self) -> None:
        outside = Path(self.tmp.name) / "stable-context.md"
        outside.write_text("stable\n", encoding="utf-8")
        self._add_context_entry(
            str(outside), hashlib.sha256(outside.read_bytes()).hexdigest()
        )
        binding = self.mod._verify_baseline_binding(
            self.baseline_dir, f"{self.base_v1}..{self.head_v2}"
        )
        self.assertEqual(len(binding["verified_contexts"]), 1)


if __name__ == "__main__":
    unittest.main()
