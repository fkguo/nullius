#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


def _load_module():
    path = Path(__file__).resolve().parents[1] / "bin" / "paper_reviser_edit.py"
    spec = importlib.util.spec_from_file_location("paper_reviser_edit", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


paper_reviser_edit = _load_module()


class PaperReviserEditTests(unittest.TestCase):
    def test_extract_block_end_only_allows_implicit_begin(self) -> None:
        raw = (
            "VERDICT: READY\n\n"
            "## Non-blocking\n- none\n"
            "%%__CODEX_BLOCK__AUDIT_MD__END__\n"
        )
        got = paper_reviser_edit._extract_block(raw, name="AUDIT_MD", allow_implicit_begin=True)
        self.assertTrue(got.startswith("VERDICT: READY"))
        self.assertTrue(got.endswith("\n"))

    def test_extract_block_strict_mode_still_rejects_end_only(self) -> None:
        raw = "hello\n%%__CODEX_BLOCK__AUDIT_MD__END__\n"
        with self.assertRaises(paper_reviser_edit.BlockParseError):
            paper_reviser_edit._extract_block(raw, name="AUDIT_MD")

    def test_extract_block_end_only_does_not_swallow_previous_blocks(self) -> None:
        raw = (
            "%%__CODEX_BLOCK__VERIFICATION_REQUESTS_MD__BEGIN__\n"
            "previous block\n"
            "%%__CODEX_BLOCK__VERIFICATION_REQUESTS_MD__END__\n"
            "VERDICT: READY\n"
            "%%__CODEX_BLOCK__AUDIT_MD__END__\n"
        )
        got = paper_reviser_edit._extract_block(raw, name="AUDIT_MD", allow_implicit_begin=True)
        self.assertEqual(got, "VERDICT: READY\n")

    def test_clean_size_ratio_ignores_comment_only_shrink(self) -> None:
        original = (
            "% long archival note 1\n"
            "% long archival note 2\n"
            "\\section{Setup}\n"
            "Body text.\n"
        )
        clean = "\\section{Setup}\nBody text.\n"
        ratio = paper_reviser_edit._compute_clean_size_ratio(original, clean)
        self.assertGreaterEqual(ratio, 0.95)

    def test_count_non_comment_bytes_ignores_commented_comment_env_markers(self) -> None:
        tex = (
            "% \\begin{comment}\n"
            "visible text\n"
            "% \\end{comment}\n"
        )
        non_comment_bytes = paper_reviser_edit._count_non_comment_bytes(tex)
        self.assertGreater(non_comment_bytes, 0)

    def test_deep_verifier_timeout_stub_is_not_ready(self) -> None:
        md = paper_reviser_edit._build_deep_verification_timeout_stub(stage="deep_verify", timeout_seconds=120)
        self.assertIn("VERDICT: NOT_READY", md)
        self.assertIn("timed out", md.lower())
        self.assertIn("120", md)

    def test_timeout_fallback_accepts_secondary_ready_when_enabled(self) -> None:
        ok = paper_reviser_edit._deep_verifier_accepts_timeout_fallback(
            codex_verify=True,
            deep_verdict="NOT_READY",
            deep_verifier_timed_out=True,
            codex_timeout_policy="allow-secondary",
            secondary_backend_enabled=True,
            secondary_deep_verdict="READY",
        )
        self.assertTrue(ok)

    def test_timeout_fallback_rejects_when_secondary_not_ready(self) -> None:
        ok = paper_reviser_edit._deep_verifier_accepts_timeout_fallback(
            codex_verify=True,
            deep_verdict="NOT_READY",
            deep_verifier_timed_out=True,
            codex_timeout_policy="allow-secondary",
            secondary_backend_enabled=True,
            secondary_deep_verdict="NOT_READY",
        )
        self.assertFalse(ok)

    def test_timeout_fallback_rejects_when_policy_stub(self) -> None:
        ok = paper_reviser_edit._deep_verifier_accepts_timeout_fallback(
            codex_verify=True,
            deep_verdict="NOT_READY",
            deep_verifier_timed_out=True,
            codex_timeout_policy="stub",
            secondary_backend_enabled=True,
            secondary_deep_verdict="READY",
        )
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
