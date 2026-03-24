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
            self.assertTrue((out_dir / "workflow_plan.json").exists())
            self.assertTrue((out_dir / "connection_scan.json").exists())
            self.assertTrue((out_dir / "critical_analysis.json").exists())
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

    def test_literature_gap_discover_uses_launcher_resolved_seed_search(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_stub_mcp_config(repo_root)

            tag = "M73-gap-discover-navigator"
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

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
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertNotEqual(rc, 0, msg=out + err)
            self.assertIn("unavailable tool inspire_search", out + err)

    def test_literature_gap_analyze_uses_launcher_resolved_atomic_tools(self) -> None:
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
            workflow_plan = json.loads((out_dir / "workflow_plan.json").read_text(encoding="utf-8"))
            resolved_steps = [step for step in (workflow_plan.get("resolved_steps") or []) if isinstance(step, dict)]
            self.assertEqual([step.get("id") for step in resolved_steps], [
                "topic_scan",
                "critical_analysis",
                "citation_network",
                "connection_scan",
            ])
            gap = json.loads((out_dir / "gap_report.json").read_text(encoding="utf-8"))
            actions = [a for a in (gap.get("agent_actions") or []) if isinstance(a, dict)]
            topic_actions = [a for a in actions if a.get("tool") == "inspire_topic_analysis"]
            critical_actions = [a for a in actions if a.get("tool") == "inspire_critical_analysis"]
            network_actions = [a for a in actions if a.get("tool") == "inspire_network_analysis"]
            connection_actions = [a for a in actions if a.get("tool") == "inspire_find_connections"]
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
            rc, out, err = _run_cli(repo_root, ["literature-gap", "--tag", tag, "--topic", "test topic"])
            self.assertEqual(rc, 0, msg=out + err)

            seed_path = repo_root / "seed_selection.json"
            seed = {
                "schema_version": 1,
                "selection_logic": "Test selection for missing tool path.",
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
                ],
            )
            self.assertNotEqual(rc2, 0, msg=out2 + err2)
            self.assertIn("unavailable tool inspire_topic_analysis", out2 + err2)

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
        from hep_autoresearch.orchestrator_cli import _c1_extract_seed_search_candidates

        res = _c1_extract_seed_search_candidates({}, created_at="2025-01-01T00:00:00Z")
        self.assertEqual(res.get("schema_version"), 1)
        self.assertEqual(res.get("papers"), [])
        stats = res.get("stats") or {}
        self.assertEqual(stats.get("unique_recids"), 0)

    def test_extract_candidates_reads_search_papers(self) -> None:
        from hep_autoresearch.orchestrator_cli import _c1_extract_seed_search_candidates

        payload = {
            "papers": [{"recid": "42", "title": "Test"}],
        }
        res = _c1_extract_seed_search_candidates(payload, created_at="2025-01-01T00:00:00Z")
        recids = [str((p or {}).get("recid") or "") for p in (res.get("papers") or [])]
        self.assertIn("42", recids)

    def test_extract_candidates_marks_missing_metadata(self) -> None:
        from hep_autoresearch.orchestrator_cli import _c1_extract_seed_search_candidates

        payload = {
            "papers": [{"recid": "9999"}],  # missing title/abstract/year/citations
        }
        res = _c1_extract_seed_search_candidates(payload, created_at="2025-01-01T00:00:00Z")
        papers = res.get("papers") or []
        self.assertTrue(isinstance(papers, list) and papers)
        self.assertEqual((papers[0] or {}).get("recid"), "9999")
        missing = (papers[0] or {}).get("missing_fields") or []
        self.assertIn("title", missing)
        self.assertIn("abstract", missing)
