"""Offline tests for build_portfolio_status_report.py (no Gaia install needed)."""

from __future__ import annotations

import json
from pathlib import Path

import build_portfolio_status_report as report


def _write_package(
    root: Path,
    rel: str,
    *,
    worth_value: float,
    with_starmap: bool = True,
) -> str:
    """Create a minimal compiled package under root/rel; return its project:// ref."""
    pkg = root / rel
    (pkg / ".gaia").mkdir(parents=True)
    ir = {
        "knowledges": [
            {"id": "p:x::worth", "title": "worth", "type": "claim"},
            {"id": "p:x::sub_a", "title": "criterion_a", "type": "claim"},
            {"id": "p:x::ev_b", "title": "evidence_b", "type": "claim"},
        ],
        "strategies": [
            {
                "type": "infer",
                "premises": ["p:x::ev_b"],
                "conclusion": "p:x::sub_a",
                "conditional_probabilities": [0.09, 0.9],
                "steps": [{"reasoning": "Substantial: the check directly supports criterion_a."}],
            },
            {
                "type": "infer",
                "premises": ["p:x::sub_a"],
                "conclusion": "p:x::ev_b",
                "conditional_probabilities": [0.9, 0.09],
                "steps": [{"reasoning": "Substantial lowering: a close prior already covers this."}],
            },
            {
                # unscored form: no conditional probabilities -> never a driver
                "type": "support",
                "premises": ["p:x::ev_b"],
                "conclusion": "p:x::worth",
                "steps": [{"reasoning": "Unscored support step."}],
            },
        ],
    }
    beliefs = {
        "beliefs": [
            {"knowledge_id": "p:x::worth", "label": "worth", "belief": worth_value},
            {"knowledge_id": "p:x::sub_a", "label": "criterion_a", "belief": 0.7},
        ]
    }
    (pkg / ".gaia" / "ir.json").write_text(json.dumps(ir), encoding="utf-8")
    (pkg / ".gaia" / "beliefs.json").write_text(json.dumps(beliefs), encoding="utf-8")
    if with_starmap:
        (pkg / "starmap.html").write_text("<!doctype html>", encoding="utf-8")
    return f"project://{rel}#sha256:{'a' * 64}"


def _node(node_id: str, *, ref: str | None, value: float | None) -> dict:
    posterior: dict | None
    if value is None and ref is None:
        posterior = None
    else:
        posterior = {"value": value, "evidence_count": 3, "status": "current"}
        if ref is not None:
            posterior["gaia_package_ref"] = ref
    return {
        "node_id": node_id,
        "idea_card": {"thesis_statement": f"Thesis for {node_id}."},
        "lifecycle_state": "admission_review",
        "literature_coverage": {"status": "saturated"},
        "posterior": posterior,
    }


def _run(tmp_path: Path, nodes_payload: object, top: int = 2) -> tuple[str, dict, int]:
    nodes_path = tmp_path / "nodes_latest.json"
    nodes_path.write_text(json.dumps(nodes_payload), encoding="utf-8")
    out_md = tmp_path / "reports" / "portfolio_status.md"
    out_json = tmp_path / "reports" / "portfolio_status.json"
    code = report.main(
        [
            "--nodes", str(nodes_path),
            "--project-root", str(tmp_path),
            "--out-md", str(out_md),
            "--out-json", str(out_json),
            "--top", str(top),
        ]
    )
    return out_md.read_text(encoding="utf-8"), json.loads(out_json.read_text(encoding="utf-8")), code


def test_report_renders_drivers_links_and_rounding(tmp_path: Path) -> None:
    ref = _write_package(tmp_path, "ideas/graphs/idea-one", worth_value=0.6417)
    md, payload, code = _run(tmp_path, {"nd000001": _node("nd000001", ref=ref, value=0.6417)})
    assert code == 0

    # Table row: 3-decimal display, relative graph link, machine ref as code span only.
    assert "| `nd000001` | admission_review | saturated | 0.642 |" in md
    assert "[graph](../ideas/graphs/idea-one/starmap.html)" in md
    assert f"Machine ref: `{ref}`" in md
    assert f"[{ref}]" not in md  # machine refs are never clickable links

    # Both driver directions surface with sign, conclusion title, and reasoning.
    assert "+0.81 → criterion_a: Substantial: the check directly supports criterion_a." in md
    assert "-0.81 → evidence_b: Substantial lowering: a close prior already covers this." in md

    # Exact machine value survives in JSON while the md shows 3 decimals.
    row = payload["rows"][0]
    assert row["posterior_value"] == 0.6417
    assert row["graph_root_belief"] == 0.6417
    assert row["store_graph_mismatch"] is False
    assert payload["warnings"] == []


def test_store_graph_mismatch_flagged_as_stale(tmp_path: Path) -> None:
    ref = _write_package(tmp_path, "ideas/graphs/idea-two", worth_value=0.401)
    md, payload, _ = _run(tmp_path, {"nd000002": _node("nd000002", ref=ref, value=0.868)})
    row = payload["rows"][0]
    assert row["store_graph_mismatch"] is True
    assert "⚠ stale?" in md
    assert "store/graph mismatch — re-extract before allocation" in md
    assert any("historical evidence" in w for w in payload["warnings"])


def test_nodes_without_package_or_posterior_render_placeholders(tmp_path: Path) -> None:
    md, payload, code = _run(tmp_path, {"nd000003": _node("nd000003", ref=None, value=None)})
    assert code == 0
    assert "| `nd000003` | admission_review | saturated | — | — |" in md
    assert payload["rows"][0]["support_drivers"] == []


def test_wrapper_shapes_accepted(tmp_path: Path) -> None:
    ref = _write_package(tmp_path, "ideas/graphs/idea-four", worth_value=0.5)
    wrapped = {"campaign_id": "cmpn0001", "nodes": [_node("nd000004", ref=ref, value=0.5)]}
    md, payload, code = _run(tmp_path, wrapped)
    assert code == 0
    assert "`nd000004`" in md
    assert len(payload["rows"]) == 1


def test_unresolvable_ref_warns_but_still_reports(tmp_path: Path) -> None:
    ghost = f"project://ideas/graphs/missing#sha256:{'b' * 64}"
    md, payload, code = _run(tmp_path, {"nd000005": _node("nd000005", ref=ghost, value=0.3)})
    assert code == 0
    assert "| `nd000005` |" in md
    assert any("does not resolve" in w for w in payload["warnings"])


def test_percent_encoded_ref_resolves(tmp_path: Path) -> None:
    """The extractor percent-encodes ref paths; the canonical encoded form must resolve."""
    _write_package(tmp_path, "ideas/graphs/idea one", worth_value=0.5)
    encoded = f"project://ideas/graphs/idea%20one#sha256:{'c' * 64}"
    md, payload, code = _run(tmp_path, {"nd000006": _node("nd000006", ref=encoded, value=0.5)})
    assert code == 0
    assert payload["warnings"] == []
    assert "+0.81 →" in md  # drivers were read, so the package resolved


def test_root_escaping_ref_is_refused(tmp_path: Path) -> None:
    """'..' segments must never resolve outside the project root (writeback grammar)."""
    outside = tmp_path.parent / "outside-pkg"
    (outside / ".gaia").mkdir(parents=True, exist_ok=True)
    escape = f"project://../{outside.name}#sha256:{'d' * 64}"
    _, payload, code = _run(tmp_path, {"nd000007": _node("nd000007", ref=escape, value=0.5)})
    assert code == 0
    assert payload["rows"][0]["package_dir"] is None
    assert any("does not resolve" in w for w in payload["warnings"])
