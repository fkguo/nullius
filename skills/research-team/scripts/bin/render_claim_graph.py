#!/usr/bin/env python3
"""
Render Claim DAG to Graphviz DOT + optional PNG/SVG.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import find_config_path, load_team_config  # type: ignore


def _iter_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _project_root(notes: Path) -> Path:
    cfg_path = find_config_path(notes)
    if cfg_path is not None and cfg_path.is_file():
        return cfg_path.parent.resolve()
    return notes.parent.resolve()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate project root).")
    ap.add_argument("--out", type=Path, default=None, help="DOT output path.")
    ap.add_argument("--png", type=Path, default=None, help="PNG output path (optional).")
    ap.add_argument("--svg", type=Path, default=None, help="SVG output path (optional).")
    ap.add_argument("--max-label", type=int, default=80, help="Max label length (0 disables truncation).")
    ap.add_argument("--wrap-width", type=int, default=34, help="Wrap node labels at this width (0 disables wrapping).")
    ap.add_argument("--no-color", action="store_true", help="Disable node/edge color styling.")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    cg_cfg = cfg.data.get("claim_graph", {})
    if not isinstance(cg_cfg, dict):
        print("[warn] claim_graph must be a dict; using defaults", file=sys.stderr)
        cg_cfg = {}
    base_dir = cg_cfg.get("base_dir", "knowledge_graph")
    root = _project_root(args.notes)
    kg = root / str(base_dir)

    render_cfg = cfg.data.get("claim_graph_render", {})
    if not isinstance(render_cfg, dict):
        print("[warn] claim_graph_render must be a dict; using defaults", file=sys.stderr)
        render_cfg = {}

    def _cfg_int(key: str, default: int, *, min_value: int) -> int:
        raw = render_cfg.get(key, None)
        if raw is None:
            return int(default)
        try:
            val = int(raw)
        except Exception:
            print(f"[warn] claim_graph_render.{key} must be an int; got {raw!r}; using {default}", file=sys.stderr)
            return int(default)
        if val < min_value:
            print(
                f"[warn] claim_graph_render.{key} must be >= {min_value}; got {val}; using {min_value}",
                file=sys.stderr,
            )
            return int(min_value)
        return val

    max_label = _cfg_int("max_label", int(args.max_label), min_value=0)
    wrap_width = _cfg_int("wrap_width", int(args.wrap_width), min_value=0)
    colorize = bool(render_cfg.get("colorize", True)) and (not args.no_color)
    workflow_forward = bool(render_cfg.get("workflow_forward", True))
    legend_mode = str(render_cfg.get("legend", "auto")).strip().lower() or "auto"
    if legend_mode not in ("auto", "embedded", "embed", "in_graph", "separate", "external", "file", "none", "off", "false", "0"):
        print(f"[warn] unknown claim_graph_render.legend '{legend_mode}'; defaulting to auto", file=sys.stderr)
        legend_mode = "auto"
    legend_threshold = _cfg_int("legend_threshold", 30, min_value=1)

    if wrap_width > 0 and 0 < max_label < wrap_width:
        print(
            f"[warn] claim_graph_render.max_label ({max_label}) < wrap_width ({wrap_width}); labels may truncate before wrapping",
            file=sys.stderr,
        )
    explicit_format = args.png is not None or args.svg is not None
    if not explicit_format:
        enabled = bool(render_cfg.get("enabled", False))
        if not enabled:
            print("[skip] claim graph render disabled in config")
            return 0
        fmt = str(render_cfg.get("format", "png")).strip().lower() or "png"
        if fmt not in ("png", "svg", "both", "dot"):
            print(f"[warn] unknown claim_graph_render.format '{fmt}'; defaulting to png", file=sys.stderr)
            fmt = "png"
        if fmt == "png":
            args.png = kg / "claim_graph.png"
        elif fmt == "svg":
            args.svg = kg / "claim_graph.svg"
        elif fmt == "both":
            args.png = kg / "claim_graph.png"
            args.svg = kg / "claim_graph.svg"
        elif fmt == "dot":
            pass
        else:
            args.png = kg / "claim_graph.png"

    claims = _iter_jsonl(kg / "claims.jsonl")
    edges = _iter_jsonl(kg / "edges.jsonl")

    out = args.out or (kg / "claim_graph.dot")
    png = args.png
    svg = args.svg

    def _dot_escape(text: str) -> str:
        # Use JSON escaping for quotes/backslashes/newlines, but keep Unicode readable.
        return json.dumps(text or "", ensure_ascii=False)[1:-1]

    def _normalize_ws(text: str) -> str:
        return re.sub(r"\s+", " ", (text or "").strip())

    def _truncate(text: str, max_chars: int) -> str:
        if max_chars <= 0:
            return text
        if len(text) <= max_chars:
            return text
        if max_chars <= 3:
            return text[:max_chars]
        return text[: max_chars - 3] + "..."

    def _wrap(text: str) -> str:
        if wrap_width <= 0:
            return text
        # Avoid breaking long tokens (IDs, file paths, LaTeX-ish chunks) mid-string.
        lines = textwrap.wrap(text, width=wrap_width, break_long_words=False, break_on_hyphens=False)
        return "\n".join(lines) if lines else text

    def _node_label(cid: str, stmt: str) -> str:
        s = _normalize_ws(stmt)
        s = _truncate(s, max_label)
        s = _wrap(s)
        return f"{cid}\n{s}" if s else cid

    status_fill = {
        "verified": "#e8f5e9",
        "verified_with_dissent": "#fff8e1",
        "active": "#e3f2fd",
        "under_review": "#eeeeee",
        "draft": "#f5f5f5",
        "paused": "#f5f5f5",
        "stalled": "#f5f5f5",
        "archived": "#f5f5f5",
        "superseded": "#eceff1",
        "refuted": "#ffebee",
        "disputed": "#fce4ec",
    }
    status_border = {
        "verified": "#2e7d32",
        "verified_with_dissent": "#ff8f00",
        "active": "#1565c0",
        "refuted": "#c62828",
        "disputed": "#ad1457",
        "superseded": "#546e7a",
    }

    lines = [
        "digraph ClaimDAG {",
        "  rankdir=LR;",
        '  graph [fontsize=10, fontname="Helvetica", bgcolor="white"];',
        '  node [shape=box, style="rounded,filled", fontsize=10, fontname="Helvetica", color="#444444", fillcolor="#ffffff"];',
        '  edge [fontsize=9, fontname="Helvetica", color="#555555", fontcolor="#333333"];',
    ]

    def _status_display_name(st: str) -> str:
        s = (st or "").strip()
        if not s:
            return "unknown"
        return s

    def _node_accessibility_style(status: str) -> dict[str, str]:
        """
        Non-color encodings (for grayscale/print accessibility):
        - verified: double border
        - verified_with_dissent: double border + dashed
        - refuted: octagon + thick border
        - disputed: diamond + thick border
        - draft: dashed
        - under_review: dotted
        - superseded/archived/paused/stalled: dotted (and grey-ish text)
        """
        st = (status or "").strip().lower()
        shape = "box"
        peripheries = "1"
        penwidth = "1.2"
        extra_style: list[str] = []
        fontcolor: str | None = None

        if st == "verified":
            peripheries = "2"
        elif st == "verified_with_dissent":
            peripheries = "2"
            extra_style.append("dashed")
        elif st == "active":
            # Make "active" distinct from unknown/default in grayscale.
            penwidth = "1.6"
        elif st == "under_review":
            extra_style.append("dotted")
        elif st == "draft":
            extra_style.append("dashed")
        elif st in ("superseded", "archived", "paused", "stalled"):
            extra_style.append("dotted")
            fontcolor = "#555555"
        elif st == "refuted":
            shape = "octagon"
            penwidth = "2.2"
        elif st == "disputed":
            shape = "diamond"
            penwidth = "2.0"
            extra_style.append("dashed")

        # Preserve base style components.
        style_parts = ["rounded", "filled"] + extra_style
        out: dict[str, str] = {
            "shape": shape,
            "peripheries": peripheries,
            "penwidth": penwidth,
            "style": ",".join(style_parts),
        }
        if fontcolor is not None:
            out["fontcolor"] = fontcolor
        return out

    for c in claims:
        cid = c.get("id")
        stmt = c.get("statement", "")
        if not isinstance(cid, str) or not cid.strip():
            continue
        cid_s = cid.strip()
        label_txt = _node_label(cid_s, stmt if isinstance(stmt, str) else "")
        attrs = [f'label="{_dot_escape(label_txt)}"']
        st = str(c.get("status", "")).strip()
        a11y = _node_accessibility_style(st)
        attrs.append(f'shape="{a11y["shape"]}"')
        attrs.append(f'peripheries="{a11y["peripheries"]}"')
        attrs.append(f'penwidth="{a11y["penwidth"]}"')
        attrs.append(f'style="{a11y["style"]}"')
        if "fontcolor" in a11y:
            attrs.append(f'fontcolor="{a11y["fontcolor"]}"')
        if colorize:
            attrs.append(f'fillcolor="{status_fill.get(st, "#ffffff")}"')
            attrs.append(f'color="{status_border.get(st, "#444444")}"')
        # Escape IDs even though we quote them, to avoid invalid DOT if an ID contains quotes/backslashes.
        lines.append(f'  "{_dot_escape(cid_s)}" [{", ".join(attrs)}];')

    def _edge_style(etype: str) -> tuple[str, str, str]:
        # label, color, style
        if etype == "requires":
            return ("enables" if workflow_forward else "requires", "#555555", "solid")
        if etype == "supports":
            return ("supports", "#2e7d32", "solid")
        if etype == "contradicts":
            return ("contradicts", "#c62828", "dashed")
        if etype == "competitor":
            return ("competitor", "#ef6c00", "dashed")
        if etype == "fork":
            return ("fork", "#1565c0", "dotted")
        if etype == "supersedes":
            return ("superseded by" if workflow_forward else "supersedes", "#546e7a", "solid")
        return (etype or "edge", "#555555", "solid")

    def _should_embed_legend(n_nodes: int) -> bool:
        if legend_mode in ("none", "off", "false", "0"):
            return False
        if legend_mode in ("embedded", "embed", "in_graph"):
            return True
        if legend_mode in ("separate", "external", "file"):
            return False
        # auto
        return n_nodes <= legend_threshold

    def _legend_lines() -> list[str]:
        # Only include statuses/edge types that appear, to keep legend compact.
        present_statuses = {str(c.get("status", "")).strip().lower() for c in claims if str(c.get("status", "")).strip()}
        present_edges = {str(e.get("type", "")).strip() for e in edges if str(e.get("type", "")).strip()}

        key_status_order = [
            "verified",
            "verified_with_dissent",
            "active",
            "under_review",
            "draft",
            "superseded",
            "refuted",
            "disputed",
        ]
        legend_statuses = [s for s in key_status_order if s in present_statuses]
        preferred_edges = ["requires", "supports", "contradicts", "competitor", "fork", "supersedes"]
        legend_edge_types = [t for t in preferred_edges if t in present_edges]
        # Include any custom/extra edge types at the end so they remain discoverable.
        extras = sorted({t for t in present_edges if t not in set(preferred_edges)})
        legend_edge_types.extend(extras)

        if not legend_statuses and not legend_edge_types:
            return []

        out_lines: list[str] = []
        out_lines.append("  subgraph cluster_legend {")
        out_lines.append('    label="Legend";')
        out_lines.append('    fontsize=10;')
        out_lines.append('    color="#bbbbbb";')
        out_lines.append('    style="rounded";')

        if legend_statuses:
            out_lines.append("    // Node status styles")
            prev = None
            for s in legend_statuses:
                node_id = f"__LEG_NODE_{s}"
                a11y = _node_accessibility_style(s)
                attrs = [
                    f'label="{_dot_escape(_status_display_name(s))}"',
                    f'shape="{a11y["shape"]}"',
                    f'peripheries="{a11y["peripheries"]}"',
                    f'penwidth="{a11y["penwidth"]}"',
                    f'style="{a11y["style"]}"',
                ]
                if "fontcolor" in a11y:
                    attrs.append(f'fontcolor="{a11y["fontcolor"]}"')
                if colorize:
                    attrs.append(f'fillcolor="{status_fill.get(s, "#ffffff")}"')
                    attrs.append(f'color="{status_border.get(s, "#444444")}"')
                out_lines.append(f'    "{node_id}" [{", ".join(attrs)}];')
                if prev is not None:
                    out_lines.append(f'    "{prev}" -> "{node_id}" [style=invis];')
                prev = node_id

        if legend_edge_types:
            out_lines.append("    // Edge type styles")
            prev = None
            for idx, t in enumerate(legend_edge_types, start=1):
                a = f"__LEG_EDGE_{idx}_a"
                b = f"__LEG_EDGE_{idx}_b"
                out_lines.append(f'    "{a}" [label="", shape=point, width=0.1];')
                out_lines.append(f'    "{b}" [label="", shape=point, width=0.1];')
                label_txt, edge_color, edge_style = _edge_style(t)
                attrs = [f'label="{_dot_escape(label_txt)}"']
                if colorize:
                    attrs.append(f'color="{edge_color}"')
                    attrs.append(f'fontcolor="{edge_color}"')
                    attrs.append(f'style="{edge_style}"')
                else:
                    # Preserve non-color encoding via line styles.
                    attrs.append(f'style="{edge_style}"')
                out_lines.append(f'    "{a}" -> "{b}" [{", ".join(attrs)}];')
                if prev is not None:
                    out_lines.append(f'    "{prev}" -> "{a}" [style=invis];')
                prev = b

        out_lines.append("  }")
        return out_lines

    for e in edges:
        # Schema uses "source"/"target" (aligned with check_claim_graph.py).
        src = e.get("source")
        dst = e.get("target")
        etype = str(e.get("type", "")).strip()
        if not (isinstance(src, str) and isinstance(dst, str)):
            continue
        src_s = src.strip()
        dst_s = dst.strip()
        # Render workflow-forward for dependency-like edges unless disabled.
        if workflow_forward and etype in ("requires", "supersedes"):
            a, b = dst_s, src_s
        else:
            a, b = src_s, dst_s

        label_txt, edge_color, edge_style = _edge_style(etype)
        attrs = [f'label="{_dot_escape(label_txt)}"']
        # Always encode type-specific edge style (dashed/dotted), even when color is disabled.
        attrs.append(f'style="{edge_style}"')
        if colorize:
            attrs.append(f'color="{edge_color}"')
            attrs.append(f'fontcolor="{edge_color}"')
        lines.append(f'  "{_dot_escape(a)}" -> "{_dot_escape(b)}" [{", ".join(attrs)}];')

    # Legend: embed for small graphs; write separate file for larger ones (auto).
    embed_legend = _should_embed_legend(len([c for c in claims if isinstance(c.get("id"), str) and str(c.get("id")).strip()]))
    if embed_legend:
        lines.extend(_legend_lines())

    lines.append("}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[ok] wrote DOT: {out}")

    def _run_dot(fmt: str, src: Path, dst: Path) -> None:
        if not shutil.which("dot"):
            print("[warn] graphviz 'dot' not found; skipping render", file=sys.stderr)
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["dot", f"-T{fmt}", str(src), "-o", str(dst)], check=False)
        if dst.is_file():
            print(f"[ok] wrote {fmt.upper()}: {dst}")

    if args.png is not None:
        _run_dot("png", out, png)
    if args.svg is not None:
        _run_dot("svg", out, svg)

    # Separate legend for large graphs (or explicit mode).
    if not embed_legend and legend_mode not in ("none", "off", "false", "0"):
        legend = _legend_lines()
        if legend:
            legend_dot = out.with_name(out.stem + "_legend.dot")
            legend_lines = [
                "digraph ClaimLegend {",
                "  rankdir=TB;",
                '  graph [fontsize=10, fontname="Helvetica", bgcolor="white"];',
                '  node [shape=box, style="rounded,filled", fontsize=10, fontname="Helvetica", color="#444444", fillcolor="#ffffff"];',
                '  edge [fontsize=9, fontname="Helvetica", color="#555555", fontcolor="#333333"];',
            ]
            # Reuse the embedded cluster content (it contains a full "cluster_legend" subgraph).
            legend_lines.extend(legend)
            legend_lines.append("}")
            legend_dot.write_text("\n".join(legend_lines) + "\n", encoding="utf-8")
            print(f"[ok] wrote DOT: {legend_dot}")
            if png is not None:
                legend_png = png.with_name(png.stem + "_legend" + png.suffix)
                _run_dot("png", legend_dot, legend_png)
            if svg is not None:
                legend_svg = svg.with_name(svg.stem + "_legend" + svg.suffix)
                _run_dot("svg", legend_dot, legend_svg)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
