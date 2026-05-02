#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import textwrap
import unittest
from unittest import mock
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
    def _write_stub_runner(self, path: Path) -> None:
        path.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)

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

    def test_detect_revision_context_identifies_referee_response_without_filename_hint(self) -> None:
        tex = textwrap.dedent(
            r"""
            \section*{Response to Referee A}
            \subsection*{Comment 1}
            The referee asks about the novelty claim.

            \subsection*{Response}
            We clarified the comparison and revised the manuscript accordingly.

            \section*{Revised manuscript text}
            \section{Introduction}
            """
        ).strip() + "\n"
        ctx = paper_reviser_edit._detect_revision_context(tex=tex, extra_context="", readthrough_md="")
        self.assertEqual(ctx["mode"], "referee_response")
        self.assertGreaterEqual(len(ctx["signals"]), 2)

    def test_writer_prompt_in_referee_mode_makes_comments_read_only_and_demands_localization(self) -> None:
        prompt = paper_reviser_edit._system_prompt_writer(
            full_document=True,
            is_repair=True,
            document_mode="referee_response",
            correction_constraints=["Do not weaken author responses by generic politeness smoothing."],
        )
        self.assertIn("evidence-calibrated", prompt.lower())
        self.assertIn("referee comments are read-only", prompt.lower())
        self.assertIn("only modify author responses", prompt.lower())
        self.assertIn("localize every modification declaration", prompt.lower())
        self.assertIn("temporary global constraint", prompt.lower())

    def test_auditor_prompt_requires_claim_strength_and_full_text_literature_gate(self) -> None:
        prompt = paper_reviser_edit._system_prompt_auditor(document_mode="referee_response")
        self.assertIn("claim-strength audit", prompt.lower())
        self.assertIn("full text", prompt.lower())
        self.assertIn("title/abstract/metadata-only", prompt.lower())
        self.assertIn("response localization", prompt.lower())
        self.assertIn("referee comments remain read-only", prompt.lower())

    def test_postprocess_latexdiff_rewrites_default_palette_to_distinct_colors(self) -> None:
        raw = textwrap.dedent(
            r"""
            \RequirePackage{color}\definecolor{RED}{rgb}{1,0,0}\definecolor{BLUE}{rgb}{0,0,1}
            \providecommand{\DIFadd}[1]{{\protect\color{blue}\uwave{#1}}}
            \providecommand{\DIFdel}[1]{{\protect\color{red}\sout{#1}}}
            \textcolor{red}{Author text \DIFadd{new}.}
            """
        ).strip() + "\n"
        cooked = paper_reviser_edit._postprocess_latexdiff_tex(raw)
        self.assertIn("DIFADDCOLOR", cooked)
        self.assertIn("DIFDELCOLOR", cooked)
        self.assertIn(r"\providecommand{\DIFadd}[1]{{\protect\color{DIFADDCOLOR}\uwave{#1}}}", cooked)
        self.assertIn(r"\providecommand{\DIFdel}[1]{{\protect\color{DIFDELCOLOR}\sout{#1}}}", cooked)

    def test_postprocess_latexdiff_preserves_author_raw_color_usage(self) -> None:
        raw = textwrap.dedent(
            r"""
            \RequirePackage{color}
            \providecommand{\DIFadd}[1]{{\protect\color{blue}\uwave{#1}}}
            \providecommand{\DIFdel}[1]{{\protect\color{red}\sout{#1}}}
            {\color{red}Author raw red}
            {\color{blue}Author raw blue}
            """
        ).strip() + "\n"
        cooked = paper_reviser_edit._postprocess_latexdiff_tex(raw)
        self.assertIn(r"{\color{red}Author raw red}", cooked)
        self.assertIn(r"{\color{blue}Author raw blue}", cooked)
        self.assertIn(r"\color{DIFADDCOLOR}", cooked)
        self.assertIn(r"\color{DIFDELCOLOR}", cooked)

    def test_postprocess_latexdiff_preserves_same_line_author_red_with_difadd(self) -> None:
        raw = textwrap.dedent(
            r"""
            \RequirePackage{color}
            \providecommand{\DIFadd}[1]{{\protect\color{blue}\uwave{#1}}}
            {\color{red}Author raw \DIFadd{new}}
            """
        ).strip() + "\n"
        cooked = paper_reviser_edit._postprocess_latexdiff_tex(raw)
        self.assertIn(r"{\color{red}Author raw \DIFadd{new}}", cooked)
        self.assertIn(r"\providecommand{\DIFadd}[1]{{\protect\color{DIFADDCOLOR}\uwave{#1}}}", cooked)

    def test_postprocess_latexdiff_preserves_same_line_author_blue_with_difdel(self) -> None:
        raw = textwrap.dedent(
            r"""
            \RequirePackage{color}
            \providecommand{\DIFdel}[1]{{\protect\color{red}\sout{#1}}}
            {\color{blue}Author raw \DIFdel{old}}
            """
        ).strip() + "\n"
        cooked = paper_reviser_edit._postprocess_latexdiff_tex(raw)
        self.assertIn(r"{\color{blue}Author raw \DIFdel{old}}", cooked)
        self.assertIn(r"\providecommand{\DIFdel}[1]{{\protect\color{DIFDELCOLOR}\sout{#1}}}", cooked)

    def test_audit_color_diff_visibility_flags_missing_markers_inside_colored_change(self) -> None:
        original = r"\textcolor{red}{old statement}" + "\n"
        clean = r"\textcolor{red}{new statement}" + "\n"
        tracked = r"\textcolor{red}{new statement}" + "\n"
        warnings = paper_reviser_edit._audit_latexdiff_color_visibility(
            original=original,
            clean=clean,
            tracked=tracked,
        )
        self.assertTrue(any("colored revision" in w.lower() for w in warnings))

    def test_build_latexdiff_artifacts_refuses_comment_only_fallback_when_binary_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            original_path = tmp / "original.tex"
            clean_path = tmp / "clean.tex"
            original_path.write_text("\\documentclass{article}\n\\begin{document}\nOld.\n\\end{document}\n", encoding="utf-8")
            clean_path.write_text("\\documentclass{article}\n\\begin{document}\nNew.\n\\end{document}\n", encoding="utf-8")
            with mock.patch.object(paper_reviser_edit.shutil, "which", side_effect=lambda name: None if name == "latexdiff" else "/bin/true"):
                with self.assertRaises(RuntimeError):
                    paper_reviser_edit._build_latexdiff_artifacts(
                        original_path=original_path,
                        clean_path=clean_path,
                        original=original_path.read_text(encoding="utf-8"),
                        clean=clean_path.read_text(encoding="utf-8"),
                        out_dir=tmp,
                        full_document=True,
                    )

    def test_build_latexdiff_artifacts_generates_real_diff_for_colored_text(self) -> None:
        if not paper_reviser_edit.shutil.which("latexdiff"):
            self.skipTest("latexdiff not installed")
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            original = textwrap.dedent(
                r"""
                \documentclass{article}
                \usepackage{xcolor}
                \begin{document}
                \textcolor{red}{Author colored old text.}
                \end{document}
                """
            ).strip() + "\n"
            clean = textwrap.dedent(
                r"""
                \documentclass{article}
                \usepackage{xcolor}
                \begin{document}
                \textcolor{red}{Author colored new text.}
                \end{document}
                """
            ).strip() + "\n"
            original_path = tmp / "original.tex"
            clean_path = tmp / "clean.tex"
            original_path.write_text(original, encoding="utf-8")
            clean_path.write_text(clean, encoding="utf-8")
            audit = paper_reviser_edit._build_latexdiff_artifacts(
                original_path=original_path,
                clean_path=clean_path,
                original=original,
                clean=clean,
                out_dir=tmp,
                full_document=True,
            )
            tracked = (tmp / "tracked.tex").read_text(encoding="utf-8")
            self.assertIn(r"\DIFadd", tracked)
            self.assertIn(r"\textcolor{red}{Author colored", tracked)
            self.assertIn("DIFADDCOLOR", tracked)
            self.assertEqual(audit["status"], "ready")
            self.assertEqual(audit["compile_verification"]["status"], "not_run")
            self.assertFalse(audit["compile_verification"]["clean_pdf_verified"])
            self.assertFalse(audit["compile_verification"]["latexdiff_pdf_verified"])

    def test_response_localization_audit_marks_missing_anchor_as_not_verified(self) -> None:
        audit_md = paper_reviser_edit._build_response_localization_audit(
            document_mode="referee_response",
            changes_md="# Changes\n- Revised the response.\n",
            clean_tex="\\section{Intro}\nText.\n",
            tracked_tex="\\section{Intro}\nText.\n",
        )
        self.assertIn("NOT VERIFIED", audit_md)
        self.assertIn("referee_response", audit_md)

    def test_contract_blockers_fail_on_metadata_only_novelty_support(self) -> None:
        audit_md = textwrap.dedent(
            """
            VERDICT: READY

            NOVELTY_SUPPORT: METADATA_ONLY
            CLAIM_STRENGTH: PASS
            CORRECTION_CONVERGENCE: PASS
            """
        ).strip() + "\n"
        response_audit_md = textwrap.dedent(
            """
            # Response Revision Audit

            - document_mode: referee_response
            - localization_status: VERIFIED
            """
        ).strip() + "\n"
        blockers = paper_reviser_edit._collect_contract_blockers(
            document_mode="referee_response",
            audit_md=audit_md,
            response_revision_audit_md=response_audit_md,
            tracked_delivery={"status": "ready", "required": True},
        )
        self.assertTrue(any("metadata-only" in blocker.lower() for blocker in blockers))

    def test_contract_blockers_fail_on_unsupported_weakening_and_convergence_failure(self) -> None:
        audit_md = textwrap.dedent(
            """
            VERDICT: READY

            CLAIM_STRENGTH: FAIL
            CLAIM_STRENGTH_REASON: unsupported weakening of author response
            NOVELTY_SUPPORT: FULL_TEXT
            CORRECTION_CONVERGENCE: FAIL
            """
        ).strip() + "\n"
        response_audit_md = textwrap.dedent(
            """
            # Response Revision Audit

            - document_mode: referee_response
            - localization_status: VERIFIED
            """
        ).strip() + "\n"
        blockers = paper_reviser_edit._collect_contract_blockers(
            document_mode="referee_response",
            audit_md=audit_md,
            response_revision_audit_md=response_audit_md,
            tracked_delivery={"status": "ready", "required": True},
        )
        self.assertTrue(any("unsupported weakening" in blocker.lower() for blocker in blockers))
        self.assertTrue(any("correction-convergence" in blocker.lower() for blocker in blockers))

    def test_contract_blockers_fail_when_required_contract_fields_missing(self) -> None:
        audit_md = "VERDICT: READY\n\n## Non-blocking\n- none\n"
        response_audit_md = textwrap.dedent(
            """
            # Response Revision Audit

            - document_mode: paper_revision
            - localization_status: VERIFIED
            """
        ).strip() + "\n"
        blockers = paper_reviser_edit._collect_contract_blockers(
            document_mode="paper_revision",
            audit_md=audit_md,
            response_revision_audit_md=response_audit_md,
            tracked_delivery={"status": "ready", "required": True},
        )
        joined = "\n".join(blockers).lower()
        self.assertIn("claim_strength", joined)
        self.assertIn("novelty_support", joined)
        self.assertIn("correction_convergence", joined)

    def test_contract_blockers_fail_when_required_contract_fields_illegal(self) -> None:
        audit_md = textwrap.dedent(
            """
            VERDICT: READY
            CLAIM_STRENGTH: MAYBE
            NOVELTY_SUPPORT: PARTIAL
            CORRECTION_CONVERGENCE: UNKNOWN
            """
        ).strip() + "\n"
        response_audit_md = textwrap.dedent(
            """
            # Response Revision Audit

            - document_mode: paper_revision
            - localization_status: VERIFIED
            """
        ).strip() + "\n"
        blockers = paper_reviser_edit._collect_contract_blockers(
            document_mode="paper_revision",
            audit_md=audit_md,
            response_revision_audit_md=response_audit_md,
            tracked_delivery={"status": "ready", "required": True},
        )
        joined = "\n".join(blockers).lower()
        self.assertIn("illegal", joined)
        self.assertIn("claim_strength", joined)
        self.assertIn("novelty_support", joined)
        self.assertIn("correction_convergence", joined)

    def test_main_marks_full_document_latexdiff_missing_as_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            input_tex = tmp / "draft.tex"
            input_tex.write_text(
                "\\documentclass{article}\n\\begin{document}\nOld.\n\\end{document}\n",
                encoding="utf-8",
            )
            out_dir = tmp / "out"
            claude_runner = tmp / "claude.sh"
            gemini_runner = tmp / "gemini.sh"
            self._write_stub_runner(claude_runner)
            self._write_stub_runner(gemini_runner)

            argv = [
                "paper_reviser_edit.py",
                "--in",
                str(input_tex),
                "--out-dir",
                str(out_dir),
                "--stub-models",
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
            ]
            with mock.patch.object(sys, "argv", argv):
                with mock.patch.object(
                    paper_reviser_edit.shutil,
                    "which",
                    side_effect=lambda name: None if name == "latexdiff" else "/bin/true",
                ):
                    rc = paper_reviser_edit.main()

            self.assertEqual(rc, 1)
            run = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
            self.assertFalse(run["converged"])
            self.assertEqual(run["tracked_delivery"]["status"], "not_ready")
            self.assertTrue(run["tracked_delivery"]["required"])
            self.assertIsNone(run["tracked_delivery"]["artifact_path"])
            self.assertEqual(run["tracked_delivery"]["delivery_kind"], "latexdiff_required")
            self.assertEqual(run["auditor_verdict"], "NOT_READY")
            self.assertFalse((out_dir / "tracked.tex").exists())
            self.assertIn("latexdiff", (out_dir / "audit.md").read_text(encoding="utf-8").lower())
            self.assertIn("response_revision_audit.md", run["artifacts"])

    def test_main_referee_response_missing_anchor_forces_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            input_tex = tmp / "draft.tex"
            input_tex.write_text(
                "\\documentclass{article}\n\\begin{document}\nOld.\n\\end{document}\n",
                encoding="utf-8",
            )
            out_dir = tmp / "out"
            claude_runner = tmp / "claude.sh"
            gemini_runner = tmp / "gemini.sh"
            self._write_stub_runner(claude_runner)
            self._write_stub_runner(gemini_runner)
            argv = [
                "paper_reviser_edit.py",
                "--in",
                str(input_tex),
                "--out-dir",
                str(out_dir),
                "--stub-models",
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
            ]
            fake_response_audit = (
                "# Response Revision Audit\n\n"
                "- document_mode: referee_response\n"
                "- localization_status: NOT VERIFIED\n"
            )
            with mock.patch.object(sys, "argv", argv):
                with mock.patch.object(
                    paper_reviser_edit,
                    "_detect_revision_context",
                    return_value={"mode": "referee_response", "signals": ["test"], "score": 3},
                ):
                    with mock.patch.object(
                        paper_reviser_edit,
                        "_build_response_localization_audit",
                        return_value=fake_response_audit,
                    ):
                        rc = paper_reviser_edit.main()

            self.assertEqual(rc, 1)
            run = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
            self.assertFalse(run["converged"])
            self.assertEqual(run["auditor_verdict"], "NOT_READY")
            audit_md = (out_dir / "audit.md").read_text(encoding="utf-8")
            self.assertIn("response localization", audit_md.lower())

    def test_main_marks_fragment_audit_view_as_non_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            input_tex = tmp / "fragment.tex"
            input_tex.write_text("\\section{Intro}\nOld.\n", encoding="utf-8")
            out_dir = tmp / "out"
            claude_runner = tmp / "claude.sh"
            gemini_runner = tmp / "gemini.sh"
            self._write_stub_runner(claude_runner)
            self._write_stub_runner(gemini_runner)

            argv = [
                "paper_reviser_edit.py",
                "--in",
                str(input_tex),
                "--out-dir",
                str(out_dir),
                "--stub-models",
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
            ]
            with mock.patch.object(sys, "argv", argv):
                rc = paper_reviser_edit.main()

            self.assertEqual(rc, 0)
            run = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(run["tracked_delivery"]["status"], "audit_only")
            self.assertFalse(run["tracked_delivery"]["valid_tracked_delivery"])
            self.assertEqual(run["tracked_delivery"]["delivery_kind"], "fragment_audit_view")
            self.assertFalse((out_dir / "tracked.tex").exists())
            fragment_audit = out_dir / "tracked_fragment_audit.tex"
            self.assertTrue(fragment_audit.is_file())
            self.assertEqual(Path(run["tracked_delivery"]["artifact_path"]).resolve(), fragment_audit.resolve())

    def test_main_marks_full_document_latexdiff_nonzero_as_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            input_tex = tmp / "draft.tex"
            input_tex.write_text("\\documentclass{article}\n\\begin{document}\nOld.\n\\end{document}\n", encoding="utf-8")
            out_dir = tmp / "out"
            claude_runner = tmp / "claude.sh"
            gemini_runner = tmp / "gemini.sh"
            self._write_stub_runner(claude_runner)
            self._write_stub_runner(gemini_runner)
            argv = [
                "paper_reviser_edit.py",
                "--in",
                str(input_tex),
                "--out-dir",
                str(out_dir),
                "--stub-models",
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
            ]
            fake_proc = mock.Mock(returncode=2, stdout="", stderr="boom")
            with mock.patch.object(sys, "argv", argv):
                with mock.patch.object(
                    paper_reviser_edit.shutil,
                    "which",
                    side_effect=lambda name: "/usr/bin/latexdiff" if name == "latexdiff" else "/bin/true",
                ):
                    with mock.patch.object(paper_reviser_edit.subprocess, "run", return_value=fake_proc):
                        rc = paper_reviser_edit.main()
            run = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(rc, 1)
            self.assertFalse(run["converged"])
            self.assertEqual(run["tracked_delivery"]["status"], "not_ready")
            self.assertEqual(run["auditor_verdict"], "NOT_READY")
            self.assertFalse((out_dir / "tracked.tex").exists())

    def test_main_marks_full_document_latexdiff_empty_stdout_as_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            input_tex = tmp / "draft.tex"
            input_tex.write_text("\\documentclass{article}\n\\begin{document}\nOld.\n\\end{document}\n", encoding="utf-8")
            out_dir = tmp / "out"
            claude_runner = tmp / "claude.sh"
            gemini_runner = tmp / "gemini.sh"
            self._write_stub_runner(claude_runner)
            self._write_stub_runner(gemini_runner)
            argv = [
                "paper_reviser_edit.py",
                "--in",
                str(input_tex),
                "--out-dir",
                str(out_dir),
                "--stub-models",
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
            ]
            fake_proc = mock.Mock(returncode=0, stdout="   ", stderr="")
            with mock.patch.object(sys, "argv", argv):
                with mock.patch.object(
                    paper_reviser_edit.shutil,
                    "which",
                    side_effect=lambda name: "/usr/bin/latexdiff" if name == "latexdiff" else "/bin/true",
                ):
                    with mock.patch.object(paper_reviser_edit.subprocess, "run", return_value=fake_proc):
                        rc = paper_reviser_edit.main()
            run = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(rc, 1)
            self.assertFalse(run["converged"])
            self.assertEqual(run["tracked_delivery"]["status"], "not_ready")
            self.assertEqual(run["auditor_verdict"], "NOT_READY")
            self.assertFalse((out_dir / "tracked.tex").exists())

    def test_skill_docs_and_marketplace_describe_new_contracts(self) -> None:
        skill_dir = Path(__file__).resolve().parents[2]
        md = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        zh = (skill_dir / "SKILL.zh.md").read_text(encoding="utf-8")
        market = (Path(__file__).resolve().parents[4] / "packages" / "skills-market" / "packages" / "paper-reviser.json").read_text(
            encoding="utf-8"
        )

        combined = "\n".join([md.lower(), zh.lower(), market.lower()])
        self.assertIn("evidence-calibrated", combined)
        self.assertIn("claim-strength", combined)
        self.assertIn("referee comments", combined)
        self.assertIn("read-only", combined)
        self.assertIn("author color", combined)
        self.assertIn("latexdiff", combined)
        self.assertIn("novelty", combined)
        self.assertIn("correction-convergence", combined)
        self.assertIn("response_revision_audit.md", combined)
        self.assertIn("does not provide a generic tex compile/fix runtime", md.lower())
        self.assertIn("substitute the clean pdf for the diff pdf", md.lower())
        self.assertIn("通用 TeX 编译/修复引擎", zh)
        self.assertIn("冒充 diff PDF", zh)


if __name__ == "__main__":
    unittest.main()
