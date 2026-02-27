from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from jsonschema import Draft202012Validator, FormatChecker

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService
from idea_core.engine.utils import sha256_hex, utc_now_iso
from idea_core.hepar.fs_ops import atomic_write_text


UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
SHA_RE = re.compile(r"sha256:[a-f0-9]{64}", re.IGNORECASE)
DATETIME_RE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b",
)
RUN_TAG_RE = re.compile(r"\brun-[A-Za-z0-9._-]+\b")

FIXED_SEED_PACK: dict[str, Any] = {
    "seeds": [
        {
            "seed_type": "text",
            "content": "Probe a bridge-style deformation around a toy hep formalism.",
            "source_uris": ["https://example.org/demo/m2.12/seed-bridge"],
        },
        {
            "seed_type": "text",
            "content": "Shift one boundary constraint and test the failure boundary.",
            "source_uris": ["https://example.org/demo/m2.12/seed-constraint"],
        },
    ]
}

FIXED_CHARTER: dict[str, Any] = {
    "campaign_name": "m2.12-replay-demo",
    "domain": "hep-ph",
    "scope": "fixed-seed replayable campaign for M2.12",
    "approval_gate_ref": "gate://a0.1",
}

FIXED_BUDGET: dict[str, Any] = {
    "max_tokens": 100000,
    "max_cost_usd": 100.0,
    "max_wall_clock_s": 100000,
    "max_steps": 20,
    "max_nodes": 64,
}

DEMO_SCHEMA_PATH = Path(__file__).resolve().parent / "schemas" / "demo_manifest_v1.schema.json"


def _file_uri(path: Path) -> str:
    return path.resolve().as_uri()


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def _idem(run_tag: str, method: str, index: int) -> str:
    return f"{run_tag}:{method}:{index:02d}"


def _artifact_exists(artifact_ref: str) -> bool:
    parsed = urlparse(artifact_ref)
    if parsed.scheme != "file":
        return False
    return Path(unquote(parsed.path)).exists()


def _normalize_string(value: str) -> str:
    normalized = UUID_RE.sub("<uuid>", value)
    normalized = SHA_RE.sub("sha256:<hash>", normalized)
    normalized = DATETIME_RE.sub("<datetime>", normalized)
    normalized = RUN_TAG_RE.sub("<run_tag>", normalized)
    if normalized.startswith("file://"):
        if "/artifacts/" in normalized:
            _, suffix = normalized.split("/artifacts/", 1)
            return f"file://<campaign>/artifacts/{suffix}"
        if normalized.endswith("/nodes_latest.json"):
            return "file://<campaign>/nodes_latest.json"
        if normalized.endswith("/nodes_log.jsonl"):
            return "file://<campaign>/nodes_log.jsonl"
        return "file://<path>"
    return normalized


def _normalize_for_compare(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _normalize_for_compare(value[k]) for k in sorted(value.keys())}
    if isinstance(value, list):
        return [_normalize_for_compare(item) for item in value]
    if isinstance(value, str):
        return _normalize_string(value)
    return value


def _validate_demo_manifest(manifest: dict[str, Any]) -> None:
    schema = json.loads(DEMO_SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(manifest), key=lambda err: list(err.path))
    if not errors:
        return
    first = errors[0]
    location = "/".join(str(item) for item in first.path) or "<root>"
    raise ValueError(f"demo_manifest_invalid at '{location}': {first.message}")


def _first_diff_path(left: Any, right: Any, path: str = "$") -> str | None:
    if type(left) is not type(right):
        return path
    if isinstance(left, dict):
        left_keys = sorted(left.keys())
        right_keys = sorted(right.keys())
        if left_keys != right_keys:
            return path
        for key in left_keys:
            child = _first_diff_path(left[key], right[key], f"{path}.{key}")
            if child is not None:
                return child
        return None
    if isinstance(left, list):
        if len(left) != len(right):
            return path
        for index, (lhs, rhs) in enumerate(zip(left, right)):
            child = _first_diff_path(lhs, rhs, f"{path}[{index}]")
            if child is not None:
                return child
        return None
    if left != right:
        return path
    return None


def compare_manifests(left_manifest: dict[str, Any], right_manifest: dict[str, Any]) -> dict[str, Any]:
    left_normalized = _normalize_for_compare(left_manifest)
    right_normalized = _normalize_for_compare(right_manifest)
    diff_path = _first_diff_path(left_normalized, right_normalized)
    left_canonical = json.dumps(left_normalized, sort_keys=True, ensure_ascii=False)
    right_canonical = json.dumps(right_normalized, sort_keys=True, ensure_ascii=False)
    return {
        "isomorphic": diff_path is None,
        "first_diff_path": diff_path,
        "left_digest": f"sha256:{sha256_hex(left_canonical)}",
        "right_digest": f"sha256:{sha256_hex(right_canonical)}",
        "left_normalized": left_normalized,
        "right_normalized": right_normalized,
    }


def run_demo_campaign(
    *,
    output_dir: Path,
    run_tag: str,
    contract_dir: Path = DEFAULT_CONTRACT_DIR,
) -> dict[str, Any]:
    run_dir = output_dir / run_tag
    store_dir = run_dir / "store"
    service = IdeaCoreService(data_dir=store_dir, contract_dir=contract_dir)

    call_log: list[dict[str, Any]] = []
    call_order: list[str] = []

    init_params = {
        "charter": FIXED_CHARTER,
        "seed_pack": FIXED_SEED_PACK,
        "budget": FIXED_BUDGET,
        "idempotency_key": _idem(run_tag, "campaign.init", 1),
    }
    init_result = service.handle("campaign.init", init_params)
    campaign_id = init_result["campaign_id"]
    call_order.append("campaign.init")
    call_log.append(
        {
            "method": "campaign.init",
            "idempotency_key": init_params["idempotency_key"],
            "request_summary": {
                "seed_count": len(FIXED_SEED_PACK["seeds"]),
                "budget": FIXED_BUDGET,
            },
            "result_summary": {
                "campaign_id": campaign_id,
                "status": init_result["status"],
                "created_at": init_result["created_at"],
            },
        }
    )

    search_params = {
        "campaign_id": campaign_id,
        "n_steps": 2,
        "idempotency_key": _idem(run_tag, "search.step", 1),
    }
    search_result = service.handle("search.step", search_params)
    call_order.append("search.step")
    call_log.append(
        {
            "method": "search.step",
            "idempotency_key": search_params["idempotency_key"],
            "request_summary": {"n_steps": 2},
            "result_summary": {
                "step_id": search_result["step_id"],
                "new_node_ids": search_result["new_node_ids"],
                "new_nodes_artifact_ref": search_result.get("new_nodes_artifact_ref"),
            },
        }
    )

    status_after_search = service.handle("campaign.status", {"campaign_id": campaign_id})
    search_replay_result = service.handle("search.step", search_params)
    status_after_replay = service.handle("campaign.status", {"campaign_id": campaign_id})
    call_order.append("search.step(replay)")
    call_log.append(
        {
            "method": "search.step(replay)",
            "idempotency_key": search_params["idempotency_key"],
            "request_summary": {"n_steps": 2},
            "result_summary": {
                "step_id": search_replay_result["step_id"],
                "is_replay": search_replay_result["idempotency"]["is_replay"],
            },
        }
    )

    promoted_candidate = search_result["new_node_ids"][0]

    eval_params = {
        "campaign_id": campaign_id,
        "node_ids": [promoted_candidate],
        "evaluator_config": {
            "dimensions": ["novelty", "impact", "grounding"],
            "n_reviewers": 2,
        },
        "idempotency_key": _idem(run_tag, "eval.run", 1),
    }
    eval_result = service.handle("eval.run", eval_params)
    call_order.append("eval.run")
    call_log.append(
        {
            "method": "eval.run",
            "idempotency_key": eval_params["idempotency_key"],
            "request_summary": {"node_ids": eval_params["node_ids"]},
            "result_summary": {
                "updated_node_ids": eval_result["updated_node_ids"],
                "scorecards_artifact_ref": eval_result["scorecards_artifact_ref"],
            },
        }
    )

    rank_params = {
        "campaign_id": campaign_id,
        "method": "pareto",
        "dimensions": ["novelty", "impact"],
        "idempotency_key": _idem(run_tag, "rank.compute", 1),
    }
    rank_result = service.handle("rank.compute", rank_params)
    call_order.append("rank.compute")
    call_log.append(
        {
            "method": "rank.compute",
            "idempotency_key": rank_params["idempotency_key"],
            "request_summary": {
                "method": rank_params["method"],
                "dimensions": rank_params["dimensions"],
            },
            "result_summary": {
                "ranking_artifact_ref": rank_result["ranking_artifact_ref"],
                "ranked_nodes": rank_result["ranked_nodes"],
            },
        }
    )

    ranked_node_id = rank_result["ranked_nodes"][0]["node_id"]
    promote_params = {
        "campaign_id": campaign_id,
        "node_id": ranked_node_id,
        "idempotency_key": _idem(run_tag, "node.promote", 1),
    }
    promote_result = service.handle("node.promote", promote_params)
    call_order.append("node.promote")
    call_log.append(
        {
            "method": "node.promote",
            "idempotency_key": promote_params["idempotency_key"],
            "request_summary": {"node_id": ranked_node_id},
            "result_summary": {
                "node_id": promote_result["node_id"],
                "handoff_artifact_ref": promote_result["handoff_artifact_ref"],
            },
        }
    )

    artifact_refs = {
        "new_nodes_artifact_ref": search_result["new_nodes_artifact_ref"],
        "scorecards_artifact_ref": eval_result["scorecards_artifact_ref"],
        "ranking_artifact_ref": rank_result["ranking_artifact_ref"],
        "handoff_artifact_ref": promote_result["handoff_artifact_ref"],
        "nodes_latest_ref": _file_uri(service.store.nodes_latest_path(campaign_id)),
        "nodes_log_ref": _file_uri(service.store.nodes_log_path(campaign_id)),
    }
    required_artifacts_exist = all(_artifact_exists(ref) for ref in artifact_refs.values())
    replay_step_unchanged = (
        status_after_search["budget_snapshot"]["steps_used"]
        == status_after_replay["budget_snapshot"]["steps_used"]
    )
    replay_nodes_unchanged = (
        status_after_search["budget_snapshot"]["nodes_used"]
        == status_after_replay["budget_snapshot"]["nodes_used"]
    )
    replay_same_result = (
        search_result["step_id"] == search_replay_result["step_id"]
        and search_result["new_node_ids"] == search_replay_result["new_node_ids"]
    )
    replay_flag_true = search_replay_result["idempotency"]["is_replay"] is True

    validations = {
        "search_replay_is_replay": replay_flag_true,
        "search_replay_step_counter_unchanged": replay_step_unchanged,
        "search_replay_node_counter_unchanged": replay_nodes_unchanged,
        "search_replay_same_result": replay_same_result,
        "required_artifacts_exist": required_artifacts_exist,
    }
    validations["status"] = (
        "pass" if all(validations.values()) else "fail"
    )

    manifest = {
        "schema_version": 1,
        "milestone": "M2.12",
        "generated_at": utc_now_iso(),
        "run_tag": run_tag,
        "run_dir": str(run_dir.resolve()),
        "store_dir": str(store_dir.resolve()),
        "script_entry": "python -m idea_core.demo.m2_12_replay",
        "campaign_id": campaign_id,
        "fixed_inputs": {
            "charter": FIXED_CHARTER,
            "seed_pack": FIXED_SEED_PACK,
            "budget": FIXED_BUDGET,
        },
        "call_order": call_order,
        "idempotency_keys": {
            "campaign.init": init_params["idempotency_key"],
            "search.step": search_params["idempotency_key"],
            "eval.run": eval_params["idempotency_key"],
            "rank.compute": rank_params["idempotency_key"],
            "node.promote": promote_params["idempotency_key"],
        },
        "calls": call_log,
        "key_results": {
            "search_step": {
                "step_id": search_result["step_id"],
                "new_node_ids": search_result["new_node_ids"],
                "new_nodes_artifact_ref": search_result.get("new_nodes_artifact_ref"),
            },
            "eval_run": {
                "updated_node_ids": eval_result["updated_node_ids"],
                "scorecards_artifact_ref": eval_result["scorecards_artifact_ref"],
            },
            "rank_compute": {
                "method": rank_result["method"],
                "effective_dimensions": rank_result["effective_dimensions"],
                "ranked_nodes": rank_result["ranked_nodes"],
                "ranking_artifact_ref": rank_result["ranking_artifact_ref"],
            },
            "node_promote": {
                "node_id": promote_result["node_id"],
                "handoff_artifact_ref": promote_result["handoff_artifact_ref"],
            },
        },
        "artifact_refs": artifact_refs,
        "validations": validations,
    }
    manifest_path = run_dir / "demo_manifest.json"
    canonical_manifest_path = run_dir / "demo_manifest_canonical.json"
    manifest["manifest_ref"] = _file_uri(manifest_path)
    manifest["canonical_manifest_ref"] = _file_uri(canonical_manifest_path)
    _validate_demo_manifest(manifest)
    canonical_manifest = _normalize_for_compare(manifest)
    _write_json(manifest_path, manifest)
    _write_json(canonical_manifest_path, {"normalized": canonical_manifest})
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run fixed-seed replayable demo campaign for M2.12.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("docs/demos/2026-02-13-m2.12-demo-v1"),
        help="Base directory for demo run outputs.",
    )
    parser.add_argument(
        "--run-tag",
        default="run-001",
        help="Stable run tag used in artifact layout and idempotency key prefixes.",
    )
    parser.add_argument(
        "--contract-dir",
        type=Path,
        default=DEFAULT_CONTRACT_DIR,
        help="Vendored contract directory.",
    )
    parser.add_argument(
        "--compare-with",
        type=Path,
        default=None,
        help="Optional prior demo_manifest.json to compare isomorphism against.",
    )
    parser.add_argument(
        "--compare-report",
        type=Path,
        default=None,
        help="Optional explicit path for isomorphism report JSON.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = run_demo_campaign(
        output_dir=args.output_dir,
        run_tag=args.run_tag,
        contract_dir=args.contract_dir,
    )
    print(f"manifest: {manifest['manifest_ref']}")

    if args.compare_with is None:
        return 0

    base_manifest = json.loads(args.compare_with.read_text(encoding="utf-8"))
    compare_result = compare_manifests(base_manifest, manifest)
    report_path = (
        args.compare_report
        if args.compare_report is not None
        else (args.output_dir / args.run_tag / "isomorphism_report.json")
    )
    _write_json(report_path, compare_result)
    print(f"isomorphism_report: {_file_uri(report_path)}")
    if compare_result["isomorphic"]:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
