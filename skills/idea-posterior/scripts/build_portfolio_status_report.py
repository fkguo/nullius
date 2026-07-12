#!/usr/bin/env python3
"""Build a portfolio status report across a campaign's idea nodes.

One table row per node — lifecycle state, literature coverage, store
posterior — plus, for every node with a compiled argument-graph package, the
top support and top lowering drivers extracted from the graph itself
(strategy conditional probabilities + the author's recorded reasoning). This
is the report layer a reader uses to decide where to invest next; per-idea
graph views stay what they are: topology and audit surfaces.

Inputs are engine-shaped only:

- ``--nodes``: the campaign's ``nodes_latest.json`` — either the engine's
  native top-level ``{node_id: node}`` map or an explicit
  ``{"campaign_id": ..., "nodes": [...]}`` wrapper (list or map), the same
  two shapes the allocation reader accepts.
- ``--project-root``: absolute project root used to resolve
  ``project://<relative>#sha256:<hex>`` package refs.

Report conventions:

- Human-facing posterior values are rounded to three decimals; exact machine
  values go to the JSON artifact only.
- Human-readable files (the graph page) are rendered as relative links;
  machine refs (``project://...#sha256``) stay in code spans, never links.
- When the store posterior and the graph's current root belief disagree, the
  row is flagged: the stored value predates the current graph and is
  historical evidence, not allocation guidance, until written back again.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from idea_package_contract import (
    audit_evidence_families,
    compiled_ir_pin,
    load_compiled_ir,
    reader_rationale_text,
    require_authored_infer_rationales,
    require_idea_specific_reasoning_claims,
    require_unique_exported_root,
)

# Store posterior vs graph root belief agreement tolerance. Writeback copies
# the exact extracted value, so any real divergence means a re-run happened
# (or never landed); the epsilon only absorbs float round-trips.
MISMATCH_TOLERANCE = 1e-9

# Truncation for one driver's reasoning text in the report body.
REASON_MAX_CHARS = 240

PROJECT_REF_PREFIX = "project://"
PACKAGE_PIN_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def load_nodes(path: Path) -> list[dict[str, Any]]:
    """Read nodes from the engine's native map or the explicit wrapper shape."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"nodes file must hold a JSON object, got {type(raw).__name__}")
    container: Any = raw.get("nodes") if "nodes" in raw else raw
    nodes: list[dict[str, Any]] = []
    if isinstance(container, list):
        entries = list(enumerate(container))
    elif isinstance(container, dict):
        entries = sorted(container.items())  # type: ignore[assignment]
    else:
        raise ValueError("nodes container must be a list or an object")
    for key, entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"nodes[{key!r}] must be an object, got {type(entry).__name__}")
        node = dict(entry)
        if isinstance(key, str) and not node.get("node_id"):
            node["node_id"] = key
        nodes.append(node)
    return nodes


def package_dir_from_ref(ref: Any, project_root: Path) -> Path | None:
    """Resolve a ``project://<relative>#sha256:<hex>`` ref to a package directory.

    Mirrors the writeback validator's ref grammar (``split_package_ref`` in
    ``posterior_writeback.py``): the path part is percent-decoded — the
    extractor deliberately percent-encodes, so an encoded ref is the canonical
    form — and empty / ``.`` / ``..`` segments are refused so the reference
    can never name a directory outside the project root it is resolved
    against.
    """
    if not isinstance(ref, str) or not ref.startswith(PROJECT_REF_PREFIX):
        return None
    parts = ref[len(PROJECT_REF_PREFIX):].split("#", 1)
    if len(parts) != 2 or PACKAGE_PIN_RE.fullmatch(parts[1]) is None:
        return None
    encoded = parts[0]
    if not encoded:
        return None
    relative = unquote(encoded)
    if any(segment in ("", ".", "..") for segment in relative.split("/")):
        return None
    root = project_root.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_dir() else None


def package_pin_from_ref(ref: str) -> str:
    """Return the already grammar-checked exact-IR pin from a package ref."""
    return ref.rsplit("#", 1)[1]


def contained_package_file(package_dir: Path, project_root: Path, relative: str) -> Path:
    """Resolve one package input without following a symlink out of scope."""
    resolved = (package_dir / relative).resolve(strict=True)
    resolved.relative_to(project_root.resolve(strict=True))
    resolved.relative_to(package_dir.resolve(strict=True))
    if not resolved.is_file():
        raise ValueError(f"package input is not a file: {relative}")
    return resolved


def strategy_effect(strategy: dict[str, Any]) -> float | None:
    """Signed raise/lower effect of a strategy on its conclusion, in [-1, 1].

    For strategies carrying an inline conditional-probability table, the last
    two entries are P(conclusion | ..., premise absent/present); their
    difference is positive when the premise raises belief in the conclusion
    and negative when it lowers it. Strategy forms without such a table are
    left unscored rather than guessed.
    """
    premises = strategy.get("premises")
    cp = strategy.get("conditional_probabilities")
    if not isinstance(premises, list) or len(premises) != 1:
        return None
    if not isinstance(cp, list) or len(cp) != 2:
        return None
    try:
        return float(cp[1]) - float(cp[0])
    except (TypeError, ValueError):
        return None


def strategy_reason(strategy: dict[str, Any]) -> str:
    """The author's recorded reasoning: steps[].reasoning, else metadata.reason."""
    parts: list[str] = []
    for step in strategy.get("steps") or []:
        if isinstance(step, dict):
            reasoning = step.get("reasoning")
            if isinstance(reasoning, str) and reasoning.strip():
                parts.append(reasoning.strip())
    if parts:
        return reader_rationale_text(" ".join(parts))
    metadata = strategy.get("metadata") or {}
    reason = metadata.get("reason") if isinstance(metadata, dict) else None
    return reason.strip() if isinstance(reason, str) else ""


def _knowledge_titles(ir: dict[str, Any]) -> dict[str, str]:
    titles: dict[str, str] = {}
    for k in ir.get("knowledges", []):
        kid = k.get("id")
        if isinstance(kid, str):
            title = k.get("title") or k.get("label") or kid
            titles[kid] = str(title)
    return titles


def graph_drivers(ir: dict[str, Any], *, top: int) -> dict[str, list[dict[str, Any]]]:
    """Rank scored strategies into top support / top lowering drivers."""
    titles = _knowledge_titles(ir)
    scored: list[dict[str, Any]] = []
    for strategy in ir.get("strategies", []):
        if not isinstance(strategy, dict):
            continue
        effect = strategy_effect(strategy)
        conclusion = strategy.get("conclusion")
        if effect is None or not isinstance(conclusion, str):
            continue
        scored.append(
            {
                "effect": effect,
                "conclusion": titles.get(conclusion, conclusion),
                "reason": strategy_reason(strategy),
            }
        )
    support = sorted((s for s in scored if s["effect"] > 0), key=lambda s: -s["effect"])
    lowering = sorted((s for s in scored if s["effect"] < 0), key=lambda s: s["effect"])
    return {"support": support[:top], "lowering": lowering[:top]}


def worth_belief(beliefs: dict[str, Any], worth_label: str) -> float | None:
    """The graph's current root belief: the entry labelled ``worth_label``."""
    for entry in beliefs.get("beliefs", []):
        if isinstance(entry, dict) and entry.get("label") == worth_label:
            value = entry.get("belief")
            if isinstance(value, (int, float)):
                return float(value)
    return None


def _thesis(node: dict[str, Any]) -> str:
    card = node.get("idea_card")
    if isinstance(card, dict):
        thesis = card.get("thesis_statement")
        if isinstance(thesis, str) and thesis.strip():
            return thesis.strip()
    return ""


def _posterior_fields(node: dict[str, Any]) -> tuple[float | None, str, int | None]:
    posterior = node.get("posterior")
    if not isinstance(posterior, dict):
        return None, "", None
    value = posterior.get("value")
    status = posterior.get("status")
    count = posterior.get("evidence_count")
    return (
        float(value) if isinstance(value, (int, float)) else None,
        str(status) if isinstance(status, str) else "",
        int(count) if isinstance(count, int) else None,
    )


def _coverage_status(node: dict[str, Any]) -> str:
    coverage = node.get("literature_coverage")
    if isinstance(coverage, dict) and isinstance(coverage.get("status"), str):
        return str(coverage["status"])
    return ""


def collect_row(
    node: dict[str, Any],
    *,
    project_root: Path,
    top: int,
    worth_label: str,
    warnings: list[str],
) -> dict[str, Any]:
    """Assemble one report row: store fields + graph drivers when a package resolves."""
    node_id = str(node.get("node_id", ""))
    posterior_value, posterior_status, evidence_count = _posterior_fields(node)
    posterior = node.get("posterior") if isinstance(node.get("posterior"), dict) else {}
    ref = posterior.get("gaia_package_ref") if isinstance(posterior, dict) else None

    row: dict[str, Any] = {
        "node_id": node_id,
        "thesis": _thesis(node),
        "lifecycle_state": str(node.get("lifecycle_state", "")),
        "literature_coverage_status": _coverage_status(node),
        "posterior_value": posterior_value,
        "posterior_status": posterior_status,
        "evidence_count": evidence_count,
        "package_ref": ref if isinstance(ref, str) else None,
        "package_dir": None,
        "graph_root_belief": None,
        "store_graph_mismatch": False,
        "support_drivers": [],
        "lowering_drivers": [],
    }

    package_dir = package_dir_from_ref(ref, project_root)
    if isinstance(ref, str) and package_dir is None:
        warnings.append(f"{node_id}: package ref does not resolve under the project root: {ref}")
    if package_dir is None:
        return row
    row["package_dir"] = str(package_dir)

    ir_path = package_dir / ".gaia" / "ir.json"
    beliefs_path = package_dir / ".gaia" / "beliefs.json"
    try:
        ir_path = contained_package_file(
            package_dir, project_root, ".gaia/ir.json"
        )
    except (OSError, ValueError) as exc:
        warnings.append(f"{node_id}: cannot read {ir_path}: {exc}")
        return row
    try:
        beliefs_path = contained_package_file(
            package_dir, project_root, ".gaia/beliefs.json"
        )
    except (OSError, ValueError) as exc:
        warnings.append(f"{node_id}: cannot read {beliefs_path}: {exc}")
        return row
    try:
        ir_bytes = ir_path.read_bytes()
        current_pin = compiled_ir_pin(ir_bytes)
        expected_pin = package_pin_from_ref(ref)
        if current_pin != expected_pin:
            warnings.append(
                f"{node_id}: package ref pins {expected_pin}, but the exact compiled "
                f"ir.json is {current_pin} — report drivers are withheld until the "
                "package is re-extracted and written back"
            )
            return row
        ir = load_compiled_ir(ir_bytes)
        require_unique_exported_root(ir, worth_label)
        require_idea_specific_reasoning_claims(ir)
        require_authored_infer_rationales(ir)
        audit_evidence_families(ir, worth_label)
    except (OSError, ValueError) as exc:
        warnings.append(f"{node_id}: cannot read {ir_path}: {exc}")
        return row
    drivers = graph_drivers(ir, top=top)
    row["support_drivers"] = drivers["support"]
    row["lowering_drivers"] = drivers["lowering"]

    try:
        beliefs = json.loads(beliefs_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        warnings.append(
            f"{node_id}: cannot read {beliefs_path}: {exc} — staleness check skipped"
        )
        beliefs = {}
    root_belief = worth_belief(beliefs, worth_label)
    row["graph_root_belief"] = root_belief
    if (
        root_belief is not None
        and posterior_value is not None
        and abs(root_belief - posterior_value) > MISMATCH_TOLERANCE
    ):
        row["store_graph_mismatch"] = True
        warnings.append(
            f"{node_id}: store posterior {posterior_value!r} differs from the graph's current "
            f"root belief {root_belief!r} — the stored value is historical evidence until the "
            "posterior is re-extracted and written back"
        )
    return row


def _fmt_posterior(value: float | None) -> str:
    return f"{value:.3f}" if value is not None else "—"


def _truncate(text: str, limit: int = REASON_MAX_CHARS) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _graph_link(row: dict[str, Any], out_md: Path) -> str:
    package_dir = row.get("package_dir")
    if not package_dir:
        return "—"
    page = Path(package_dir) / "argument-graph.html"
    if not page.exists():
        return "—"
    rel = os.path.relpath(page, out_md.parent)
    return f"[graph]({rel})"


def _driver_lines(row: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for kind, label in (("support_drivers", "Top support"), ("lowering_drivers", "Top lowering")):
        drivers = row[kind]
        if not drivers:
            continue
        lines.append(f"- {label}:")
        for d in drivers:
            reason = _truncate(d["reason"]) if d["reason"] else "(no recorded reasoning)"
            conclusion = " ".join(str(d["conclusion"]).split())
            lines.append(f"  - {d['effect']:+.2f} → {conclusion}: {reason}")
    return lines


def render_markdown(rows: list[dict[str, Any]], *, nodes_path: Path, out_md: Path) -> str:
    lines: list[str] = []
    lines.append("# Portfolio Status Report")
    lines.append("")
    lines.append(f"Nodes source: `{nodes_path}` ({len(rows)} nodes)")
    lines.append("")
    lines.append("Store posteriors are shown to three decimals; exact values live in the JSON")
    lines.append("artifact. A mismatch flag means the graph moved after the last writeback: the")
    lines.append("stored value is historical evidence, not current allocation guidance.")
    lines.append("")
    lines.append("| node | state | coverage | posterior | graph |")
    lines.append("| --- | --- | --- | --- | --- |")
    for row in rows:
        posterior = _fmt_posterior(row["posterior_value"])
        if row["store_graph_mismatch"]:
            posterior += " ⚠ stale?"
        lines.append(
            f"| `{row['node_id']}` | {row['lifecycle_state'] or '—'} "
            f"| {row['literature_coverage_status'] or '—'} "
            f"| {posterior} | {_graph_link(row, out_md)} |"
        )
    for row in rows:
        detail = _driver_lines(row)
        if not detail and not row["thesis"]:
            continue
        lines.append("")
        lines.append(f"## `{row['node_id']}`")
        lines.append("")
        if row["thesis"]:
            lines.append(_truncate(row["thesis"]))
            lines.append("")
        status_bits = [f"posterior {_fmt_posterior(row['posterior_value'])}"]
        if row["posterior_status"]:
            status_bits.append(f"status {row['posterior_status']}")
        if row["graph_root_belief"] is not None:
            status_bits.append(f"graph root belief {row['graph_root_belief']:.3f}")
        if row["store_graph_mismatch"]:
            status_bits.append("store/graph mismatch — re-extract before allocation")
        lines.append("- " + "; ".join(status_bits))
        lines.extend(detail)
        if row["package_ref"]:
            lines.append(f"- Machine ref: `{row['package_ref']}`")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--nodes", required=True, type=Path, help="campaign nodes_latest.json")
    parser.add_argument(
        "--project-root", required=True, type=Path,
        help="absolute project root used to resolve project:// package refs",
    )
    parser.add_argument("--out-md", required=True, type=Path, help="markdown report path")
    parser.add_argument("--out-json", type=Path, default=None, help="machine-value JSON path")
    parser.add_argument("--top", type=int, default=2, help="drivers per direction (default 2)")
    parser.add_argument(
        "--worth-label", default="worth",
        help="root-claim label whose belief is the graph posterior (default: worth)",
    )
    args = parser.parse_args(argv)

    project_root = args.project_root.expanduser().resolve()
    if not project_root.is_dir():
        print(f"error: --project-root is not a directory: {project_root}", file=sys.stderr)
        return 2
    try:
        nodes = load_nodes(args.nodes)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: cannot load nodes: {exc}", file=sys.stderr)
        return 2

    warnings: list[str] = []
    rows = [
        collect_row(
            node,
            project_root=project_root,
            top=max(1, args.top),
            worth_label=args.worth_label,
            warnings=warnings,
        )
        for node in nodes
    ]

    out_md = args.out_md.expanduser().resolve()
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(render_markdown(rows, nodes_path=args.nodes, out_md=out_md), encoding="utf-8")
    if args.out_json is not None:
        out_json = args.out_json.expanduser().resolve()
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(
            json.dumps(
                {"nodes_source": str(args.nodes), "rows": rows, "warnings": warnings},
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    print(f"wrote {out_md} ({len(rows)} nodes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
