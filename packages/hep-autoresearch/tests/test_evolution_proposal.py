import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


class TestEvolutionProposal(unittest.TestCase):
    def test_partial_dedupe_leaves_triage_only_auto_handled(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.evolution_proposal import EvolutionProposalInputs, evolution_proposal_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            source_analysis = repo_root / "artifacts" / "runs" / "run-new" / "computation" / "analysis.json"
            _write_json(
                source_analysis,
                {"results": {"ok": False, "errors": ["missing required input file"]}},
            )
            _write_json(
                repo_root / "artifacts" / "runs" / "run-old" / "evolution_proposal" / "analysis.json",
                {
                    "created_at": "2026-03-20T00:00:00Z",
                    "results": {
                        "proposals_total": 1,
                        "proposals": [
                            {
                                "proposal_id": "P001",
                                "kind": "missing_inputs",
                                "target_file": "artifacts/runs/run-new/computation/analysis.json",
                                "source": {"analysis_path": "artifacts/runs/run-new/computation/analysis.json"},
                                "actions": [{"type": "eval", "requires_approval": "A2"}],
                            }
                        ],
                    },
                },
            )

            result = evolution_proposal_one(
                EvolutionProposalInputs(
                    tag="run-new",
                    source_run_tag="run-new",
                    write_kb_trace=False,
                ),
                repo_root=repo_root,
            )

            analysis = json.loads((repo_root / result["artifact_paths"]["analysis"]).read_text(encoding="utf-8"))
            proposals = ((analysis.get("results") or {}).get("proposals") or [])
            self.assertEqual(len(proposals), 1)
            proposal = proposals[0]
            self.assertEqual(proposal.get("handling"), "auto_handled")
            self.assertNotIn("requires_approval", proposal)
            self.assertEqual([a.get("type") for a in proposal.get("actions") or []], ["triage"])
            self.assertEqual(((proposal.get("actions") or [])[0].get("handling")), "auto_handled")
            self.assertEqual(((analysis.get("results") or {}).get("suppressed_duplicates_total")), 1)

    def test_full_dedupe_marks_repair_loop_detected(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.evolution_proposal import EvolutionProposalInputs, evolution_proposal_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            target_file = "artifacts/runs/run-loop/computation/analysis.json"
            _write_json(
                repo_root / target_file,
                {"results": {"ok": False, "errors": ["missing required input file"]}},
            )
            _write_json(
                repo_root / "artifacts" / "runs" / "run-prev" / "evolution_proposal" / "analysis.json",
                {
                    "created_at": "2026-03-20T00:00:00Z",
                    "results": {
                        "proposals_total": 1,
                        "proposals": [
                            {
                                "proposal_id": "P001",
                                "kind": "missing_inputs",
                                "target_file": target_file,
                                "source": {"analysis_path": target_file},
                                "actions": [
                                    {"type": "triage", "handling": "auto_handled"},
                                    {"type": "eval", "requires_approval": "A2"},
                                ],
                            }
                        ],
                    },
                },
            )

            result = evolution_proposal_one(
                EvolutionProposalInputs(
                    tag="run-loop",
                    source_run_tag="run-loop",
                    write_kb_trace=False,
                ),
                repo_root=repo_root,
            )

            analysis = json.loads((repo_root / result["artifact_paths"]["analysis"]).read_text(encoding="utf-8"))
            results = analysis.get("results") or {}
            self.assertEqual(results.get("proposals_total"), 0)
            self.assertTrue(results.get("repair_loop_detected"))
            self.assertEqual(results.get("suppressed_duplicates_total"), 2)

    def test_empty_cycles_raise_stagnation_after_threshold(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.evolution_proposal import EvolutionProposalInputs, evolution_proposal_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_json(
                repo_root / "artifacts" / "runs" / "run-empty" / "computation" / "analysis.json",
                {"results": {"ok": True, "errors": []}},
            )
            for run_id, created_at in [("run-empty-a", "2026-03-18T00:00:00Z"), ("run-empty-b", "2026-03-19T00:00:00Z")]:
                _write_json(
                    repo_root / "artifacts" / "runs" / run_id / "evolution_proposal" / "analysis.json",
                    {
                        "created_at": created_at,
                        "results": {"proposals_total": 0, "proposals": []},
                    },
                )

            result = evolution_proposal_one(
                EvolutionProposalInputs(
                    tag="run-empty",
                    source_run_tag="run-empty",
                    write_kb_trace=False,
                ),
                repo_root=repo_root,
            )

            analysis = json.loads((repo_root / result["artifact_paths"]["analysis"]).read_text(encoding="utf-8"))
            stagnation = ((analysis.get("results") or {}).get("stagnation") or {})
            self.assertEqual(((analysis.get("results") or {}).get("consecutive_empty_cycles")), 3)
            self.assertTrue(stagnation.get("detected"))
            self.assertEqual(stagnation.get("threshold"), 3)


if __name__ == "__main__":
    unittest.main()
