import json
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


SRC_ROOT = str(_src_root())
if SRC_ROOT not in sys.path:
    sys.path.insert(0, SRC_ROOT)

from hep_autoresearch.toolkit.literature_gap import (  # noqa: E402
    LiteratureGapAnalyzeInputs,
    LiteratureGapDiscoverInputs,
    _mcp_env,
    extract_seed_search_candidates,
    run_literature_gap_analyze,
    run_literature_gap_discover,
)
from hep_autoresearch.toolkit.mcp_config import default_hep_data_dir  # noqa: E402


def _stub_server_path() -> Path:
    return Path(__file__).resolve().parent / "mcp_stub_server.py"


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


class TestLiteratureGapRunner(unittest.TestCase):
    def test_literature_gap_missing_config(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            with self.assertRaisesRegex(ValueError, "missing MCP config"):
                run_literature_gap_discover(
                    repo_root,
                    LiteratureGapDiscoverInputs(tag="M73-gap-missing", topic="x"),
                )

    def test_literature_gap_with_stub_mcp_discover(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-test"
            result = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(
                    tag=tag,
                    topic="test topic",
                    seed_recid="9999",
                    focus=["f1", "f2"],
                ),
            )
            self.assertEqual(result.exit_code, 0, msg=str(result.errors))

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover"
            self.assertEqual(result.out_dir, out_dir.resolve())
            self.assertTrue((out_dir / "manifest.json").exists())
            self.assertTrue((out_dir / "summary.json").exists())
            self.assertTrue((out_dir / "analysis.json").exists())
            self.assertTrue((out_dir / "gap_report.json").exists())
            self.assertTrue((out_dir / "workflow_plan.json").exists())
            self.assertTrue((out_dir / "seed_search.json").exists())
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
            self.assertTrue("relevance" not in results)

            candidates = json.loads((out_dir / "candidates.json").read_text(encoding="utf-8"))
            papers = candidates.get("papers") or []
            self.assertTrue(isinstance(papers, list) and papers)
            recids = [str((paper or {}).get("recid") or "") for paper in papers]
            self.assertEqual(recids, ["2001", "1001", "1002", "3001"], msg=str(recids))
            self.assertFalse(default_hep_data_dir(repo_root=repo_root).exists())

    def test_literature_gap_analyze_round_trip_with_seed_selection(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze"
            discover = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(tag=tag, topic="test topic"),
            )
            self.assertEqual(discover.exit_code, 0, msg=str(discover.errors))

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

            analyze = run_literature_gap_analyze(
                repo_root,
                LiteratureGapAnalyzeInputs(
                    tag=tag,
                    seed_selection="seed_selection.json",
                    max_recids=2,
                ),
            )
            self.assertEqual(analyze.exit_code, 0, msg=str(analyze.errors))

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "analyze"
            self.assertTrue((out_dir / "manifest.json").exists())
            self.assertTrue((out_dir / "summary.json").exists())
            self.assertTrue((out_dir / "analysis.json").exists())
            self.assertTrue((out_dir / "gap_report.json").exists())
            self.assertTrue((out_dir / "workflow_plan.json").exists())
            self.assertTrue((out_dir / "topic_analysis.json").exists())
            self.assertTrue((out_dir / "critical_analysis.json").exists())
            self.assertTrue((out_dir / "network_analysis.json").exists())
            self.assertTrue((out_dir / "connection_scan.json").exists())
            self.assertTrue((out_dir / "seed_selection.json").exists())
            self.assertTrue((out_dir / "report.md").exists())

            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            self.assertEqual(gap.get("schema_version"), 1)
            self.assertEqual(gap.get("phase"), "analyze")
            self.assertEqual((gap.get("inputs") or {}).get("recids"), ["1001", "2001"])
            self.assertEqual(gap.get("results", {}).get("ok"), True)
            self.assertTrue(
                str((((gap.get("results") or {}).get("critical_analysis") or {}).get("path") or "")).endswith("/critical_analysis.json")
            )
            self.assertFalse(default_hep_data_dir(repo_root=repo_root).exists())

    def test_literature_gap_mcp_env_does_not_create_default_hep_data_dir_when_create_is_false(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            env = _mcp_env(
                repo_root,
                {},
                hep_data_dir_override=None,
                create_data_dir=False,
                project_policy=None,
            )
            self.assertIn("HEP_DATA_DIR", env)
            self.assertFalse(default_hep_data_dir(repo_root=repo_root).exists())

    def test_literature_gap_analyze_rejects_external_recids_without_allow_flag(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze-reject"
            discover = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(tag=tag, topic="test topic"),
            )
            self.assertEqual(discover.exit_code, 0, msg=str(discover.errors))

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Bad seed (for test): external recid.",
                "items": [{"recid": "9999", "reason_for_inclusion": "Not in candidates list."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "seed_selection contains recids not present in candidates.json"):
                run_literature_gap_analyze(
                    repo_root,
                    LiteratureGapAnalyzeInputs(
                        tag=tag,
                        seed_selection="seed_selection.json",
                    ),
                )

    def test_literature_gap_discover_uses_launcher_resolved_seed_search(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-discover-navigator"
            result = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(tag=tag, topic="test topic"),
            )
            self.assertEqual(result.exit_code, 0, msg=str(result.errors))

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover"
            workflow_plan = json.loads((out_dir / "workflow_plan.json").read_text(encoding="utf-8"))
            self.assertEqual(workflow_plan.get("entry_tool"), "literature_workflows.resolve")
            resolved_steps = workflow_plan.get("resolved_steps") or []
            self.assertTrue(isinstance(resolved_steps, list) and resolved_steps)
            self.assertEqual((resolved_steps[0] or {}).get("tool"), "inspire_search")
            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            actions = gap.get("agent_actions") or []
            self.assertTrue(actions)
            first = actions[0] if isinstance(actions[0], dict) else {}
            self.assertEqual(first.get("tool"), "inspire_search")
            self.assertEqual(first.get("workflow_step"), "seed_search")

    def test_literature_gap_discover_fails_closed_when_seed_search_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root, extra_env={"MCP_STUB_DISABLE_INSPIRE_SEARCH": "1"})

            tag = "M73-gap-discover-missing-seed-search"
            result = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(tag=tag, topic="test topic"),
            )
            self.assertEqual(result.exit_code, 2)
            self.assertTrue(any("unavailable tool inspire_search" in error for error in result.errors), msg=str(result.errors))

    def test_literature_gap_analyze_uses_launcher_resolved_atomic_tools(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-analyze-navigator"
            discover = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(tag=tag, topic="test topic"),
            )
            self.assertEqual(discover.exit_code, 0, msg=str(discover.errors))

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Test selection for navigator path.",
                "items": [{"recid": "1001", "reason_for_inclusion": "Seminal."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            analyze = run_literature_gap_analyze(
                repo_root,
                LiteratureGapAnalyzeInputs(
                    tag=tag,
                    seed_selection="seed_selection.json",
                    network_direction="in",
                ),
            )
            self.assertEqual(analyze.exit_code, 0, msg=str(analyze.errors))

            out_dir = repo_root / "artifacts" / "runs" / tag / "literature_gap" / "analyze"
            workflow_plan = json.loads((out_dir / "workflow_plan.json").read_text(encoding="utf-8"))
            resolved_steps = [step for step in (workflow_plan.get("resolved_steps") or []) if isinstance(step, dict)]
            self.assertEqual([step.get("id") for step in resolved_steps], [
                "topic_scan",
                "critical_analysis",
                "citation_network",
                "connection_scan",
            ])
            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            actions = [action for action in (gap.get("agent_actions") or []) if isinstance(action, dict)]
            topic_actions = [action for action in actions if action.get("tool") == "inspire_topic_analysis"]
            critical_actions = [action for action in actions if action.get("tool") == "inspire_critical_analysis"]
            network_actions = [action for action in actions if action.get("tool") == "inspire_network_analysis"]
            connection_actions = [action for action in actions if action.get("tool") == "inspire_find_connections"]
            self.assertTrue(topic_actions, msg=str(actions))
            self.assertTrue(critical_actions, msg=str(actions))
            self.assertTrue(network_actions, msg=str(actions))
            self.assertTrue(connection_actions, msg=str(actions))
            self.assertEqual(critical_actions[0].get("workflow_step"), "critical_analysis")
            self.assertEqual(network_actions[0].get("network_direction_cli"), "in")
            self.assertEqual(network_actions[0].get("network_direction_tool"), "citations")

    def test_literature_gap_analyze_fails_closed_when_topic_tool_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root, extra_env={"MCP_STUB_DISABLE_TOPIC_ANALYSIS": "1"})

            tag = "M73-gap-analyze-missing-topic-tool"
            discover = run_literature_gap_discover(
                repo_root,
                LiteratureGapDiscoverInputs(tag=tag, topic="test topic"),
            )
            self.assertEqual(discover.exit_code, 0, msg=str(discover.errors))

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Test selection for missing tool path.",
                "items": [{"recid": "1001", "reason_for_inclusion": "Seminal."}],
            }
            seed_path.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")

            analyze = run_literature_gap_analyze(
                repo_root,
                LiteratureGapAnalyzeInputs(
                    tag=tag,
                    seed_selection="seed_selection.json",
                ),
            )
            self.assertEqual(analyze.exit_code, 2)
            self.assertTrue(any("unavailable tool inspire_topic_analysis" in error for error in analyze.errors), msg=str(analyze.errors))

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

            with self.assertRaisesRegex(ValueError, "candidates.json not found"):
                run_literature_gap_analyze(
                    repo_root,
                    LiteratureGapAnalyzeInputs(
                        tag=tag,
                        seed_selection="seed_selection.json",
                    ),
                )

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

            with self.assertRaisesRegex(ValueError, "invalid candidates.json"):
                run_literature_gap_analyze(
                    repo_root,
                    LiteratureGapAnalyzeInputs(
                        tag=tag,
                        seed_selection="seed_selection.json",
                    ),
                )


class TestC1CandidateExtraction(unittest.TestCase):
    def test_extract_candidates_empty_payload(self) -> None:
        res = extract_seed_search_candidates({}, created_at="2025-01-01T00:00:00Z")
        self.assertEqual(res.get("schema_version"), 1)
        self.assertEqual(res.get("papers"), [])
        stats = res.get("stats") or {}
        self.assertEqual(stats.get("unique_recids"), 0)

    def test_extract_candidates_reads_search_papers(self) -> None:
        payload = {
            "papers": [{"recid": "42", "title": "Test"}],
        }
        res = extract_seed_search_candidates(payload, created_at="2025-01-01T00:00:00Z")
        recids = [str((paper or {}).get("recid") or "") for paper in (res.get("papers") or [])]
        self.assertIn("42", recids)

    def test_extract_candidates_marks_missing_metadata(self) -> None:
        payload = {
            "papers": [{"recid": "9999"}],
        }
        res = extract_seed_search_candidates(payload, created_at="2025-01-01T00:00:00Z")
        papers = res.get("papers") or []
        self.assertTrue(isinstance(papers, list) and papers)
        self.assertEqual((papers[0] or {}).get("recid"), "9999")
        missing = (papers[0] or {}).get("missing_fields") or []
        self.assertIn("title", missing)
        self.assertIn("abstract", missing)


if __name__ == "__main__":
    unittest.main()
