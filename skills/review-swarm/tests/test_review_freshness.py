import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_SKILL_ROOT = Path(__file__).resolve().parents[1]
_REVIEW_ONE = _SKILL_ROOT / "scripts" / "bin" / "review_one.py"


def _load_verifier():
    path = _SKILL_ROOT / "scripts" / "bin" / "verify_review_freshness.py"
    spec = importlib.util.spec_from_file_location("verify_review_freshness_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_manifest(review_dir: Path, artifact: Path) -> None:
    manifest_path = review_dir / "inputs" / "review_input_manifest.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "role": "correctness",
                "working_directory": str(artifact.parent),
                "file_inputs": [
                    {
                        "kind": "target_artifact",
                        "path": str(artifact),
                        "sha256": _digest(artifact),
                        "bytes": artifact.stat().st_size,
                    }
                ],
                "target_diff": None,
            }
        )
        + "\n",
        encoding="utf-8",
    )


def _write_mutating_runner(path: Path, artifact: Path) -> None:
    path.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${{out}}" <<'MD'
VERDICT: READY

## Blockers
- none

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- none
MD
printf 'changed during review\n' >>"{artifact}"
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_ready_runner(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${out}" <<'MD'
VERDICT: READY

## Blockers
- none

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- none
MD
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_manifest_deleting_runner(path: Path, manifest: Path) -> None:
    _write_ready_runner(path)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f'rm -f "{manifest}"\n')


class ReviewFreshnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.verifier = _load_verifier()

    def test_standalone_checker_rejects_post_review_edit(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            review_dir = root / "review"
            artifact = root / "artifact.md"
            artifact.write_text("reviewed bytes\n", encoding="utf-8")
            _write_manifest(review_dir, artifact)

            fresh, _ = self.verifier.verify_review_dir(review_dir)
            self.assertEqual(fresh["status"], "FRESH")

            artifact.write_text("new bytes\n", encoding="utf-8")
            stale, _ = self.verifier.verify_review_dir(review_dir)
            self.assertEqual(stale["status"], "STALE")
            self.assertEqual(stale["file_inputs"][0]["status"], "changed")

    def test_standalone_checker_rejects_missing_input(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            review_dir = root / "review"
            artifact = root / "artifact.md"
            artifact.write_text("reviewed bytes\n", encoding="utf-8")
            _write_manifest(review_dir, artifact)
            artifact.unlink()

            stale, _ = self.verifier.verify_review_dir(review_dir)
            self.assertEqual(stale["status"], "STALE")
            self.assertEqual(stale["file_inputs"][0]["status"], "missing")

    def test_standalone_checker_rejects_malformed_manifest_entries(self):
        with tempfile.TemporaryDirectory() as td:
            review_dir = Path(td) / "review"
            manifest_path = review_dir / "inputs" / "review_input_manifest.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "role": "correctness",
                        "working_directory": str(Path(td)),
                        "file_inputs": ["not-an-object"],
                        "target_diff": None,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "file_inputs must be a list of objects"):
                self.verifier.verify_review_dir(review_dir)

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["file_inputs"] = []
            manifest["target_diff"] = "not-an-object"
            manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "target_diff must be an object or null"):
                self.verifier.verify_review_dir(review_dir)

    def test_standalone_checker_rejects_changed_git_diff(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
            )
            target = repo / "target.txt"
            target.write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "target.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            target.write_text("reviewed\n", encoding="utf-8")
            subprocess.run(["git", "commit", "-qam", "reviewed"], cwd=repo, check=True)

            diff_range = "HEAD~1..HEAD"
            reviewed_diff = subprocess.run(
                ["git", "diff", diff_range], cwd=repo, check=True, capture_output=True
            ).stdout
            review_dir = repo / "review"
            manifest_path = review_dir / "inputs" / "review_input_manifest.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "role": "correctness",
                        "working_directory": str(repo),
                        "file_inputs": [],
                        "target_diff": {
                            "range": diff_range,
                            "sha256": hashlib.sha256(reviewed_diff).hexdigest(),
                            "bytes": len(reviewed_diff),
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            fresh, _ = self.verifier.verify_review_dir(review_dir)
            self.assertEqual(fresh["status"], "FRESH")

            target.write_text("changed after review\n", encoding="utf-8")
            subprocess.run(["git", "commit", "-qam", "changed"], cwd=repo, check=True)
            stale, _ = self.verifier.verify_review_dir(review_dir)
            self.assertEqual(stale["status"], "STALE")
            self.assertEqual(stale["target_diff"]["status"], "changed")

    def test_standalone_checker_rejects_option_like_diff_range(self):
        report = self.verifier.build_report(
            {
                "schema_version": 1,
                "role": "correctness",
                "working_directory": "/tmp",
                "file_inputs": [],
                "target_diff": {
                    "range": "--output=/tmp/should-not-exist",
                    "sha256": "0" * 64,
                    "bytes": 0,
                },
            }
        )
        self.assertEqual(report["status"], "STALE")
        self.assertEqual(report["target_diff"]["status"], "invalid_range")

    def test_standalone_checker_labels_git_failure(self):
        with tempfile.TemporaryDirectory() as td:
            report = self.verifier.build_report(
                {
                    "schema_version": 1,
                    "role": "correctness",
                    "working_directory": td,
                    "file_inputs": [],
                    "target_diff": {
                        "range": "HEAD~1..HEAD",
                        "sha256": "0" * 64,
                        "bytes": 0,
                    },
                }
            )
            self.assertEqual(report["status"], "STALE")
            self.assertEqual(report["target_diff"]["status"], "diff_failed")

    def test_skill_and_source_template_pin_hash_scoping_rule(self):
        skill = (_SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        source_template = (_SKILL_ROOT / "templates" / "source-fidelity.md").read_text(
            encoding="utf-8"
        )
        integrity = (
            _SKILL_ROOT.parent / "research-integrity" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("verify_review_freshness.py", skill)
        self.assertIn("--review-dir /path/to/review-out", skill)
        self.assertIn("complete delta from the reviewed hash", source_template)
        self.assertIn("(n) stale review verdict", integrity)

    def test_review_one_diff_with_crlf_is_fresh(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
            )
            target = repo / "target.txt"
            target.write_bytes(b"base\r\n")
            subprocess.run(["git", "add", "target.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            target.write_bytes(b"reviewed\r\n")
            subprocess.run(["git", "commit", "-qam", "reviewed"], cwd=repo, check=True)
            runner = repo / "runner.sh"
            _write_ready_runner(runner)
            out_dir = repo / "review"

            proc = subprocess.run(
                [
                    sys.executable,
                    str(_REVIEW_ONE),
                    "--model",
                    "codex/default",
                    "--diff",
                    "HEAD~1..HEAD",
                    "--codex-runner",
                    str(runner),
                    "--out-dir",
                    str(out_dir),
                ],
                cwd=repo,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("acceptance_status: FRESH", proc.stdout)
            report = json.loads(
                (out_dir / "post_review_freshness.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["status"], "FRESH")
            self.assertEqual(report["target_diff"]["status"], "fresh")

    def test_review_one_fails_closed_when_runner_mutates_target(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "artifact.md"
            artifact.write_text("reviewed bytes\n", encoding="utf-8")
            runner = root / "runner.sh"
            _write_mutating_runner(runner, artifact)
            out_dir = root / "review"

            proc = subprocess.run(
                [
                    sys.executable,
                    str(_REVIEW_ONE),
                    "--model",
                    "codex/default",
                    "--artifact",
                    str(artifact),
                    "--codex-runner",
                    str(runner),
                    "--out-dir",
                    str(out_dir),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 86)
            self.assertIn("acceptance_status: STALE", proc.stdout)
            report = json.loads(
                (out_dir / "post_review_freshness.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["status"], "STALE")
            manifest = json.loads(
                (out_dir / "inputs" / "review_input_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            persisted = [
                entry
                for entry in manifest["file_inputs"]
                if entry["kind"] == "persisted_review_input"
            ]
            self.assertEqual(len(persisted), 2)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["agents"][0]["verdict"], "VERDICT: READY")
            self.assertEqual(meta["review_input_freshness"]["status"], "STALE")

    def test_review_one_fails_cleanly_when_manifest_disappears(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "artifact.md"
            artifact.write_text("reviewed bytes\n", encoding="utf-8")
            out_dir = root / "review"
            runner = root / "runner.sh"
            _write_manifest_deleting_runner(
                runner, out_dir / "inputs" / "review_input_manifest.json"
            )

            proc = subprocess.run(
                [
                    sys.executable,
                    str(_REVIEW_ONE),
                    "--model",
                    "codex/default",
                    "--artifact",
                    str(artifact),
                    "--codex-runner",
                    str(runner),
                    "--out-dir",
                    str(out_dir),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 86)
            self.assertIn("review freshness could not be verified", proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("acceptance_status: UNVERIFIABLE", proc.stdout)


if __name__ == "__main__":
    unittest.main()
