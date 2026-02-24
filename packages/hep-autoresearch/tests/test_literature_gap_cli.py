import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _stub_server_path() -> Path:
    return Path(__file__).resolve().parent / "mcp_stub_server.py"


def _run_cli(repo_root: Path, args: list[str]) -> tuple[int, str, str]:
    env = dict(os.environ)
    src = str(_src_root())
    prev = env.get("PYTHONPATH", "").strip()
    env["PYTHONPATH"] = src + (os.pathsep + prev if prev else "")
    cp = subprocess.run(
        [sys.executable, "-m", "hep_autoresearch.orchestrator_cli", "--project-root", str(repo_root), *args],
        cwd=str(repo_root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return int(cp.returncode), str(cp.stdout), str(cp.stderr)


def _write_stub_mcp_config(repo_root: Path, *, extra_env: dict[str, str] | None = None) -> None:
    mcp_cfg = {
        "mcpServers": {
            "hep-research": {
                "command": sys.executable,
                "args": ["-u", str(_stub_server_path())],
                "env": dict(extra_env or {}),
            }
        }
    }
    (repo_root / ".mcp.json").write_text(json.dumps(mcp_cfg, indent=2) + "\n", encoding="utf-8")


class TestLiteratureGapCLI(unittest.TestCase):
    def test_literature_gap_missing_config(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", "M73-gap-missing", "--topic", "x"])
            self.assertNotEqual(rc, 0)
            self.assertIn("missing MCP config", out + err)

    def test_literature_gap_with_stub_mcp_discover(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-test"
            rc, out, err = _run_cli(
                repo_root,
                [
                    "literature-gap",
                    "--tag",
                    tag,
                    "--topic",
                    "test topic",
                    "--seed-recid",
                    "9999",
                    "--focus",
                    "f1",
                    "--focus",
                    "f2",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("literature-gap", out)

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover"
            self.assertTrue((out_dir / "manifest.json").exists())
            self.assertTrue((out_dir / "summary.json").exists())
            self.assertTrue((out_dir / "analysis.json").exists())
            self.assertTrue((out_dir / "gap_report.json").exists())
            self.assertTrue((out_dir / "candidates.json").exists())
            self.assertTrue((out_dir / "report.md").exists())

            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            self.assertEqual(gap.get("schema_version"), 1)
            self.assertEqual(gap.get("phase"), "discover")
            inputs = gap.get("inputs") or {}
            self.assertEqual(inputs.get("topic"), "test topic")
            self.assertEqual(inputs.get("seed_recid"), "9999")

            results = gap.get("results", {}) or {}
            self.assertEqual(results.get("ok"), True)
            self.assertEqual(results.get("seed_selection_required"), True)
            # No deterministic relevance fallback in Phase C1.
            self.assertTrue("relevance" not in results)

            candidates = json.loads((out_dir / "candidates.json").read_text(encoding="utf-8"))
            papers = candidates.get("papers") or []
            self.assertTrue(isinstance(papers, list) and papers)
            recids = [str((p or {}).get("recid") or "") for p in papers]
            self.assertEqual(recids, ["2001", "1001", "1002", "3001"], msg=str(recids))

    def test_literature_gap_analyze_round_trip_with_seed_selection(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze"
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Semantic relevance (human/LLM) + diversity (seminal + review); exclude keyword-only matches.",
                "items": [
                    {"recid": "1001", "reason_for_inclusion": "Seminal result for the topic (stub)."},
                    {"recid": "2001", "reason_for_inclusion": "Review paper for the topic (stub)."},
                ],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            rc2, out2, err2 = _run_cli(
                repo_root,
                [
                    "literature-gap",
                    "--phase",
                    "analyze",
                    "--tag",
                    tag,
                    "--seed-selection",
                    "seed_selection.json",
                    "--max-recids",
                    "2",
                ],
            )
            self.assertEqual(rc2, 0, msg=out2 + err2)

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "analyze"
            self.assertTrue((out_dir / "manifest.json").exists())
            self.assertTrue((out_dir / "summary.json").exists())
            self.assertTrue((out_dir / "analysis.json").exists())
            self.assertTrue((out_dir / "gap_report.json").exists())
            self.assertTrue((out_dir / "seed_selection.json").exists())
            self.assertTrue((out_dir / "report.md").exists())

            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            self.assertEqual(gap.get("schema_version"), 1)
            self.assertEqual(gap.get("phase"), "analyze")
            self.assertEqual((gap.get("inputs") or {}).get("recids"), ["1001", "2001"])
            self.assertEqual(gap.get("results", {}).get("ok"), True)

    def test_literature_gap_analyze_rejects_external_recids_without_allow_flag(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze-reject"
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Bad seed (for test): external recid.",
                "items": [{"recid": "9999", "reason_for_inclusion": "Not in candidates list."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            rc2, out2, err2 = _run_cli(
                repo_root,
                [
                    "literature-gap",
                    "--phase",
                    "analyze",
                    "--tag",
                    tag,
                    "--seed-selection",
                    "seed_selection.json",
                ],
            )
            self.assertNotEqual(rc2, 0, msg=out2 + err2)
            self.assertIn("seed_selection contains recids not present in candidates.json", out2 + err2)

    def test_literature_gap_discover_prefers_navigator_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-discover-navigator"
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover"
            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            actions = gap.get("agent_actions") or []
            self.assertTrue(actions)
            first = actions[0] if isinstance(actions[0], dict) else {}
            self.assertEqual(first.get("tool"), "inspire_research_navigator")
            self.assertEqual(first.get("mode"), "field_survey")

    def test_literature_gap_discover_falls_back_to_legacy_when_navigator_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root, extra_env={"MCP_STUB_DISABLE_NAVIGATOR": "1"})

            tag = "M73-gap-discover-legacy-fallback"
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover"
            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            actions = [a for a in (gap.get("agent_actions") or []) if isinstance(a, dict)]
            self.assertTrue(actions)
            first = actions[0]
            self.assertEqual(first.get("tool"), "inspire_field_survey")
            self.assertEqual(first.get("legacy_fallback"), True)
            self.assertTrue(all(a.get("tool") != "inspire_research_navigator" for a in actions))

    def test_literature_gap_analyze_prefers_navigator_topic_and_network(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze-navigator"
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Test selection for navigator path.",
                "items": [{"recid": "1001", "reason_for_inclusion": "Seminal."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            rc2, out2, err2 = _run_cli(
                repo_root,
                [
                    "literature-gap",
                    "--phase",
                    "analyze",
                    "--tag",
                    tag,
                    "--seed-selection",
                    "seed_selection.json",
                    "--network-direction",
                    "in",
                ],
            )
            self.assertEqual(rc2, 0, msg=out2 + err2)

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "analyze"
            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            actions = [a for a in (gap.get("agent_actions") or []) if isinstance(a, dict)]
            topic_actions = [a for a in actions if a.get("tool") == "inspire_research_navigator" and a.get("mode") == "topic_analysis"]
            network_actions = [a for a in actions if a.get("tool") == "inspire_research_navigator" and a.get("mode") == "network"]
            self.assertTrue(topic_actions, msg=str(actions))
            self.assertTrue(network_actions, msg=str(actions))
            self.assertEqual(network_actions[0].get("network_direction_cli"), "in")
            self.assertEqual(network_actions[0].get("network_direction_nav"), "citations")

    def test_literature_gap_analyze_without_discover_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze-no-discover"
            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Test seed selection.",
                "items": [{"recid": "1001", "reason_for_inclusion": "Test."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            rc, out, err = _run_cli(
                repo_root,
                [
                    "literature-gap",
                    "--phase",
                    "analyze",
                    "--tag",
                    tag,
                    "--seed-selection",
                    "seed_selection.json",
                ],
            )
            self.assertNotEqual(rc, 0)
            self.assertIn("candidates.json not found", out + err)

    def test_literature_gap_analyze_with_corrupt_candidates_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze-corrupt-candidates"
            cand_path = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover" / "candidates.json"
            cand_path.parent.mkdir(parents=True, exist_ok=True)
            cand_path.write_text("not json\n", encoding="utf-8")

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Test seed selection.",
                "items": [{"recid": "1001", "reason_for_inclusion": "Test."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            rc, out, err = _run_cli(
                repo_root,
                [
                    "literature-gap",
                    "--phase",
                    "analyze",
                    "--tag",
                    tag,
                    "--seed-selection",
                    "seed_selection.json",
                ],
            )
            self.assertNotEqual(rc, 0)
            self.assertIn("invalid candidates.json", out + err)


class TestC1CandidateExtraction(unittest.TestCase):
    def test_extract_candidates_empty_payload(self) -> None:
        from hep_autoresearch.orchestrator_cli import _c1_extract_field_survey_candidates

        res = _c1_extract_field_survey_candidates({}, created_at="2025-01-01T00:00:00Z")
        self.assertEqual(res.get("schema_version"), 1)
        self.assertEqual(res.get("papers"), [])
        stats = res.get("stats") or {}
        self.assertEqual(stats.get("unique_recids"), 0)

    def test_extract_candidates_supports_all_papers_key(self) -> None:
        from hep_autoresearch.orchestrator_cli import _c1_extract_field_survey_candidates

        payload = {
            "reviews": {"papers": []},
            "seminal_papers": {"papers": []},
            "citation_network": {"all_papers": [{"recid": "42", "title": "Test"}]},
        }
        res = _c1_extract_field_survey_candidates(payload, created_at="2025-01-01T00:00:00Z")
        recids = [str((p or {}).get("recid") or "") for p in (res.get("papers") or [])]
        self.assertIn("42", recids)

    def test_extract_candidates_marks_missing_metadata(self) -> None:
        from hep_autoresearch.orchestrator_cli import _c1_extract_field_survey_candidates

        payload = {
            "reviews": {"papers": []},
            "seminal_papers": {"papers": [{"recid": "9999"}]},  # missing title/abstract/year/citations
            "citation_network": {"papers": []},
        }
        res = _c1_extract_field_survey_candidates(payload, created_at="2025-01-01T00:00:00Z")
        papers = res.get("papers") or []
        self.assertTrue(isinstance(papers, list) and papers)
        self.assertEqual((papers[0] or {}).get("recid"), "9999")
        missing = (papers[0] or {}).get("missing_fields") or []
        self.assertIn("title", missing)
        self.assertIn("abstract", missing)
