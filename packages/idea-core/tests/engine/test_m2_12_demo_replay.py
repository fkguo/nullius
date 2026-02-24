from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlparse

from idea_core.demo.m2_12_replay import compare_manifests, run_demo_campaign
from idea_core.engine.store import EngineStore


def _uri_path(uri: str) -> Path:
    parsed = urlparse(uri)
    assert parsed.scheme == "file"
    return Path(unquote(parsed.path))


def test_m2_12_demo_smoke_produces_required_artifacts(tmp_path: Path) -> None:
    output_dir = tmp_path / "demos with space"
    manifest = run_demo_campaign(output_dir=output_dir, run_tag="run-001")

    assert manifest["milestone"] == "M2.12"
    assert manifest["validations"]["status"] == "pass"
    assert manifest["campaign_id"]
    assert manifest["call_order"] == [
        "campaign.init",
        "search.step",
        "search.step(replay)",
        "eval.run",
        "rank.compute",
        "node.promote",
    ]
    assert len(manifest["key_results"]["search_step"]["new_node_ids"]) >= 1
    assert len(manifest["key_results"]["rank_compute"]["ranked_nodes"]) >= 1

    for key in [
        "new_nodes_artifact_ref",
        "scorecards_artifact_ref",
        "ranking_artifact_ref",
        "handoff_artifact_ref",
        "nodes_latest_ref",
        "nodes_log_ref",
    ]:
        ref = manifest["artifact_refs"][key]
        assert ref.startswith("file://")
        assert _uri_path(ref).exists()

    assert _uri_path(manifest["manifest_ref"]).exists()
    assert _uri_path(manifest["canonical_manifest_ref"]).exists()


def test_m2_12_demo_replay_isomorphic_between_two_runs(tmp_path: Path) -> None:
    output_dir = tmp_path / "demos"
    manifest_a = run_demo_campaign(output_dir=output_dir, run_tag="run-001")
    manifest_b = run_demo_campaign(output_dir=output_dir, run_tag="run-002")

    report = compare_manifests(manifest_a, manifest_b)
    assert report["isomorphic"] is True
    assert report["first_diff_path"] is None
    assert report["left_digest"] == report["right_digest"]


def test_m2_12_demo_idempotency_replay_does_not_duplicate_side_effects(tmp_path: Path) -> None:
    output_dir = tmp_path / "demos"
    manifest = run_demo_campaign(output_dir=output_dir, run_tag="run-001")

    assert manifest["validations"]["search_replay_is_replay"] is True
    assert manifest["validations"]["search_replay_step_counter_unchanged"] is True
    assert manifest["validations"]["search_replay_node_counter_unchanged"] is True
    assert manifest["validations"]["search_replay_same_result"] is True

    store = EngineStore(Path(manifest["store_dir"]))
    campaign = store.load_campaign(manifest["campaign_id"])
    assert campaign is not None
    # Two fixed seeds + two new nodes from search.step n_steps=2.
    assert campaign["usage"]["nodes_used"] == 4
    # search.step + eval.run + rank.compute + node.promote => 5 steps used total.
    assert campaign["usage"]["steps_used"] == 5


def test_m2_12_compare_detects_structural_difference(tmp_path: Path) -> None:
    output_dir = tmp_path / "demos"
    manifest_a = run_demo_campaign(output_dir=output_dir, run_tag="run-001")
    manifest_b = run_demo_campaign(output_dir=output_dir, run_tag="run-002")
    manifest_b["key_results"]["rank_compute"]["method"] = "elo"

    report = compare_manifests(manifest_a, manifest_b)
    assert report["isomorphic"] is False
    assert report["first_diff_path"] == "$.key_results.rank_compute.method"


def test_m2_12_demo_manifest_writes_leave_no_temp_files(tmp_path: Path) -> None:
    output_dir = tmp_path / "demos"
    _ = run_demo_campaign(output_dir=output_dir, run_tag="run-001")
    _ = run_demo_campaign(output_dir=output_dir, run_tag="run-001")

    leftovers = sorted(path.name for path in (output_dir / "run-001").glob("*.tmp*"))
    assert leftovers == []
