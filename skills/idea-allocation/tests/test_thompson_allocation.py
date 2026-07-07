"""Allocation logic: slot cuts, cold start, exclusions, reproducibility."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import nodes_store
import thompson_allocation as ta
# Paths derived locally rather than imported from conftest: pytest loads each
# directory's conftest for sys.path wiring, but importing conftest AS A MODULE
# collides when several skills' suites run in one pytest invocation (the first
# loaded conftest shadows the rest in sys.modules).
SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

FIXTURE = FIXTURES_DIR / "nodes_latest.json"
# Engine short id: 8 chars of lowercase Crockford base32 (idea_node_v1 /
# allocation_decision_v1 convention).
CAMPAIGN_ID = "0f3c2c8e"
SCRIPT = SCRIPTS_DIR / "thompson_allocation.py"


def load_fixture_nodes():
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
        "literature_coverage": {
            "status": "saturated",
            "survey_ref": f"project://artifacts/literature/{node_id}-literature_survey_v1.json#sha256:{'a' * 64}",
            "close_prior_matrix_ref": f"project://artifacts/literature/{node_id}-close-prior-matrix.json#sha256:{'b' * 64}",
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
    assert {n["node_id"] for n in groups["sampled"]} == {"a1pha000", "beta0000", "eta00000"}
    assert groups["literature_blocked"] == []
    assert {n["node_id"] for n in groups["cold_start"]} == {"gamma000"}
    assert {n["node_id"] for n in groups["waiting"]} == {
        "de1ta000", "eps110n0", "10ta0000", "kappa000", "1ambda00",
    }
    assert {n["node_id"] for n in groups["archived"]} == {"zeta0000"}


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
        active_node("a1pha000", 0.8, 20),
        active_node("beta0000", 0.3, 4),
        {"node_id": "gamma000", "lifecycle_state": "active"},
        {"node_id": "mv000000", "lifecycle_state": "active"},
    ]
    path = make_store(tmp_path, nodes)
    campaign_id, loaded = nodes_store.load_nodes_file(str(path))
    decision = ta.build_decision(
        campaign_id, loaded, seed=11, deep_slots=5, recon_slots=2,
        generated_at="2026-07-05T00:00:00Z",
    )
    deep = [e for e in decision["candidates"] if e["allocation"] == "deep_investment"]
    assert {e["node_id"] for e in deep} == {"a1pha000", "beta0000"}
    cold = [e for e in decision["candidates"] if e["sampled_value"] is None]
    assert {e["node_id"] for e in cold} == {"gamma000", "mv000000"}
    for entry in cold:
        assert entry["allocation"] == "reconnaissance"
        assert entry["posterior_value"] is None and entry["evidence_count"] is None
        assert "no posterior yet" in entry["budget_note"]
        assert "belief graph" in entry["budget_note"]
        assert entry["allocation_eligible"] is False
        assert entry["literature_coverage_status"] == "metadata_only"
    # Cold starts sit at the tail, after every sampled candidate.
    ids = [e["node_id"] for e in decision["candidates"]]
    assert ids.index("gamma000") > max(ids.index("a1pha000"), ids.index("beta0000"))


def test_coverage_incomplete_with_posterior_is_not_sampled_or_eligible(tmp_path):
    blocked = active_node("a1pha000", 0.95, 30)
    blocked["literature_coverage"] = {
        "status": "coverage_incomplete",
        "survey_ref": f"project://artifacts/literature/a1pha000-literature_survey_v1.json#sha256:{'c' * 64}",
        "close_prior_matrix_ref": f"project://artifacts/literature/a1pha000-close-prior-matrix.json#sha256:{'d' * 64}",
    }
    nodes = [
        blocked,
        active_node("beta0000", 0.2, 3),
    ]
    path = make_store(tmp_path, nodes)
    campaign_id, loaded = nodes_store.load_nodes_file(str(path))
    groups = ta.split_nodes(loaded)
    assert {n["node_id"] for n in groups["sampled"]} == {"beta0000"}
    assert {n["node_id"] for n in groups["literature_blocked"]} == {"a1pha000"}
    decision = ta.build_decision(
        campaign_id, loaded, seed=5, deep_slots=2, recon_slots=0,
        generated_at="2026-07-05T00:00:00Z",
    )
    by_id = {entry["node_id"]: entry for entry in decision["candidates"]}
    assert by_id["a1pha000"]["allocation"] == "hold"
    assert by_id["a1pha000"]["sampled_value"] is None
    assert by_id["a1pha000"]["allocation_eligible"] is False
    assert by_id["a1pha000"]["literature_coverage_status"] == "coverage_incomplete"
    assert "not allocation eligible" in by_id["a1pha000"]["budget_note"]
    assert by_id["beta0000"]["allocation"] == "deep_investment"
    assert ta.validate_allocation_decision(decision) == []


def test_coverage_incomplete_can_be_explicit_exploratory(tmp_path):
    exploratory = active_node("a1pha000", 0.95, 30)
    exploratory["literature_coverage"] = {
        "status": "coverage_incomplete",
        "exploratory_allocation": True,
        "survey_ref": f"project://artifacts/literature/a1pha000-literature_survey_v1.json#sha256:{'c' * 64}",
        "close_prior_matrix_ref": f"project://artifacts/literature/a1pha000-close-prior-matrix.json#sha256:{'d' * 64}",
    }
    path = make_store(tmp_path, [exploratory])
    campaign_id, loaded = nodes_store.load_nodes_file(str(path))
    decision = ta.build_decision(
        campaign_id, loaded, seed=5, deep_slots=1, recon_slots=0,
        generated_at="2026-07-05T00:00:00Z",
    )
    entry = decision["candidates"][0]
    assert entry["node_id"] == "a1pha000"
    assert entry["allocation"] == "deep_investment"
    assert entry["allocation_eligible"] is True
    assert entry["exploratory_allocation"] is True
    assert entry["literature_coverage_status"] == "coverage_incomplete"
    assert "exploratory allocation" in entry["budget_note"]
    assert ta.validate_allocation_decision(decision) == []


def test_stale_posterior_is_not_sampled_even_with_saturated_coverage(tmp_path):
    stale = active_node("a1pha000", 0.95, 30)
    stale["posterior"]["status"] = "stale"
    fresh = active_node("beta0000", 0.2, 3)
    path = make_store(tmp_path, [stale, fresh])
    campaign_id, loaded = nodes_store.load_nodes_file(str(path))
    groups = ta.split_nodes(loaded)
    assert {n["node_id"] for n in groups["sampled"]} == {"beta0000"}
    assert {n["node_id"] for n in groups["literature_blocked"]} == {"a1pha000"}
    decision = ta.build_decision(
        campaign_id, loaded, seed=5, deep_slots=2, recon_slots=0,
        generated_at="2026-07-05T00:00:00Z",
    )
    by_id = {entry["node_id"]: entry for entry in decision["candidates"]}
    assert by_id["a1pha000"]["allocation"] == "hold"
    assert by_id["a1pha000"]["sampled_value"] is None
    assert by_id["a1pha000"]["allocation_eligible"] is False
    assert by_id["a1pha000"]["posterior_status"] == "stale"
    assert "posterior status is stale" in by_id["a1pha000"]["budget_note"]
    assert by_id["beta0000"]["allocation"] == "deep_investment"
    assert ta.validate_allocation_decision(decision) == []


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
        "de1ta000", "eps110n0", "10ta0000", "kappa000", "1ambda00",
    }
    by_id = {w["node_id"]: w for w in waiting}
    assert by_id["de1ta000"]["last_checked_at"] == "2026-06-28T16:00:00Z"
    assert by_id["10ta0000"]["last_checked_at"] is None
    condition = by_id["eps110n0"]["activation_condition"]
    assert set(condition) == {"kind", "description", "satisfied"}
    assert condition["satisfied"] is True
    # Waiting and archived ids never appear among candidates.
    candidate_ids = {c["node_id"] for c in decision["candidates"]}
    assert candidate_ids.isdisjoint({w["node_id"] for w in waiting})
    assert "zeta0000" not in candidate_ids


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
            "--campaign-id", "11111111",
        ],
        cwd=tmp_path,
    )
    assert result.returncode != 0
    assert "campaign_id mismatch" in result.stderr


def test_cli_rejects_dashed_uuid_campaign_id(tmp_path):
    # The retired dashed-uuid convention is exactly what the engine contract
    # excludes; the CLI must reject it with the engine pattern in the message.
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
    assert "engine short id" in result.stderr
    assert nodes_store.SHORT_ID_RE.pattern in result.stderr


def test_cli_rejects_bad_posterior(tmp_path):
    nodes = [active_node("a1pha000", 1.5, 3)]
    path = make_store(tmp_path, nodes)
    result = run_cli(
        ["--nodes", str(path), "--seed", "1", "--deep-slots", "1", "--recon-slots", "1"],
        cwd=tmp_path,
    )
    assert result.returncode != 0
    assert "posterior.value" in result.stderr


def test_loader_defaults_missing_literature_coverage_to_metadata_only(tmp_path):
    path = make_store(tmp_path, [{"node_id": "a1pha000", "lifecycle_state": "active"}])
    _, nodes = nodes_store.load_nodes_file(str(path))
    assert nodes[0]["literature_coverage"] == {
        "status": "metadata_only",
        "exploratory_allocation": False,
    }


def test_loader_rejects_exploratory_flag_outside_coverage_incomplete(tmp_path):
    node = active_node("a1pha000", 0.5, 3)
    node["literature_coverage"]["exploratory_allocation"] = True
    path = make_store(tmp_path, [node])
    with pytest.raises(nodes_store.StoreError) as excinfo:
        nodes_store.load_nodes_file(str(path))
    assert "exploratory_allocation is only allowed" in str(excinfo.value)


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
                    "a1pha000": {
                        "posterior": {
                            "value": 0.6,
                            "evidence_count": 10,
                            "updated_at": "2026-07-01T00:00:00Z",
                        },
                        "literature_coverage": {
                            "status": "saturated",
                            "survey_ref": f"project://artifacts/literature/a1pha000-literature_survey_v1.json#sha256:{'a' * 64}",
                            "close_prior_matrix_ref": f"project://artifacts/literature/a1pha000-close-prior-matrix.json#sha256:{'b' * 64}",
                        },
                    },
                    "beta0000": {"lifecycle_state": "active"},
                },
            }
        ),
        encoding="utf-8",
    )
    campaign_id, nodes = nodes_store.load_nodes_file(str(path))
    assert campaign_id == CAMPAIGN_ID
    decision = ta.build_decision(
        campaign_id, nodes, seed=3, deep_slots=1, recon_slots=0,
        generated_at="2026-07-05T00:00:00Z",
    )
    allocations = {e["node_id"]: e["allocation"] for e in decision["candidates"]}
    assert allocations == {
        "a1pha000": "deep_investment",
        "beta0000": "reconnaissance",
    }


def test_engine_top_level_node_map_accepted_with_campaign_id_inferred(tmp_path):
    campaign_dir = tmp_path / "idea-store" / "campaigns" / CAMPAIGN_ID
    campaign_dir.mkdir(parents=True)
    path = campaign_dir / "nodes_latest.json"
    path.write_text(
        json.dumps(
            {
                "a1pha000": active_node("a1pha000", 0.6, 10),
                "beta0000": {"lifecycle_state": "active"},
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    campaign_id, nodes = nodes_store.load_nodes_file(str(path))

    assert campaign_id == CAMPAIGN_ID
    assert [node["node_id"] for node in nodes] == ["a1pha000", "beta0000"]
    decision = ta.build_decision(
        campaign_id, nodes, seed=3, deep_slots=1, recon_slots=0,
        generated_at="2026-07-05T00:00:00Z",
    )
    allocations = {e["node_id"]: e["allocation"] for e in decision["candidates"]}
    assert allocations == {
        "a1pha000": "deep_investment",
        "beta0000": "reconnaissance",
    }


def test_cli_reads_engine_top_level_node_map_directly(tmp_path):
    campaign_dir = tmp_path / "project" / "idea-store" / "campaigns" / CAMPAIGN_ID
    campaign_dir.mkdir(parents=True)
    path = campaign_dir / "nodes_latest.json"
    path.write_text(
        json.dumps({"a1pha000": active_node("a1pha000", 0.6, 10)}, indent=2),
        encoding="utf-8",
    )

    result = run_cli(
        [
            "--nodes", str(path),
            "--seed", "42",
            "--deep-slots", "1",
            "--recon-slots", "0",
            "--dry-run",
        ],
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert "a1pha000" in result.stdout


# ---------------------------------------------------------------------------
# Engine id convention (8-char short ids)
# ---------------------------------------------------------------------------

def test_decision_id_is_deterministic_and_engine_convention():
    """Same semantic inputs (campaign id, seed, generated_at, store digest)
    must always give the same decision_id, and the id must follow the engine
    short-id convention."""
    digest = "ab" * 32
    args = (CAMPAIGN_ID, 42, "2026-07-05T00:00:00Z", digest)
    first = nodes_store.derive_decision_id(*args)
    second = nodes_store.derive_decision_id(*args)
    assert first == second
    assert nodes_store.SHORT_ID_RE.match(first)
    # Every input component participates in the derivation.
    assert nodes_store.derive_decision_id("11111111", 42, "2026-07-05T00:00:00Z", digest) != first
    assert nodes_store.derive_decision_id(CAMPAIGN_ID, 43, "2026-07-05T00:00:00Z", digest) != first
    assert nodes_store.derive_decision_id(CAMPAIGN_ID, 42, "2026-07-05T00:00:01Z", digest) != first
    assert nodes_store.derive_decision_id(CAMPAIGN_ID, 42, "2026-07-05T00:00:00Z", "cd" * 32) != first


def test_derived_decision_ids_use_the_full_engine_alphabet():
    derived = [
        nodes_store.derive_decision_id(CAMPAIGN_ID, seed, "2026-07-05T00:00:00Z", "ab" * 32)
        for seed in range(64)
    ]
    chars = set("".join(derived))
    assert chars <= set(nodes_store.SHORT_ID_ALPHABET)
    # 512 uniformly mapped digest bytes all landing inside the 16 hex symbols
    # has probability 2^-512, so a hex/uuid-prefix shortcut cannot pass this.
    assert any(c not in "0123456789abcdef" for c in chars)


def test_build_decision_id_reproducible_across_calls():
    campaign_id, nodes = load_fixture_nodes()
    kwargs = dict(seed=7, deep_slots=1, recon_slots=1, generated_at="2026-07-05T00:00:00Z")
    one = ta.build_decision(campaign_id, nodes, **kwargs)
    two = ta.build_decision(campaign_id, nodes, **kwargs)
    assert one["decision_id"] == two["decision_id"]
    assert nodes_store.SHORT_ID_RE.match(one["decision_id"])


def test_loader_rejects_retired_dashed_uuid_campaign_id(tmp_path):
    path = make_store(
        tmp_path,
        [active_node("a1pha000", 0.5, 3)],
        campaign_id="0f3c2c8e-5df1-4a3a-9b6e-2f1a7c9d4e10",
    )
    with pytest.raises(nodes_store.StoreError) as excinfo:
        nodes_store.load_nodes_file(str(path))
    message = str(excinfo.value)
    assert "engine short id" in message
    assert nodes_store.SHORT_ID_RE.pattern in message


@pytest.mark.parametrize(
    "bad_node_id",
    [
        "idea-alpha",                             # retired prose-style id
        "4c9a2d10-7e5f-4b8a-9c3d-6e1f2a3b4c5d",   # retired dashed-uuid style
        "abcdilou",                               # i/l/o/u sit outside Crockford
        "1f6c9d5",                                # right alphabet, wrong length
        "ABCDEF12",                               # uppercase is excluded
    ],
)
def test_loader_rejects_non_engine_node_ids(tmp_path, bad_node_id):
    path = make_store(tmp_path, [active_node(bad_node_id, 0.5, 3)])
    with pytest.raises(nodes_store.StoreError) as excinfo:
        nodes_store.load_nodes_file(str(path))
    assert "engine short id" in str(excinfo.value)
