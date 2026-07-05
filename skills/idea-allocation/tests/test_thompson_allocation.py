"""Allocation logic: slot cuts, cold start, exclusions, reproducibility."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import thompson_allocation as ta
from conftest import FIXTURES_DIR, SCRIPTS_DIR

FIXTURE = FIXTURES_DIR / "nodes_latest.json"
CAMPAIGN_ID = "0f3c2c8e-5df1-4a3a-9b6e-2f1a7c9d4e10"
SCRIPT = SCRIPTS_DIR / "thompson_allocation.py"


def load_fixture_nodes():
    import nodes_store

    return nodes_store.load_nodes_file(str(FIXTURE))


def make_store(tmp_path: Path, nodes, campaign_id: str = CAMPAIGN_ID) -> Path:
    path = tmp_path / "nodes_latest.json"
    path.write_text(
        json.dumps({"campaign_id": campaign_id, "nodes": nodes}, indent=2),
        encoding="utf-8",
    )
    return path


def active_node(node_id: str, value: float, count: int):
    return {
        "node_id": node_id,
        "lifecycle_state": "active",
        "posterior": {
            "value": value,
            "evidence_count": count,
            "updated_at": "2026-07-01T00:00:00Z",
        },
    }


def run_cli(args, cwd: Path):
    return subprocess.run(
        [sys.executable, str(SCRIPT)] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------------------
# Grouping and slot assignment
# ---------------------------------------------------------------------------

def test_split_nodes_excludes_archived_and_waiting():
    _, nodes = load_fixture_nodes()
    groups = ta.split_nodes(nodes)
    assert {n["node_id"] for n in groups["sampled"]} == {"idea-alpha", "idea-beta", "idea-eta"}
    assert {n["node_id"] for n in groups["cold_start"]} == {"idea-gamma"}
    assert {n["node_id"] for n in groups["waiting"]} == {
        "idea-delta", "idea-epsilon", "idea-iota", "idea-kappa", "idea-lambda",
    }
    assert {n["node_id"] for n in groups["archived"]} == {"idea-zeta"}


def test_slot_cut_counts_and_ranking():
    campaign_id, nodes = load_fixture_nodes()
    decision = ta.build_decision(
        campaign_id, nodes, seed=7, deep_slots=1, recon_slots=1,
        generated_at="2026-07-05T00:00:00Z",
    )
    candidates = decision["candidates"]
    by_kind = {}
    for entry in candidates:
        by_kind.setdefault(entry["allocation"], []).append(entry)
    assert len(by_kind["deep_investment"]) == 1
    # 1 sampled reconnaissance slot + 1 cold-start tail entry
    assert len(by_kind["reconnaissance"]) == 2
    assert len(by_kind["hold"]) == 1
    sampled_entries = [e for e in candidates if e["sampled_value"] is not None]
    ranked = sorted(sampled_entries, key=lambda e: -e["sampled_value"])
    assert ranked[0]["allocation"] == "deep_investment"
    assert ranked[1]["allocation"] == "reconnaissance"
    assert ranked[2]["allocation"] == "hold"
    # Sampled candidates appear in ranked order in the artifact.
    assert [e["node_id"] for e in sampled_entries] == [e["node_id"] for e in ranked]


def test_cold_start_never_takes_a_deep_slot(tmp_path):
    # More deep slots than sampled candidates: cold starts must NOT be promoted.
    nodes = [
        active_node("idea-alpha", 0.8, 20),
        active_node("idea-beta", 0.3, 4),
        {"node_id": "idea-gamma", "lifecycle_state": "active"},
        {"node_id": "idea-mu", "lifecycle_state": "active"},
    ]
    path = make_store(tmp_path, nodes)
    import nodes_store

    campaign_id, loaded = nodes_store.load_nodes_file(str(path))
    decision = ta.build_decision(
        campaign_id, loaded, seed=11, deep_slots=5, recon_slots=2,
        generated_at="2026-07-05T00:00:00Z",
    )
    deep = [e for e in decision["candidates"] if e["allocation"] == "deep_investment"]
    assert {e["node_id"] for e in deep} == {"idea-alpha", "idea-beta"}
    cold = [e for e in decision["candidates"] if e["sampled_value"] is None]
    assert {e["node_id"] for e in cold} == {"idea-gamma", "idea-mu"}
    for entry in cold:
        assert entry["allocation"] == "reconnaissance"
        assert entry["posterior_value"] is None and entry["evidence_count"] is None
        assert "no posterior yet" in entry["budget_note"]
        assert "belief graph" in entry["budget_note"]
    # Cold starts sit at the tail, after every sampled candidate.
    ids = [e["node_id"] for e in decision["candidates"]]
    assert ids.index("idea-gamma") > max(ids.index("idea-alpha"), ids.index("idea-beta"))


def test_budget_notes_flag_exploration_vs_conservative():
    campaign_id, nodes = load_fixture_nodes()
    decision = ta.build_decision(
        campaign_id, nodes, seed=7, deep_slots=2, recon_slots=1,
        generated_at="2026-07-05T00:00:00Z",
    )
    for entry in decision["candidates"]:
        if entry["sampled_value"] is None:
            continue
        alpha, beta = ta.beta_parameters(entry["posterior_value"], entry["evidence_count"])
        mean = ta.beta_mean(alpha, beta)
        if entry["sampled_value"] > mean:
            assert "exploration draw" in entry["budget_note"]
        elif entry["sampled_value"] < mean:
            assert "conservative draw" in entry["budget_note"]


def test_waiting_activation_entries_in_artifact():
    campaign_id, nodes = load_fixture_nodes()
    decision = ta.build_decision(
        campaign_id, nodes, seed=7, deep_slots=1, recon_slots=1,
        generated_at="2026-07-05T00:00:00Z",
    )
    waiting = decision["waiting_activation"]
    assert [w["node_id"] for w in waiting] == sorted(w["node_id"] for w in waiting)
    assert {w["node_id"] for w in waiting} == {
        "idea-delta", "idea-epsilon", "idea-iota", "idea-kappa", "idea-lambda",
    }
    by_id = {w["node_id"]: w for w in waiting}
    assert by_id["idea-delta"]["last_checked_at"] == "2026-06-28T16:00:00Z"
    assert by_id["idea-iota"]["last_checked_at"] is None
    condition = by_id["idea-epsilon"]["activation_condition"]
    assert set(condition) == {"kind", "description", "satisfied"}
    assert condition["satisfied"] is True
    # Waiting and archived ids never appear among candidates.
    candidate_ids = {c["node_id"] for c in decision["candidates"]}
    assert candidate_ids.isdisjoint({w["node_id"] for w in waiting})
    assert "idea-zeta" not in candidate_ids


def test_artifact_passes_own_validator():
    campaign_id, nodes = load_fixture_nodes()
    decision = ta.build_decision(
        campaign_id, nodes, seed=7, deep_slots=1, recon_slots=1,
        generated_at="2026-07-05T00:00:00Z",
    )
    assert ta.validate_allocation_decision(decision) == []
    assert decision["method"] == "thompson_sampling"
    assert decision["random_seed"] == 7
    assert decision["campaign_id"] == CAMPAIGN_ID


# ---------------------------------------------------------------------------
# CLI behaviour
# ---------------------------------------------------------------------------

def test_cli_seed_reproducibility_byte_for_byte(tmp_path):
    base_args = [
        "--nodes", str(FIXTURE),
        "--seed", "42",
        "--deep-slots", "1",
        "--recon-slots", "1",
        "--generated-at", "2026-07-05T00:00:00Z",
    ]
    for run_dir in ("run-a", "run-b"):
        (tmp_path / run_dir).mkdir()
        result = run_cli(base_args, cwd=tmp_path / run_dir)
        assert result.returncode == 0, result.stderr
    files_a = sorted((tmp_path / "run-a" / "artifacts" / "allocations").iterdir())
    files_b = sorted((tmp_path / "run-b" / "artifacts" / "allocations").iterdir())
    assert len(files_a) == len(files_b) == 1
    assert files_a[0].name == files_b[0].name
    assert files_a[0].read_bytes() == files_b[0].read_bytes()

    # A different seed changes the draws (equal draws have probability zero).
    (tmp_path / "run-c").mkdir()
    result = run_cli(
        [arg if arg != "42" else "43" for arg in base_args], cwd=tmp_path / "run-c"
    )
    assert result.returncode == 0, result.stderr
    files_c = sorted((tmp_path / "run-c" / "artifacts" / "allocations").iterdir())
    decision_a = json.loads(files_a[0].read_text())
    decision_c = json.loads(files_c[0].read_text())
    samples_a = [
        e["sampled_value"] for e in decision_a["candidates"] if e["sampled_value"] is not None
    ]
    samples_c = [
        e["sampled_value"] for e in decision_c["candidates"] if e["sampled_value"] is not None
    ]
    assert samples_a != samples_c


def test_cli_dry_run_writes_nothing(tmp_path):
    result = run_cli(
        [
            "--nodes", str(FIXTURE),
            "--seed", "42",
            "--deep-slots", "1",
            "--recon-slots", "1",
            "--dry-run",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert "dry-run" in result.stdout
    assert not (tmp_path / "artifacts").exists()


def test_cli_artifact_validates_and_summary_prints(tmp_path):
    result = run_cli(
        [
            "--nodes", str(FIXTURE),
            "--seed", "42",
            "--deep-slots", "1",
            "--recon-slots", "1",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert "THOMPSON SAMPLING ALLOCATION" in result.stdout
    assert "DEEP INVESTMENT" in result.stdout
    assert "WAITING ACTIVATION" in result.stdout
    artifact_files = list((tmp_path / "artifacts" / "allocations").iterdir())
    assert len(artifact_files) == 1
    decision = json.loads(artifact_files[0].read_text())
    assert ta.validate_allocation_decision(decision) == []
    assert artifact_files[0].name == f"allocation-{decision['decision_id']}.json"


def test_cli_campaign_id_mismatch_fails(tmp_path):
    result = run_cli(
        [
            "--nodes", str(FIXTURE),
            "--seed", "1",
            "--deep-slots", "1",
            "--recon-slots", "1",
            "--campaign-id", "11111111-2222-4333-8444-555555555555",
        ],
        cwd=tmp_path,
    )
    assert result.returncode != 0
    assert "campaign_id mismatch" in result.stderr


def test_cli_rejects_bad_posterior(tmp_path):
    nodes = [active_node("idea-alpha", 1.5, 3)]
    path = make_store(tmp_path, nodes)
    result = run_cli(
        ["--nodes", str(path), "--seed", "1", "--deep-slots", "1", "--recon-slots", "1"],
        cwd=tmp_path,
    )
    assert result.returncode != 0
    assert "posterior.value" in result.stderr


def test_cli_rejects_negative_slots(tmp_path):
    result = run_cli(
        [
            "--nodes", str(FIXTURE),
            "--seed", "1",
            "--deep-slots", "-1",
            "--recon-slots", "1",
        ],
        cwd=tmp_path,
    )
    assert result.returncode != 0


def test_cli_requires_slots_and_seed(tmp_path):
    result = run_cli(["--nodes", str(FIXTURE)], cwd=tmp_path)
    assert result.returncode != 0  # argparse: missing required arguments


def test_mapping_form_of_nodes_accepted(tmp_path):
    path = tmp_path / "nodes_latest.json"
    path.write_text(
        json.dumps(
            {
                "campaign_id": CAMPAIGN_ID,
                "nodes": {
                    "idea-alpha": {
                        "posterior": {
                            "value": 0.6,
                            "evidence_count": 10,
                            "updated_at": "2026-07-01T00:00:00Z",
                        }
                    },
                    "idea-beta": {"lifecycle_state": "active"},
                },
            }
        ),
        encoding="utf-8",
    )
    import nodes_store

    campaign_id, nodes = nodes_store.load_nodes_file(str(path))
    assert campaign_id == CAMPAIGN_ID
    decision = ta.build_decision(
        campaign_id, nodes, seed=3, deep_slots=1, recon_slots=0,
        generated_at="2026-07-05T00:00:00Z",
    )
    allocations = {e["node_id"]: e["allocation"] for e in decision["candidates"]}
    assert allocations == {
        "idea-alpha": "deep_investment",
        "idea-beta": "reconnaissance",
    }
