import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


def _load_bin_module(name: str):
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_trace_events(trace_path: Path) -> list[dict]:
    if not trace_path.exists():
        return []
    return [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _run_main_with_argv(mod, argv: list[str]) -> int:
    import sys as _sys

    old_argv = _sys.argv
    try:
        _sys.argv = argv
        return mod.main()
    finally:
        _sys.argv = old_argv


_PHASE1_VALID = """Commitment before seeing the diff.

<review_criteria>
{"categories": [{"name": "correctness", "blocking_criteria": "Any defect that changes runtime behavior."}, {"name": "tests", "blocking_criteria": "Any changed behavior without regression coverage."}], "severity_scale": "Findings are BLOCKING or NON-BLOCKING."}
</review_criteria>
"""

_PHASE1_NO_BLOCK = """I would review this carefully, focusing on correctness.
"""

_PHASE2_COMPLIANT = """VERDICT: NOT_READY

## Blockers
- [correctness] the loop drops the final element

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- n/a
"""

_PHASE2_OUT_OF_SCOPE = """VERDICT: NOT_READY

## Blockers
- [security] new network call without input validation

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- n/a
"""

_PHASE2_OUT_OF_SCOPE_WITH_REVISION = """VERDICT: NOT_READY

## Blockers
- [security] new network call without input validation

CRITERIA_REVISION: security: the diff adds a network surface the scope did not disclose

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- n/a
"""


_PHASE2_JSON_COMPLIANT = json.dumps(
    {
        "verdict": "FAIL",
        "blocking_issues": ["[correctness] the loop drops the final element"],
        "summary": "one blocking finding",
    }
)


def _write_two_phase_stub(
    path: Path,
    *,
    phase1_payload: str = _PHASE1_VALID,
    phase2_payload: str = _PHASE2_COMPLIANT,
    phase1_exit: int = 0,
    phase2_exit: int = 0,
) -> None:
    """Stub CLI runner that branches on the phase-1 instruction marker in the prompt."""
    script = f"""#!/usr/bin/env bash
set -euo pipefail
out=""
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if grep -q "PHASE 1: CRITERIA COMMITMENT" "${{prompt}}"; then
  if [[ {phase1_exit} -ne 0 ]]; then
    exit {phase1_exit}
  fi
  cat >"${{out}}" <<'PHASE1_PAYLOAD'
{phase1_payload}
PHASE1_PAYLOAD
else
  if [[ {phase2_exit} -ne 0 ]]; then
    exit {phase2_exit}
  fi
  cat >"${{out}}" <<'PHASE2_PAYLOAD'
{phase2_payload}
PHASE2_PAYLOAD
fi
"""
    path.write_text(script, encoding="utf-8")
    path.chmod(0o755)


def _write_single_phase_stub(path: Path) -> None:
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
cat >"${out}" <<'TXT'
VERDICT: READY
TXT
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


class CriteriaBlockParsingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rc = _load_bin_module("review_contract")

    def test_valid_block_parses(self):
        block, obj, errs = self.rc.extract_review_criteria_block(_PHASE1_VALID)
        self.assertEqual(errs, [])
        self.assertIsNotNone(obj)
        self.assertTrue(block.startswith("<review_criteria>"))
        self.assertTrue(block.endswith("</review_criteria>"))
        self.assertEqual(self.rc.declared_criteria_categories(obj), ["correctness", "tests"])

    def test_valid_block_with_json_fences_inside_sentinels(self):
        text = (
            "<review_criteria>\n"
            "```json\n"
            '{"categories": [{"name": "correctness", "blocking_criteria": "x"}], "severity_scale": "s"}\n'
            "```\n"
            "</review_criteria>\n"
        )
        _, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertEqual(errs, [])
        self.assertEqual(self.rc.declared_criteria_categories(obj), ["correctness"])

    def test_missing_block_reports_error(self):
        block, obj, errs = self.rc.extract_review_criteria_block(_PHASE1_NO_BLOCK)
        self.assertIsNone(block)
        self.assertIsNone(obj)
        self.assertEqual(len(errs), 1)
        self.assertIn("<review_criteria>", errs[0])

    def test_unterminated_block_reports_error(self):
        text = '<review_criteria>\n{"categories": []}\n'
        _, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertIsNone(obj)
        self.assertTrue(any("</review_criteria>" in e for e in errs))

    def test_multiple_blocks_report_error(self):
        text = _PHASE1_VALID + "\n" + _PHASE1_VALID
        _, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertIsNone(obj)
        self.assertTrue(any("multiple" in e for e in errs))

    def test_empty_block_reports_error(self):
        text = "<review_criteria>\n\n</review_criteria>\n"
        block, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertIsNotNone(block)
        self.assertIsNone(obj)
        self.assertTrue(any("empty" in e for e in errs))

    def test_malformed_json_reports_error(self):
        text = "<review_criteria>\nnot json at all\n</review_criteria>\n"
        block, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertIsNotNone(block)
        self.assertIsNone(obj)
        self.assertTrue(any("not valid JSON" in e for e in errs))

    def test_empty_categories_and_missing_scale_report_errors(self):
        text = '<review_criteria>\n{"categories": []}\n</review_criteria>\n'
        _, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertIsNone(obj)
        self.assertTrue(any("'categories'" in e for e in errs))
        self.assertTrue(any("'severity_scale'" in e for e in errs))

    def test_category_entry_field_violations_report_errors(self):
        text = (
            "<review_criteria>\n"
            '{"categories": [{"name": "", "blocking_criteria": "x"}, {"name": "ok"}], "severity_scale": "s"}\n'
            "</review_criteria>\n"
        )
        _, obj, errs = self.rc.extract_review_criteria_block(text)
        self.assertIsNone(obj)
        self.assertTrue(any("categories[0].name" in e for e in errs))
        self.assertTrue(any("categories[1].blocking_criteria" in e for e in errs))


class TwoPhaseConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rc = _load_bin_module("review_contract")

    def test_markdown_compliant_within_declared_categories(self):
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, _PHASE2_COMPLIANT)
        self.assertEqual(errs, [])

    def test_markdown_category_normalization(self):
        phase1 = (
            "<review_criteria>\n"
            '{"categories": [{"name": "Error Handling", "blocking_criteria": "x"}], "severity_scale": "s"}\n'
            "</review_criteria>\n"
        )
        phase2 = _PHASE2_COMPLIANT.replace("[correctness]", "[error_handling]")
        errs = self.rc.check_two_phase_conformance(phase1, phase2)
        self.assertEqual(errs, [])

    def test_markdown_out_of_scope_with_revision_declaration_passes(self):
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, _PHASE2_OUT_OF_SCOPE_WITH_REVISION)
        self.assertEqual(errs, [])

    def test_markdown_out_of_scope_without_declaration_fails(self):
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, _PHASE2_OUT_OF_SCOPE)
        self.assertEqual(len(errs), 1)
        self.assertIn("'security'", errs[0])
        self.assertIn("criteria revision", errs[0])

    def test_markdown_finding_without_category_tag_fails(self):
        phase2 = _PHASE2_COMPLIANT.replace("- [correctness] ", "- ")
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(len(errs), 1)
        self.assertIn("no [<category>] tag", errs[0])

    def test_markdown_placeholder_bullets_are_not_findings(self):
        for placeholder in (
            "- none",
            "- N/A",
            "- No blockers found.",
            "- None identified",
            "- No blocking issues.",
        ):
            phase2 = _PHASE2_COMPLIANT.replace(
                "- [correctness] the loop drops the final element", placeholder
            )
            errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
            self.assertEqual(errs, [], f"placeholder {placeholder!r} should be exempt")

    def test_markdown_plain_text_placeholder_is_allowed(self):
        # A column-0 "None." without a bullet is a placeholder, not
        # unstructured content.
        phase2 = _PHASE2_COMPLIANT.replace(
            "- [correctness] the loop drops the final element", "None."
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_markdown_indented_tagged_bullet_is_category_checked(self):
        # A category-tagged bullet at ANY indent is a finding; nesting must not
        # be an evasion channel for out-of-scope BLOCKING findings.
        phase2 = _PHASE2_COMPLIANT.replace(
            "- [correctness] the loop drops the final element",
            "- [correctness] the loop drops the final element\n  - [security] smuggled nested finding",
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(len(errs), 1)
        self.assertIn("'security'", errs[0])

    def test_markdown_indented_tagged_in_scope_bullet_passes(self):
        phase2 = _PHASE2_COMPLIANT.replace(
            "- [correctness] the loop drops the final element",
            "- [correctness] the loop drops the final element\n  - [tests] missing regression coverage",
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_markdown_decorated_blockers_header_is_recognized(self):
        phase2 = _PHASE2_COMPLIANT.replace("## Blockers", "## Blockers (critical)")
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_markdown_missing_blockers_section_fails(self):
        phase2 = _PHASE2_COMPLIANT.replace("## Blockers", "## Findings")
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertTrue(any("## Blockers" in e for e in errs))

    def test_markdown_plain_text_finding_under_blockers_fails(self):
        # A finding written as column-0 prose (not a bullet) must not silently
        # evade the category conformance check.
        phase2 = _PHASE2_COMPLIANT.replace(
            "- [correctness] the loop drops the final element",
            "[security] a finding smuggled in as plain text",
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertTrue(any("unstructured content" in e for e in errs))

    def test_markdown_indented_continuation_lines_are_allowed(self):
        phase2 = _PHASE2_COMPLIANT.replace(
            "- [correctness] the loop drops the final element",
            "- [correctness] the loop drops the final element\n  because the bound is exclusive",
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_markdown_malformed_revision_line_fails(self):
        phase2 = _PHASE2_OUT_OF_SCOPE_WITH_REVISION.replace(
            "CRITERIA_REVISION: security: the diff adds a network surface the scope did not disclose",
            "CRITERIA_REVISION: security:",
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertTrue(any("malformed criteria revision" in e for e in errs))
        # The out-of-scope finding is also no longer covered.
        self.assertTrue(any("'security'" in e for e in errs))

    def test_markdown_bulleted_revision_line_not_treated_as_finding(self):
        phase2 = _PHASE2_OUT_OF_SCOPE_WITH_REVISION.replace(
            "CRITERIA_REVISION: security:",
            "- CRITERIA_REVISION: security:",
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_json_compliant_passes(self):
        phase2 = json.dumps(
            {
                "verdict": "FAIL",
                "blocking_issues": ["[correctness] the loop drops the final element"],
                "summary": "one blocking finding",
            }
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_json_object_entries_with_category_field_pass(self):
        phase2 = json.dumps(
            {
                "verdict": "FAIL",
                "blocking_issues": [{"category": "tests", "issue": "no regression coverage"}],
                "summary": "one blocking finding",
            }
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_json_out_of_scope_with_revisions_field_passes(self):
        phase2 = json.dumps(
            {
                "verdict": "FAIL",
                "blocking_issues": ["[security] new network call without input validation"],
                "criteria_revisions": [
                    {"category": "security", "reason": "the diff adds an undisclosed network surface"}
                ],
                "summary": "one blocking finding",
            }
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(errs, [])

    def test_json_out_of_scope_without_declaration_fails(self):
        phase2 = json.dumps(
            {
                "verdict": "FAIL",
                "blocking_issues": ["[security] new network call without input validation"],
                "summary": "one blocking finding",
            }
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertEqual(len(errs), 1)
        self.assertIn("'security'", errs[0])

    def test_json_malformed_revision_entry_fails(self):
        phase2 = json.dumps(
            {
                "verdict": "FAIL",
                "blocking_issues": ["[security] new network call"],
                "criteria_revisions": [{"category": "security", "reason": ""}],
                "summary": "one blocking finding",
            }
        )
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, phase2)
        self.assertTrue(any("criteria_revisions[0].reason" in e for e in errs))
        self.assertTrue(any("'security'" in e for e in errs))

    def test_json_invalid_output_fails(self):
        errs = self.rc.check_two_phase_conformance(_PHASE1_VALID, "{not json")
        self.assertEqual(len(errs), 1)
        self.assertIn("not valid JSON", errs[0])

    def test_invalid_phase1_criteria_reported_with_phase1_prefix(self):
        errs = self.rc.check_two_phase_conformance(_PHASE1_NO_BLOCK, _PHASE2_COMPLIANT)
        self.assertTrue(errs)
        self.assertTrue(all(e.startswith("phase1:") for e in errs))


class TwoPhaseCheckerCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.checker = _load_bin_module("check_review_output_contract")

    def test_two_phase_mode_ok_and_fail_paths(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            phase1 = td_path / "phase1.txt"
            phase2_ok = td_path / "phase2_ok.txt"
            phase2_bad = td_path / "phase2_bad.txt"
            phase1.write_text(_PHASE1_VALID, encoding="utf-8")
            phase2_ok.write_text(_PHASE2_COMPLIANT, encoding="utf-8")
            phase2_bad.write_text(_PHASE2_OUT_OF_SCOPE, encoding="utf-8")

            self.assertEqual(
                self.checker.main(["prog", "--two-phase", str(phase1), str(phase2_ok)]), 0
            )
            self.assertEqual(
                self.checker.main(["prog", "--two-phase", str(phase1), str(phase2_bad)]), 1
            )

    def test_two_phase_mode_wrong_arity_is_usage_error(self):
        self.assertEqual(self.checker.main(["prog", "--two-phase", "only_one"]), 2)

    def test_two_phase_mode_missing_file_fails(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            phase1 = td_path / "phase1.txt"
            phase1.write_text(_PHASE1_VALID, encoding="utf-8")
            code = self.checker.main(
                ["prog", "--two-phase", str(phase1), str(td_path / "missing.txt")]
            )
            self.assertEqual(code, 1)


class TwoPhaseFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_bin_module("run_multi_task")
        # Disable project config auto-discovery so tests are hermetic.
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def _base_paths(self, td_path: Path):
        out_dir = td_path / "out"
        system = td_path / "system.md"
        prompt = td_path / "prompt.md"
        scope = td_path / "scope.md"
        runner = td_path / "run_claude.sh"
        system.write_text("SYSTEM\n", encoding="utf-8")
        prompt.write_text("DIFF PACKET CONTENT\n", encoding="utf-8")
        scope.write_text("SCOPE PACKET CONTENT\n", encoding="utf-8")
        return out_dir, system, prompt, scope, runner

    def _argv(self, out_dir, system, prompt, scope, runner, *extra):
        return [
            "run_multi_task.py",
            "--out-dir",
            str(out_dir),
            "--claude-runner",
            str(runner),
            "--system",
            str(system),
            "--prompt",
            str(prompt),
            "--scope-prompt",
            str(scope),
            "--models",
            "claude/default",
            "--two-phase",
            "--no-parallel",
            *extra,
        ]

    def test_two_phase_happy_path(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner)

            argv = self._argv(out_dir, system, prompt, scope, runner, "--check-review-contract")
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            # Phase artifacts exist and separate the packets correctly.
            phase1_out = out_dir / "agent_1_claude_default.phase1.txt"
            final_out = out_dir / "agent_1_claude_default.txt"
            phase1_prompt = out_dir / "two_phase" / "phase1_prompt_agent_1_claude_default.md"
            phase2_prompt = out_dir / "two_phase" / "phase2_prompt_agent_1_claude_default.md"
            self.assertTrue(phase1_out.exists())
            self.assertTrue(final_out.exists())

            phase1_prompt_text = phase1_prompt.read_text(encoding="utf-8")
            self.assertIn("SCOPE PACKET CONTENT", phase1_prompt_text)
            self.assertNotIn("DIFF PACKET CONTENT", phase1_prompt_text)

            phase2_prompt_text = phase2_prompt.read_text(encoding="utf-8")
            self.assertIn("<review_criteria>", phase2_prompt_text)
            self.assertIn("DIFF PACKET CONTENT", phase2_prompt_text)
            self.assertNotIn("SCOPE PACKET CONTENT", phase2_prompt_text)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["success_count"], 1)
            self.assertEqual(meta["two_phase"], {"enabled": True, "scope_prompt": str(scope.resolve())})
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertTrue(agent["contract_ok"])
            self.assertEqual(agent["verdict"], "VERDICT: NOT_READY")
            info = agent["two_phase"]
            self.assertTrue(info["criteria_ok"])
            self.assertEqual(info["declared_categories"], ["correctness", "tests"])
            self.assertTrue(info["conformance_ok"])
            self.assertEqual(info["conformance_errors"], [])
            self.assertIsNone(info["failure"])

            events = _read_trace_events(out_dir / "trace.jsonl")
            config_event = next(e for e in events if e.get("event") == "config")
            self.assertTrue(config_event["two_phase"])
            two_phase_event = next(e for e in events if e.get("event") == "agent_0_two_phase")
            self.assertTrue(two_phase_event["conformance_ok"])

    def test_two_phase_conformance_violation_is_informational(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase2_payload=_PHASE2_OUT_OF_SCOPE)

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            # Conformance failure follows the informational contract-check path.
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertIsNone(agent["failure_reason"])
            info = agent["two_phase"]
            self.assertTrue(info["criteria_ok"])
            self.assertFalse(info["conformance_ok"])
            self.assertTrue(any("'security'" in e for e in info["conformance_errors"]))

    def test_two_phase_out_of_scope_with_revision_passes_conformance(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase2_payload=_PHASE2_OUT_OF_SCOPE_WITH_REVISION)

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            info = meta["agents"][0]["two_phase"]
            self.assertTrue(info["conformance_ok"])
            self.assertEqual(info["conformance_errors"], [])

    def test_two_phase_phase1_missing_criteria_fails_agent(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase1_payload=_PHASE1_NO_BLOCK)

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            self.assertEqual(code, 2)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["success_count"], 0)
            agent = meta["agents"][0]
            self.assertFalse(agent["success"])
            self.assertEqual(agent["failure_reason"], "phase1_criteria_invalid")
            info = agent["two_phase"]
            self.assertFalse(info["criteria_ok"])
            self.assertTrue(info["criteria_errors"])
            self.assertIsNone(info["phase2_prompt"])
            # Phase 2 never ran.
            self.assertFalse((out_dir / "two_phase" / "phase2_prompt_agent_1_claude_default.md").exists())
            self.assertFalse((out_dir / "agent_1_claude_default.txt").exists())

    def test_two_phase_phase1_command_failure_skips_phase2(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase1_exit=7)

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            self.assertEqual(code, 2)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertFalse(agent["success"])
            self.assertEqual(agent["failure_reason"], "phase1_command_failed")
            self.assertEqual(agent["two_phase"]["phase1_exit_code"], 7)
            self.assertFalse((out_dir / "two_phase" / "phase2_prompt_agent_1_claude_default.md").exists())

    def test_two_phase_phase1_empty_output_fails_agent(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase1_payload="")

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            self.assertEqual(code, 2)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertFalse(agent["success"])
            self.assertEqual(agent["failure_reason"], "phase1_empty_output")
            self.assertFalse((out_dir / "two_phase" / "phase2_prompt_agent_1_claude_default.md").exists())

    def test_two_phase_phase2_command_failure_uses_generic_failure_path(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase2_exit=9)

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            self.assertEqual(code, 2)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertFalse(agent["success"])
            self.assertEqual(agent["failure_reason"], "exit_code_9")
            info = agent["two_phase"]
            # Phase 1 was fine; the failure is a plain phase-2 command failure.
            self.assertIsNone(info["failure"])
            self.assertTrue(info["criteria_ok"])
            self.assertIsNone(info["conformance_ok"])

    def test_two_phase_json_phase2_output_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase2_payload=_PHASE2_JSON_COMPLIANT)

            argv = self._argv(out_dir, system, prompt, scope, runner, "--check-review-contract")
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertTrue(agent["contract_ok"])
            self.assertEqual(agent["verdict"], "VERDICT: NOT_READY")
            info = agent["two_phase"]
            self.assertTrue(info["criteria_ok"])
            self.assertTrue(info["conformance_ok"])

    def test_two_phase_with_backend_output_override(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner)

            argv = self._argv(
                out_dir, system, prompt, scope, runner, "--backend-output", "claude=custom_review.md"
            )
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            final_out = out_dir / "custom_review.md"
            phase1_out = out_dir / "custom_review.phase1.md"
            self.assertTrue(final_out.exists())
            self.assertTrue(phase1_out.exists())
            self.assertIn("<review_criteria>", phase1_out.read_text(encoding="utf-8"))
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            # Overrides are resolved (macOS /var vs /private/var), so compare
            # resolved paths.
            self.assertEqual(Path(agent["out"]), final_out.resolve())
            self.assertEqual(Path(agent["two_phase"]["phase1_out"]), phase1_out.resolve())
            self.assertTrue(agent["two_phase"]["conformance_ok"])

    def test_two_phase_phase1_timeout_marks_command_failure(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            runner.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
out=""
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if grep -q "PHASE 1: CRITERIA COMMITMENT" "${prompt}"; then
  sleep 5
fi
cat >"${out}" <<'TXT'
unreachable for phase 1
TXT
""",
                encoding="utf-8",
            )
            runner.chmod(0o755)

            argv = self._argv(out_dir, system, prompt, scope, runner, "--timeout-secs", "1")
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 2)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertEqual(agent["failure_reason"], "phase1_command_failed")
            info = agent["two_phase"]
            self.assertTrue(info["phase1_timed_out"])
            self.assertIsNone(info["phase1_exit_code"])
            self.assertFalse((out_dir / "two_phase" / "phase2_prompt_agent_1_claude_default.md").exists())

    def test_two_phase_parallel_multi_agent(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, claude_runner = self._base_paths(td_path)
            codex_runner = td_path / "run_codex.sh"
            _write_two_phase_stub(claude_runner)
            _write_two_phase_stub(codex_runner, phase2_payload=_PHASE2_JSON_COMPLIANT)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(claude_runner),
                "--codex-runner",
                str(codex_runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--scope-prompt",
                str(scope),
                "--models",
                "claude/default,codex/default",
                "--two-phase",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["success_count"], 2)
            for agent in meta["agents"]:
                info = agent["two_phase"]
                self.assertTrue(info["criteria_ok"])
                self.assertTrue(info["conformance_ok"])
            phase_files = sorted(p.name for p in (out_dir / "two_phase").iterdir())
            self.assertEqual(
                phase_files,
                [
                    "phase1_prompt_agent_1_claude_default.md",
                    "phase1_prompt_agent_2_codex_default.md",
                    "phase2_prompt_agent_1_claude_default.md",
                    "phase2_prompt_agent_2_codex_default.md",
                ],
            )

            events = _read_trace_events(out_dir / "trace.jsonl")
            start_phases = sorted(
                (e["index"], e["phase"]) for e in events if str(e.get("event", "")).endswith("_start")
            )
            self.assertEqual(start_phases, [(0, "phase1"), (0, "phase2"), (1, "phase1"), (1, "phase2")])

    def test_two_phase_requires_scope_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, _, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--models",
                "claude/default",
                "--two-phase",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 2)
            events = _read_trace_events(out_dir / "trace.jsonl")
            input_errors = [e for e in events if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("--scope-prompt", input_errors[-1].get("error", ""))

    def test_scope_prompt_requires_two_phase(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--scope-prompt",
                str(scope),
                "--models",
                "claude/default",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 2)
            events = _read_trace_events(out_dir / "trace.jsonl")
            input_errors = [e for e in events if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("--two-phase", input_errors[-1].get("error", ""))

    def test_two_phase_rejects_fallback_mode(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner)

            argv = self._argv(out_dir, system, prompt, scope, runner, "--fallback-mode", "auto")
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 2)
            events = _read_trace_events(out_dir / "trace.jsonl")
            input_errors = [e for e in events if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("--fallback-mode", input_errors[-1].get("error", ""))

    def test_two_phase_stale_final_output_is_removed_on_phase1_failure(self):
        """A reused out-dir must not leak a stale phase-2 output into the result."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_two_phase_stub(runner, phase1_exit=7)

            out_dir.mkdir(parents=True, exist_ok=True)
            stale_final = out_dir / "agent_1_claude_default.txt"
            stale_final.write_text(_PHASE2_COMPLIANT, encoding="utf-8")
            stale_phase1 = out_dir / "agent_1_claude_default.phase1.txt"
            stale_phase1.write_text(_PHASE1_VALID, encoding="utf-8")

            code = _run_main_with_argv(self.mod, self._argv(out_dir, system, prompt, scope, runner))
            self.assertEqual(code, 2)

            self.assertFalse(stale_final.exists())
            self.assertFalse(stale_phase1.exists())
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertEqual(agent["failure_reason"], "phase1_command_failed")
            self.assertIsNone(agent["verdict"])
            self.assertTrue(agent["blank_output"])

    def test_project_config_cannot_enable_two_phase(self):
        """two_phase/scope_prompt in review-swarm.json are ignored: CLI-flag-only opt-in."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir, system, prompt, scope, runner = self._base_paths(td_path)
            _write_single_phase_stub(runner)
            cfg = td_path / "review-swarm.json"
            cfg.write_text(
                json.dumps({"two_phase": True, "scope_prompt": str(scope)}),
                encoding="utf-8",
            )

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--config",
                str(cfg),
                "--models",
                "claude/default",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertNotIn("two_phase", meta)
            for agent in meta["agents"]:
                self.assertNotIn("two_phase", agent)
            self.assertFalse((out_dir / "two_phase").exists())

    def test_single_phase_regression_no_two_phase_artifacts(self):
        """Without --two-phase, no two-phase key, file, or directory appears anywhere."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            runner = td_path / "run_claude.sh"
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("DIFF PACKET CONTENT\n", encoding="utf-8")
            _write_single_phase_stub(runner)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--models",
                "claude/default",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertNotIn("two_phase", meta)
            for agent in meta["agents"]:
                self.assertNotIn("two_phase", agent)
            self.assertFalse((out_dir / "two_phase").exists())
            self.assertEqual(list(out_dir.glob("*.phase1.*")), [])

            events = _read_trace_events(out_dir / "trace.jsonl")
            config_event = next(e for e in events if e.get("event") == "config")
            self.assertNotIn("two_phase", config_event)
            self.assertNotIn("scope_prompt", config_event)
            self.assertFalse(any(str(e.get("event", "")).endswith("_two_phase") for e in events))
            # Single-phase runner events must not carry the two-phase phase key.
            for e in events:
                if str(e.get("event", "")).endswith(("_start", "_end")):
                    self.assertNotIn("phase", e)


if __name__ == "__main__":
    unittest.main()
