import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestRunCard(unittest.TestCase):
    def test_run_card_path_rejects_invalid_run_id(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import run_card_path

        root = Path("/tmp")
        for bad in ["", " ", "../escape", "bad/id", ".hidden", "a" * 129]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    run_card_path(repo_root=root, run_id=bad)

    def test_sha256_json_is_deterministic(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import sha256_json

        self.assertEqual(sha256_json({"b": 1, "a": 2}), sha256_json({"a": 2, "b": 1}))

    def test_ensure_run_card_creates_and_validates(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import ensure_run_card, sha256_json, validate_run_card

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rel, sha = ensure_run_card(repo_root=repo_root, run_id="M1-test", workflow_id="ingest")
            p = repo_root / rel
            self.assertTrue(p.exists())
            payload = json.loads(p.read_text(encoding="utf-8"))
            validate_run_card(payload)
            self.assertEqual(sha, sha256_json(payload))

    def test_ensure_run_card_is_idempotent_without_overwrite(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import ensure_run_card

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rel1, sha1 = ensure_run_card(repo_root=repo_root, run_id="M1-test", workflow_id="reproduce")
            rel2, sha2 = ensure_run_card(repo_root=repo_root, run_id="M1-test", workflow_id="reproduce")
            self.assertEqual(rel1, rel2)
            self.assertEqual(sha1, sha2)

    def test_ensure_run_card_overwrite_updates_payload(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import ensure_run_card

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rel1, sha1 = ensure_run_card(
                repo_root=repo_root,
                run_id="M1-test",
                workflow_id="reproduce",
                params={"a": 1},
            )
            rel2, sha2 = ensure_run_card(
                repo_root=repo_root,
                run_id="M1-test",
                workflow_id="reproduce",
                params={"a": 2},
                overwrite=True,
            )
            self.assertEqual(rel1, rel2)
            self.assertNotEqual(sha1, sha2)

    def test_ensure_run_card_validates_existing_file(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import ensure_run_card

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rel, _ = ensure_run_card(repo_root=repo_root, run_id="M1-test", workflow_id="ingest")
            p = repo_root / rel
            p.write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                ensure_run_card(repo_root=repo_root, run_id="M1-test", workflow_id="ingest")

    def test_ensure_run_card_falls_back_to_absolute_path_when_not_relative_to_repo_root(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_card import ensure_run_card

        with tempfile.TemporaryDirectory() as repo_td, tempfile.TemporaryDirectory() as external_td:
            repo_root = Path(repo_td)
            external_path = Path(external_td) / "run_card.json"
            with patch("hep_autoresearch.toolkit.run_card.run_card_path", return_value=external_path):
                rel, _ = ensure_run_card(repo_root=repo_root, run_id="M1-test", workflow_id="ingest")

            self.assertEqual(rel, str(external_path))
