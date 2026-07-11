#!/usr/bin/env python3
"""Render a Gaia argument-graph package as one self-contained HTML page.

Reads the compiled IR (``.gaia/ir.json``) and the inference output
(``.gaia/beliefs.json``) that ``run_infer_and_extract.py`` leaves behind, and
writes a single HTML file with no external dependencies.

Display contract (the reason this renderer exists — see SKILL.md):

- Every node card shows the node's actual statement in full. Short variable
  labels ("worth", "ev_anchor") appear only as small card headers, never as
  the node's whole content.
- Relations are drawn as edges, not as labelled boxes: each ``infer`` becomes
  one arrow from the evidence statement to the hypothesis it updates. The
  direction of effect is encoded in color and line style (raises belief =
  solid blue, lowers belief = dashed warm red), the strength in line width
  plus a grade chip (weak / substantial / strong, with the likelihood ratio).
- Claim cards carry the posterior belief (number and bar); observed evidence
  cards are marked as recorded observations instead.
- Clicking a card opens a detail panel with the full statement, the
  observation note, and every incoming/outgoing update with its likelihoods
  P(e|h) and P(e|not h), the authored rationale, and the source anchors.

The IR stores ``infer`` in the generative direction (hypothesis -> evidence,
``conditional_probabilities = [P(e|not h), P(e|h)]``). For display that arrow
is inverted so readers follow evidence into the claim it updates. Non-infer
strategies (derive, compose, ...) keep their forward direction and are drawn
through a small junction ellipse labelled with the strategy type.

Layout is computed here, deterministically, so the page needs no layout
library: columns run observed evidence -> intermediate claims -> root claim,
with a small crossing-reduction sweep. Same package state -> byte-identical
page. Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import sys
import textwrap
from pathlib import Path

# Helper-label prefixes mirror gaia.engine.ir.coarsen.HELPER_LABEL_PREFIXES
# exactly: compiler-minted warrants/actions that no reader authored. They are
# hidden unless a strategy actually wires them as a premise or conclusion.
HELPER_LABEL_PREFIXES = ("__", "_anon")

# Card geometry (px). Statement wrapping below is sized to NODE_W.
NODE_W = 300
PAD_X = 14
HEADER_H = 34  # top padding + header row, before statement lines start
LINE_H = 17
FOOTER_CLAIM = 30  # belief bar row
FOOTER_PLAIN = 26  # "recorded observation" note row
WRAP_CHARS = 38
COL_GAP = 200
ROW_GAP = 26
MARGIN = 42

# Grade anchors on the Jeffreys-style scale used by the skill:
# weak LR 3, substantial LR 10, strong LR 30 (log10: .477 / 1.0 / 1.477).
GRADE_ANCHORS = (("weak", 0.4771), ("substantial", 1.0), ("strong", 1.4771))


def fail(message: str) -> "SystemExit":
    sys.stderr.write(f"error: {message}\n")
    return SystemExit(2)


def load_json(path: Path, what: str) -> dict:
    if not path.is_file():
        raise fail(
            f"missing {what}: {path}\n"
            "Compile and infer the package first (run_infer_and_extract.py "
            "does both before it renders)."
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise fail(f"unreadable {what} at {path}: {exc}")


def detailed_reasoning_matches_beliefs(package_dir: Path) -> bool:
    """Whether docs/detailed-reasoning.md was rendered from the CURRENT
    beliefs, per the companion checksum the pipeline writes after a
    successful docs render (sha256 of .gaia/beliefs.json at that moment).

    Existence alone does not establish freshness: after a failed render
    whose cleanup also failed, last generation's document can survive on
    disk, and a graph carrying this generation's posteriors must not send
    readers into the other generation's reasoning. Missing document,
    missing companion, unreadable bytes, or a hash mismatch all mean "do
    not link" -- the safe side. Hand-polishing the document does NOT drop
    the link: the binding is to the beliefs generation it was rendered
    from, not to the document's own bytes.
    """
    doc_file = package_dir / "docs" / "detailed-reasoning.md"
    stamp_file = package_dir / "docs" / "detailed-reasoning.beliefs-sha256"
    beliefs_file = package_dir / ".gaia" / "beliefs.json"
    try:
        if not doc_file.is_file() or not stamp_file.is_file():
            return False
        recorded = stamp_file.read_text(encoding="utf-8").strip()
        current = "sha256:" + hashlib.sha256(beliefs_file.read_bytes()).hexdigest()
        return recorded == current
    except OSError:
        return False


def local_name(knowledge_id: str) -> str:
    return knowledge_id.rsplit("::", 1)[-1]


def is_helper(knowledge: dict) -> bool:
    name = knowledge.get("label") or local_name(knowledge.get("id", ""))
    return name.startswith(HELPER_LABEL_PREFIXES)


def pretty(label: str) -> str:
    text = label.replace("_", " ").strip()
    return text or "(unnamed)"


def split_anchors(rationale: str) -> tuple[str, list[str]]:
    """Split an authored rationale into prose and its 'anchor:' references."""
    marker = rationale.find("anchor:")
    if marker == -1:
        return rationale.strip(), []
    prose = rationale[:marker].strip()
    refs = [a.strip() for a in rationale[marker + len("anchor:") :].split(";")]
    return prose, [a for a in refs if a]


def classify_anchor(anchor: str) -> dict:
    """Decide whether a source anchor is safe to render as a link.

    Whitelist, not blacklist: only two shapes ever get an href --
    absolute http(s) URLs, and relative Markdown paths (reader-facing
    documents that travel with the package). Everything else -- JSON
    artifacts, engine references like artifact:// ids, absolute
    filesystem paths -- stays machine-readable plain text, and any
    other URI scheme (javascript:, file:, data:) can never become a
    link because it matches neither shape.
    """
    text = anchor.strip()
    lowered = text.lower()
    href = None
    if lowered.startswith(("http://", "https://")):
        href = text
    else:
        # The Markdown-only boundary applies to the PATH, not the whole
        # string: "docs/foo.md#Section" is a valid deep link, while
        # "artifacts/x.html#y.md" must not pass just because the fragment
        # happens to end in .md. Character-set whitelist, not just shape
        # checks: browsers normalize backslashes to slashes (a leading
        # "\\" or an "\\\\host\\share" UNC form would become root- or
        # protocol-relative) and strip some control characters, so only
        # plain path characters survive, with no leading slash and no
        # colon anywhere.
        pure_path, _, fragment = text.partition("#")
        if (
            pure_path.lower().endswith(".md")
            and re.fullmatch(r"[A-Za-z0-9._~/-]+", pure_path)
            and (not fragment or re.fullmatch(r"[A-Za-z0-9._~/-]+", fragment))
            and "#" not in fragment
            and not pure_path.startswith("/")
        ):
            href = text
    return {"text": text, "href": href}


def grade_for(log_lr_abs: float) -> str:
    return min(GRADE_ANCHORS, key=lambda item: abs(item[1] - log_lr_abs))[0]


def factor_text(lr: float) -> str:
    if math.isinf(lr):
        return "×∞"
    if lr <= 0.0:
        return "÷∞"
    value = lr if lr >= 1.0 else 1.0 / lr
    digits = f"{value:.2g}" if value < 100 else f"{value:.0f}"
    return ("×" if lr >= 1.0 else "÷") + digits


def wrap_statement(text: str) -> list[str]:
    # Never shortened: the card IS the statement-first promise, and the one
    # statement long enough to overflow a fixed line budget is typically a
    # scope limit -- exactly the qualification an overview must not hide.
    # Cards grow instead (size_nodes measures, place_nodes stacks by height).
    return textwrap.wrap(
        " ".join(text.split()),
        width=WRAP_CHARS,
        break_long_words=True,
        break_on_hyphens=True,
    ) or [""]


class Node:
    def __init__(self, knowledge: dict, belief: float | None) -> None:
        self.id: str = knowledge["id"]
        self.label: str = knowledge.get("label") or local_name(self.id)
        self.statement: str = knowledge.get("content", "")
        self.declaration_index: int = int(knowledge.get("declaration_index", 0))
        self.belief = belief
        metadata = knowledge.get("metadata") or {}
        observations = [
            entry
            for entry in metadata.get("supported_by", [])
            if entry.get("pattern") == "observation"
        ]
        self.observed = bool(observations)
        self.pinned_prior = metadata.get("prior")
        obs_rationale = observations[0].get("rationale", "") if observations else ""
        self.obs_prose, self.obs_anchors = split_anchors(obs_rationale)
        self.is_root = False
        self.junction = False
        # Layout slots, filled later.
        self.layer = 0
        self.column = 0
        self.order = 0
        self.x = 0.0
        self.y = 0.0
        self.lines: list[str] = []
        self.w = float(NODE_W)
        self.h = 0.0

    def role(self) -> str:
        if self.junction:
            return "junction"
        if self.is_root:
            return "root"
        if self.observed:
            return "evidence"
        return "claim"


class Junction(Node):
    """Small relay node for non-infer strategies (derive, compose, ...)."""

    def __init__(self, strategy_id: str, kind: str, order_hint: int) -> None:
        base = {
            "id": f"junction::{strategy_id}",
            "label": kind,
            "content": "",
            "declaration_index": order_hint,
        }
        super().__init__(base, belief=None)
        self.junction = True
        self.w, self.h = 84.0, 30.0


class Edge:
    def __init__(
        self,
        source: str,
        target: str,
        *,
        kind: str,
        p_h: float | None = None,
        p_nh: float | None = None,
        rationale: str = "",
        strategy_id: str = "",
    ) -> None:
        self.source = source
        self.target = target
        self.kind = kind  # "update" (infer) or "flow" (junction legs)
        self.p_h = p_h
        self.p_nh = p_nh
        self.rationale_prose, self.anchors = split_anchors(rationale)
        self.strategy_id = strategy_id
        if kind == "update" and p_h is not None and p_nh is not None:
            if p_nh <= 0.0:
                self.lr = math.inf if p_h > 0.0 else 1.0
            else:
                self.lr = p_h / p_nh
        else:
            self.lr = 1.0
        if abs(self.lr - 1.0) < 1e-9:
            self.effect = "neutral"
        else:
            self.effect = "supports" if self.lr > 1.0 else "lowers"
        log_abs = abs(math.log10(self.lr)) if 0 < self.lr != math.inf else 2.0
        self.log_lr_abs = 0.0 if self.effect == "neutral" else log_abs
        self.grade = "" if self.effect == "neutral" else grade_for(self.log_lr_abs)
        self.width = 1.4 + 1.6 * min(self.log_lr_abs, 1.7)
        # Geometry, filled later.
        self.points = (0.0, 0.0, 0.0, 0.0)
        self.chip_t = 0.62


def build_model(ir: dict, beliefs_by_id: dict[str, float]) -> tuple[dict[str, Node], list[Edge]]:
    knowledges = ir.get("knowledges", [])
    strategies = ir.get("strategies", [])

    referenced: set[str] = set()
    for strategy in strategies:
        referenced.update(strategy.get("premises", []))
        referenced.add(strategy.get("conclusion", ""))

    nodes: dict[str, Node] = {}
    for knowledge in knowledges:
        if "id" not in knowledge:
            continue
        if is_helper(knowledge) and knowledge["id"] not in referenced:
            continue
        nodes[knowledge["id"]] = Node(knowledge, beliefs_by_id.get(knowledge["id"]))

    edges: list[Edge] = []
    for index, strategy in enumerate(strategies):
        kind = strategy.get("type", "step")
        premises = [p for p in strategy.get("premises", []) if p in nodes]
        conclusion = strategy.get("conclusion", "")
        if conclusion not in nodes or not premises:
            continue
        probabilities = strategy.get("conditional_probabilities") or []
        rationale = " ".join(
            step.get("reasoning", "")
            for step in strategy.get("steps", [])
            if step.get("reasoning")
        )
        strategy_id = strategy.get("strategy_id", f"s{index}")
        if kind == "infer" and len(premises) == 1 and len(probabilities) == 2:
            # Invert the generative direction: draw evidence -> hypothesis.
            edges.append(
                Edge(
                    conclusion,
                    premises[0],
                    kind="update",
                    p_h=float(probabilities[1]),
                    p_nh=float(probabilities[0]),
                    rationale=rationale,
                    strategy_id=strategy_id,
                )
            )
            continue
        junction = Junction(
            strategy_id, kind, min(nodes[p].declaration_index for p in premises)
        )
        nodes[junction.id] = junction
        for premise in premises:
            edges.append(
                Edge(premise, junction.id, kind="flow", rationale=rationale,
                     strategy_id=strategy_id)
            )
        edges.append(
            Edge(junction.id, conclusion, kind="flow", rationale=rationale,
                 strategy_id=strategy_id)
        )
    return nodes, edges


def assign_layers(nodes: dict[str, Node], edges: list[Edge]) -> None:
    successors: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    incoming: dict[str, int] = {node_id: 0 for node_id in nodes}
    for edge in edges:
        successors[edge.source].append(edge.target)
        incoming[edge.target] += 1

    for node in nodes.values():
        node.is_root = bool(not successors[node.id] and incoming[node.id])

    order: list[str] = []
    out_degree = {node_id: len(successors[node_id]) for node_id in nodes}
    ready = sorted(node_id for node_id, degree in out_degree.items() if degree == 0)
    remaining = dict(out_degree)
    reverse: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for edge in edges:
        reverse[edge.target].append(edge.source)
    queue = list(ready)
    while queue:
        node_id = queue.pop(0)
        order.append(node_id)
        for parent in sorted(reverse[node_id]):
            remaining[parent] -= 1
            if remaining[parent] == 0:
                queue.append(parent)
    if len(order) != len(nodes):
        raise fail(
            "the display graph has a cycle; this renderer only draws acyclic "
            "argument graphs"
        )
    layer_of: dict[str, int] = {}
    for node_id in order:  # sinks first
        node_successors = successors[node_id]
        layer_of[node_id] = (
            0
            if not node_successors
            else 1 + max(layer_of[s] for s in node_successors)
        )
    max_layer = max(layer_of.values(), default=0)
    for node_id, node in nodes.items():
        node.layer = layer_of[node_id]
        # Observed source nodes all share the leftmost column, so every piece
        # of entered evidence lines up regardless of how deep its target sits.
        if node.observed and incoming[node_id] == 0 and max_layer > 0:
            node.layer = max_layer
        node.column = max_layer - node.layer


def order_columns(nodes: dict[str, Node], edges: list[Edge]) -> list[list[Node]]:
    max_column = max((node.column for node in nodes.values()), default=0)
    columns: list[list[Node]] = [[] for _ in range(max_column + 1)]
    for node in nodes.values():
        columns[node.column].append(node)
    for column in columns:
        column.sort(key=lambda node: (node.declaration_index, node.id))
        for index, node in enumerate(column):
            node.order = index

    into: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    out_of: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for edge in edges:
        into[edge.target].append(edge.source)
        out_of[edge.source].append(edge.target)

    def sweep(neighbour_map: dict[str, list[str]], columns_in_order: list[list[Node]]) -> None:
        for column in columns_in_order:
            keyed = []
            for node in column:
                neighbours = [nodes[n].order for n in neighbour_map[node.id]]
                barycenter = sum(neighbours) / len(neighbours) if neighbours else node.order
                keyed.append((barycenter, node.order, node))
            keyed.sort(key=lambda item: (item[0], item[1]))
            for index, (_, _, node) in enumerate(keyed):
                node.order = index
            column[:] = [node for _, _, node in keyed]

    for _ in range(3):
        sweep(out_of, columns)                  # order by targets to the right
        sweep(into, list(reversed(columns)))    # order by sources to the left
    return columns


def size_nodes(nodes: dict[str, Node]) -> None:
    for node in nodes.values():
        if node.junction:
            continue
        node.lines = wrap_statement(node.statement)
        footer = FOOTER_PLAIN if node.observed else FOOTER_CLAIM
        node.h = HEADER_H + len(node.lines) * LINE_H + footer


def place_nodes(columns: list[list[Node]]) -> tuple[float, float]:
    heights = []
    for column in columns:
        heights.append(sum(node.h for node in column) + ROW_GAP * max(len(column) - 1, 0))
    canvas_h = max(heights, default=0.0) + 2 * MARGIN
    for column_index, column in enumerate(columns):
        x = MARGIN + column_index * (NODE_W + COL_GAP)
        y = (canvas_h - heights[column_index]) / 2.0
        for node in column:
            node.x = x + (NODE_W - node.w) / 2.0
            node.y = y
            y += node.h + ROW_GAP
    canvas_w = MARGIN * 2 + len(columns) * NODE_W + (len(columns) - 1) * COL_GAP
    return canvas_w, canvas_h


def route_edges(nodes: dict[str, Node], edges: list[Edge]) -> None:
    incoming: dict[str, list[Edge]] = {}
    outgoing: dict[str, list[Edge]] = {}
    for edge in edges:
        incoming.setdefault(edge.target, []).append(edge)
        outgoing.setdefault(edge.source, []).append(edge)

    def spread(count: int, index: int) -> float:
        if count == 1:
            return 0.5
        low, high = 0.28, 0.72
        return low + (high - low) * index / (count - 1)

    source_y: dict[tuple[str, str, str], float] = {}
    target_y: dict[tuple[str, str, str], float] = {}
    for node_id, bundle in outgoing.items():
        bundle.sort(key=lambda e: (nodes[e.target].y, e.target, e.strategy_id))
        for index, edge in enumerate(bundle):
            node = nodes[node_id]
            source_y[(edge.source, edge.target, edge.strategy_id)] = (
                node.y + node.h * spread(len(bundle), index)
            )
    for node_id, bundle in incoming.items():
        bundle.sort(key=lambda e: (nodes[e.source].y, e.source, e.strategy_id))
        for index, edge in enumerate(bundle):
            node = nodes[node_id]
            target_y[(edge.source, edge.target, edge.strategy_id)] = (
                node.y + node.h * spread(len(bundle), index)
            )
            # A first stagger of the grade chips along the path; the real
            # collision-free placement happens in place_chips once every
            # edge's geometry is known.
            count = len(bundle)
            edge.chip_t = 0.5 if count == 1 else 0.30 + 0.45 * index / (count - 1)

    for edge in edges:
        key = (edge.source, edge.target, edge.strategy_id)
        source = nodes[edge.source]
        target = nodes[edge.target]
        edge.points = (
            source.x + source.w,
            source_y[key],
            target.x,
            target_y[key],
        )


def chip_box(edge: Edge, t: float) -> tuple[float, float, float, float]:
    """The (x, y, w, h) rectangle the grade chip occupies at path position t,
    matching the geometry svg_edge draws (center at the bezier point)."""
    text = f"{edge.grade} {factor_text(edge.lr)}"
    width = 12 + 5.6 * len(text)
    cx, cy = bezier_point(edge, t)
    return (cx - width / 2.0, cy - 9.0, width, 17.0)


def rects_overlap(a: tuple[float, float, float, float],
                  b: tuple[float, float, float, float],
                  margin: float = 2.0) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (
        ax + aw + margin <= bx
        or bx + bw + margin <= ax
        or ay + ah + margin <= by
        or by + bh + margin <= ay
    )


def overlap_area(a: tuple[float, float, float, float],
                 b: tuple[float, float, float, float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    dx = min(ax + aw, bx + bw) - max(ax, bx)
    dy = min(ay + ah, by + bh) - max(ay, by)
    return max(0.0, dx) * max(0.0, dy)


def place_chips(nodes: dict[str, Node], edges: list[Edge]) -> None:
    """Deterministic collision-free placement of the grade chips.

    The stagger route_edges assigns is only a starting point: with several
    updates converging on one card (typically the root claim), chips at
    evenly spread path positions still land on each other and on nearby
    cards. For each chip, in a fixed processing order, this pass slides
    along the edge path -- starting from the staggered position and probing
    outward in both directions -- and takes the first position clear of
    every card and every chip already placed; if no probed position is
    fully clear, it takes the one with the least total overlap. Pure
    geometry over sorted inputs, so the output stays byte-reproducible.
    """
    # Junctions included: a chip sitting on a derive/compose relay is just
    # as unreadable as one sitting on a card.
    obstacles = [
        (node.x, node.y, node.w, node.h)
        for node in sorted(nodes.values(), key=lambda n: n.id)
    ]
    placed: list[tuple[float, float, float, float]] = []
    chip_edges = [e for e in edges if e.kind == "update" and e.effect != "neutral"]
    chip_edges.sort(key=lambda e: (e.target, e.source, e.strategy_id))
    for edge in chip_edges:
        base = edge.chip_t
        candidates = [base]
        step = 0.04
        for k in range(1, 18):
            for direction in (1.0, -1.0):
                t = base + direction * step * k
                if 0.10 <= t <= 0.90:
                    candidates.append(t)
        best_t = base
        best_cost = None
        for t in candidates:
            box = chip_box(edge, t)
            cost = sum(overlap_area(box, other) for other in obstacles)
            cost += sum(overlap_area(box, other) for other in placed)
            clear = not any(rects_overlap(box, other) for other in obstacles) and not any(
                rects_overlap(box, other) for other in placed
            )
            if clear:
                best_t = t
                best_cost = None
                break
            if best_cost is None or cost < best_cost:
                best_t, best_cost = t, cost
        edge.chip_t = best_t
        placed.append(chip_box(edge, best_t))


def bezier_point(edge: Edge, t: float) -> tuple[float, float]:
    x1, y1, x2, y2 = edge.points
    dx = min(150.0, max(40.0, (x2 - x1) * 0.45))
    px = (x1, x1 + dx, x2 - dx, x2)
    py = (y1, y1, y2, y2)
    mt = 1 - t
    bx = mt**3 * px[0] + 3 * mt**2 * t * px[1] + 3 * mt * t**2 * px[2] + t**3 * px[3]
    by = mt**3 * py[0] + 3 * mt**2 * t * py[1] + 3 * mt * t**2 * py[2] + t**3 * py[3]
    return bx, by


def edge_path(edge: Edge) -> str:
    x1, y1, x2, y2 = edge.points
    dx = min(150.0, max(40.0, (x2 - x1) * 0.45))
    return (
        f"M {x1:.1f} {y1:.1f} "
        f"C {x1 + dx:.1f} {y1:.1f} {x2 - dx:.1f} {y2:.1f} {x2:.1f} {y2:.1f}"
    )


def esc(text: str) -> str:
    return html.escape(text, quote=True)


def svg_node(node: Node) -> str:
    role = node.role()
    if node.junction:
        return (
            f'<g class="node node-junction" transform="translate({node.x:.1f},{node.y:.1f})">'
            f'<ellipse cx="{node.w / 2:.0f}" cy="{node.h / 2:.0f}" rx="{node.w / 2:.0f}" '
            f'ry="{node.h / 2:.0f}"></ellipse>'
            f'<text x="{node.w / 2:.0f}" y="{node.h / 2 + 3.5:.0f}" text-anchor="middle" '
            f'class="jlabel">{esc(node.label)}</text></g>'
        )
    header = {
        "root": f"root claim · {esc(pretty(node.label))}",
        "claim": esc(pretty(node.label)),
        "evidence": f"evidence · {esc(pretty(node.label[3:] if node.label.startswith('ev_') else node.label))}",
    }[role]
    parts = [
        f'<g class="node node-{role}" data-id="{esc(node.id)}" tabindex="0" role="button" '
        f'aria-label="{esc(pretty(node.label))}: {esc(node.statement)}" '
        f'transform="translate({node.x:.1f},{node.y:.1f})">',
        f'<rect class="card" width="{node.w:.0f}" height="{node.h:.0f}" rx="10"></rect>',
        f'<rect class="stripe" x="0" y="0" width="4.5" height="{node.h:.0f}" rx="2.2"></rect>',
        f'<text class="ntag" x="{PAD_X}" y="21">{header}</text>',
    ]
    statement_spans = "".join(
        f'<tspan x="{PAD_X}" dy="{LINE_H if index else 0}">{esc(line)}</tspan>'
        for index, line in enumerate(node.lines)
    )
    parts.append(f'<text class="nstmt" x="{PAD_X}" y="{HEADER_H + 12}">{statement_spans}</text>')
    if not node.observed and node.belief is not None:
        bar_w = node.w - 2 * PAD_X - 52
        bar_y = node.h - 19
        fill_w = max(0.0, min(1.0, node.belief)) * bar_w
        parts.append(
            f'<g class="belief"><rect class="track" x="{PAD_X}" y="{bar_y:.0f}" '
            f'width="{bar_w:.0f}" height="6" rx="3"></rect>'
            f'<rect class="fill" x="{PAD_X}" y="{bar_y:.0f}" width="{fill_w:.1f}" '
            f'height="6" rx="3"></rect>'
            f'<text class="bval" x="{node.w - PAD_X}" y="{bar_y + 6.5:.0f}" '
            f'text-anchor="end">{node.belief:.3f}</text></g>'
        )
    elif node.observed:
        parts.append(
            f'<text class="obsnote" x="{PAD_X}" y="{node.h - 10:.0f}">recorded observation</text>'
        )
    parts.append("</g>")
    return "".join(parts)


def svg_edge(edge: Edge, index: int) -> str:
    path = edge_path(edge)
    classes = f"edge edge-{edge.effect}" if edge.kind == "update" else "edge edge-flow"
    marker = {
        "supports": "url(#arrow-supports)",
        "lowers": "url(#arrow-lowers)",
        "neutral": "url(#arrow-neutral)",
    }["neutral" if edge.kind != "update" else edge.effect]
    parts = [
        f'<path class="{classes}" d="{path}" style="stroke-width:{edge.width:.1f}px" '
        f'marker-end="{marker}"></path>',
        f'<path class="edge-hit" d="{path}" data-edge="{index}"></path>',
    ]
    if edge.kind == "update" and edge.effect != "neutral":
        cx, cy = bezier_point(edge, edge.chip_t)
        text = f"{edge.grade} {factor_text(edge.lr)}"
        width = 12 + 5.6 * len(text)
        parts.append(
            f'<g class="chip chip-{edge.effect}" data-edge="{index}" '
            f'transform="translate({cx - width / 2:.1f},{cy - 9:.1f})">'
            f'<rect width="{width:.0f}" height="17" rx="8.5"></rect>'
            f'<text x="{width / 2:.0f}" y="12">{esc(text)}</text></g>'
        )
    return "".join(parts)


def panel_payload(
    nodes: dict[str, Node], edges: list[Edge], doc_path: str | None = None
) -> dict:
    payload_nodes = {}
    for node in nodes.values():
        # Junctions are not clickable, but flow edges name them; give them a
        # readable label so the panel never shows an internal strategy id.
        label = f"{pretty(node.label)} step" if node.junction else pretty(node.label)
        payload_nodes[node.id] = {
            "label": label,
            "raw_label": node.label,
            "role": node.role(),
            "statement": node.statement,
            "belief": node.belief,
            "observed": node.observed,
            "pinned_prior": node.pinned_prior,
            "observation_note": node.obs_prose,
            "observation_anchors": [classify_anchor(a) for a in node.obs_anchors],
        }
        if doc_path and not node.junction and not node.label.startswith(HELPER_LABEL_PREFIXES):
            # The detailed-reasoning render precedes each node section with an
            # explicit case-preserving <a id="{label}"></a>, so the label is
            # used verbatim. Helper nodes have no section there, so they never
            # link.
            payload_nodes[node.id]["doc_href"] = f"{doc_path}#{node.label}"
    payload_edges = []
    for edge in edges:
        payload_edges.append(
            {
                "source": edge.source,
                "target": edge.target,
                "kind": edge.kind,
                "effect": edge.effect,
                "grade": edge.grade,
                "factor": factor_text(edge.lr) if edge.kind == "update" else "",
                "p_e_given_h": edge.p_h,
                "p_e_given_not_h": edge.p_nh,
                "rationale": edge.rationale_prose,
                "anchors": [classify_anchor(a) for a in edge.anchors],
            }
        )
    return {"nodes": payload_nodes, "edges": payload_edges}


PAGE_CSS = """
:root {
  color-scheme: light dark;
  --bg: #f4f6f9; --card: #ffffff; --ink: #1d2733; --muted: #5d6b7a;
  --line: #d7dee6; --evidence-bg: #fbf4de; --evidence-edge: #b18b2c;
  --claim-edge: #64809c; --root-edge: #2f6fbd; --root-bg: #eef4fc;
  --support: #2563c4; --lower: #c0392b; --flow: #8a97a5;
  --track: #e2e8ef; --chipbg: #ffffff; --panel: #ffffff;
}
:root[data-theme="dark"] {
  --bg: #10151b; --card: #1b232c; --ink: #e7edf3; --muted: #9db0c0;
  --line: #2c3946; --evidence-bg: #322b17; --evidence-edge: #c9a24a;
  --claim-edge: #587691; --root-edge: #6aa1e8; --root-bg: #1d2a3c;
  --support: #6aa1e8; --lower: #e0776b; --flow: #77879a;
  --track: #2b3745; --chipbg: #10151b; --panel: #161d25;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #10151b; --card: #1b232c; --ink: #e7edf3; --muted: #9db0c0;
    --line: #2c3946; --evidence-bg: #322b17; --evidence-edge: #c9a24a;
    --claim-edge: #587691; --root-edge: #6aa1e8; --root-bg: #1d2a3c;
    --support: #6aa1e8; --lower: #e0776b; --flow: #77879a;
    --track: #2b3745; --chipbg: #10151b; --panel: #161d25;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
}
header {
  display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  padding: 14px 20px 10px; border-bottom: 1px solid var(--line);
}
header h1 { font-size: 19px; margin: 0; font-weight: 650; }
header .meta { font-size: 12px; color: var(--muted); }
header .stats { font-size: 12px; color: var(--muted); margin-left: auto; }
header .stats .lowering { color: var(--lower); font-weight: 600; }
header nav { display: flex; gap: 12px; font-size: 12.5px; }
header nav a { color: var(--support); text-decoration: none; }
header nav a:hover { text-decoration: underline; }
.posterior-pill {
  font-size: 12.5px; font-weight: 650; padding: 3px 10px; border-radius: 999px;
  border: 1.5px solid var(--root-edge); color: var(--root-edge);
  font-variant-numeric: tabular-nums;
}
#stage { position: relative; flex: 1; overflow: hidden; }
#graph { width: 100%; height: 100%; display: block; cursor: grab; }
#graph.dragging { cursor: grabbing; }
.node .card { fill: var(--card); stroke: var(--line); stroke-width: 1.2; }
.node { cursor: pointer; }
.node:focus { outline: none; }
.node:hover .card, .node:focus .card, .node.selected .card { stroke-width: 2.2; }
.node-claim .stripe { fill: var(--claim-edge); }
.node-claim:hover .card, .node-claim.selected .card { stroke: var(--claim-edge); }
.node-evidence .card { fill: var(--evidence-bg); }
.node-evidence .stripe { fill: var(--evidence-edge); }
.node-evidence:hover .card, .node-evidence.selected .card { stroke: var(--evidence-edge); }
.node-root .card { fill: var(--root-bg); stroke: var(--root-edge); stroke-width: 1.8; }
.node-root .stripe { fill: var(--root-edge); }
.ntag {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; fill: var(--muted);
}
.node-root .ntag { fill: var(--root-edge); }
.node-evidence .ntag { fill: var(--evidence-edge); }
.nstmt { font-size: 12.5px; fill: var(--ink); }
.obsnote { font-size: 10.5px; fill: var(--muted); font-style: italic; }
.belief .track { fill: var(--track); }
.belief .fill { fill: var(--support); }
.bval { font-size: 12px; font-weight: 650; fill: var(--ink); font-variant-numeric: tabular-nums; }
.node-junction ellipse { fill: var(--card); stroke: var(--flow); stroke-width: 1.2; }
.jlabel { font-size: 11px; fill: var(--muted); font-style: italic; }
.edge { fill: none; }
.edge-supports { stroke: var(--support); }
.edge-lowers { stroke: var(--lower); stroke-dasharray: 7 5; }
.edge-neutral, .edge-flow { stroke: var(--flow); }
.edge-hit { fill: none; stroke: transparent; stroke-width: 16; cursor: help; }
.chip rect { fill: var(--chipbg); stroke-width: 1.2; }
.chip text { font-size: 10.5px; font-weight: 650; text-anchor: middle; }
.chip-supports rect { stroke: var(--support); }
.chip-supports text { fill: var(--support); }
.chip-lowers rect { stroke: var(--lower); }
.chip-lowers text { fill: var(--lower); }
#legend {
  position: absolute; left: 14px; bottom: 14px; font-size: 12px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
  border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px;
  max-width: 320px;
}
#legend summary { cursor: pointer; font-weight: 650; font-size: 12px; }
#legend .row { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
#legend .swatch { flex: 0 0 26px; height: 14px; border-radius: 4px; border: 1px solid var(--line); }
#legend .sw-evidence { background: var(--evidence-bg); border-left: 4px solid var(--evidence-edge); }
#legend .sw-claim { background: var(--card); border-left: 4px solid var(--claim-edge); }
#legend .sw-root { background: var(--root-bg); border: 1.6px solid var(--root-edge); }
#legend svg { flex: 0 0 26px; }
#zoombar { position: absolute; right: 14px; bottom: 14px; display: flex; gap: 6px; }
#zoombar button, #themetoggle {
  width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--card); color: var(--ink); font-size: 15px; cursor: pointer;
}
#zoombar button:hover, #themetoggle:hover { border-color: var(--support); }
#panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: 390px; max-width: 92vw;
  background: var(--panel); border-left: 1px solid var(--line);
  overflow-y: auto; padding: 16px 18px; box-shadow: -12px 0 28px rgb(0 0 0 / .12);
}
#panel[hidden] { display: none; }
#panel h2 { font-size: 15px; margin: 2px 0 2px; }
#panel .role { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 700; }
#panel .statement { font-size: 13.5px; line-height: 1.45; margin: 8px 0 10px; }
#panel .kv { font-size: 12.5px; color: var(--muted); margin: 3px 0; font-variant-numeric: tabular-nums; }
#panel h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 16px 0 6px; }
#panel .upd { border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; margin: 8px 0; font-size: 12.5px; }
#panel .upd .hdr { display: flex; gap: 8px; align-items: baseline; font-weight: 650; }
#panel .upd .hdr .eff-supports { color: var(--support); }
#panel .upd .hdr .eff-lowers { color: var(--lower); }
#panel .upd .probs { color: var(--muted); font-variant-numeric: tabular-nums; margin-top: 3px; }
#panel .upd .rat { margin-top: 5px; line-height: 1.4; }
#panel .anchors { margin: 5px 0 0; padding-left: 16px; }
#panel .anchors li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; color: var(--muted); }
#panel .anchors a { color: var(--support); text-decoration: underline; }
#panel .doclink { margin-top: 6px; font-size: 12px; }
#panel .doclink a { color: var(--support); text-decoration: underline; }
#panel .close { position: absolute; top: 10px; right: 12px; border: none; background: none; font-size: 18px; color: var(--muted); cursor: pointer; }
#tooltip {
  position: fixed; z-index: 40; max-width: 360px; pointer-events: none;
  background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
  padding: 8px 11px; font-size: 12px; line-height: 1.4;
  box-shadow: 0 6px 22px rgb(0 0 0 / .18);
}
#tooltip[hidden] { display: none; }
#tooltip .hdr { font-weight: 700; margin-bottom: 3px; }
#tooltip .probs { color: var(--muted); font-variant-numeric: tabular-nums; }
.hint { font-size: 11.5px; color: var(--muted); }
noscript { position: absolute; top: 8px; left: 14px; font-size: 12px; color: var(--muted); }
"""

PAGE_JS = """
(function () {
  var data = JSON.parse(document.getElementById('graph-data').textContent);
  var svg = document.getElementById('graph');
  var viewport = document.getElementById('viewport');
  var stage = document.getElementById('stage');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var W = parseFloat(svg.dataset.w), H = parseFloat(svg.dataset.h);
  var tx = 0, ty = 0, scale = 1, fitScale = 1;

  function apply() {
    viewport.setAttribute('transform',
      'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
  }
  function fit() {
    var box = stage.getBoundingClientRect();
    fitScale = Math.min(box.width / W, box.height / H, 1.25);
    // Never open below a readable card size: fit-to-page on a narrow
    // viewport would shrink 300px cards to ~85px. When the readable floor
    // wins, start at the top-left and let pan/zoom take over.
    var MIN_READABLE_SCALE = 0.7;
    scale = Math.max(fitScale, Math.min(MIN_READABLE_SCALE, 1.25));
    if (scale > fitScale) {
      tx = 8;
      ty = 8;
    } else {
      tx = (box.width - W * scale) / 2;
      ty = (box.height - H * scale) / 2;
    }
    apply();
  }
  svg.removeAttribute('viewBox');
  fit();
  window.addEventListener('resize', fit);

  function zoomAt(factor, mx, my) {
    var next = Math.min(3.5, Math.max(0.15, scale * factor));
    tx = mx - (mx - tx) * (next / scale);
    ty = my - (my - ty) * (next / scale);
    scale = next;
    apply();
  }
  stage.addEventListener('wheel', function (event) {
    event.preventDefault();
    var box = stage.getBoundingClientRect();
    zoomAt(Math.exp(-event.deltaY * 0.0016),
      event.clientX - box.left, event.clientY - box.top);
  }, { passive: false });

  var dragging = null;
  svg.addEventListener('pointerdown', function (event) {
    if (event.target.closest('.node') || event.target.closest('.edge-hit')) return;
    dragging = { x: event.clientX - tx, y: event.clientY - ty };
    svg.classList.add('dragging');
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    tx = event.clientX - dragging.x;
    ty = event.clientY - dragging.y;
    apply();
  });
  svg.addEventListener('pointerup', function () {
    dragging = null;
    svg.classList.remove('dragging');
  });
  function zoomCentered(factor) {
    var box = stage.getBoundingClientRect();
    zoomAt(factor, box.width / 2, box.height / 2);
  }
  document.getElementById('zin').addEventListener('click', function () {
    zoomCentered(1.25);
  });
  document.getElementById('zout').addEventListener('click', function () {
    zoomCentered(1 / 1.25);
  });
  document.getElementById('zfit').addEventListener('click', fit);

  var toggle = document.getElementById('themetoggle');
  toggle.addEventListener('click', function () {
    var root = document.documentElement;
    var dark = root.dataset.theme === 'dark' ||
      (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'light' : 'dark';
  });

  function fmtP(value) {
    return value === null || value === undefined ? '—' : Number(value).toFixed(2);
  }
  function effectWord(edge) {
    if (edge.kind !== 'update') return 'structural step link';
    return edge.effect === 'supports' ? 'raises belief' :
      edge.effect === 'lowers' ? 'lowers belief' : 'neutral';
  }

  function showTooltip(event, index) {
    var edge = data.edges[index];
    if (!edge || edge.kind !== 'update') return;
    var from = data.nodes[edge.source] || { label: edge.source };
    var to = data.nodes[edge.target] || { label: edge.target };
    tooltip.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'hdr eff-' + edge.effect;
    header.textContent = from.label + ' → ' + to.label + ': ' + effectWord(edge) +
      (edge.grade ? ', ' + edge.grade + ' (' + edge.factor + ')' : '');
    var probs = document.createElement('div');
    probs.className = 'probs';
    probs.textContent = 'P(e|h) = ' + fmtP(edge.p_e_given_h) +
      ' · P(e|¬h) = ' + fmtP(edge.p_e_given_not_h);
    tooltip.appendChild(header);
    tooltip.appendChild(probs);
    if (edge.rationale) {
      var rationale = document.createElement('div');
      var text = edge.rationale;
      rationale.textContent = text.length > 260 ? text.slice(0, 257) + '…' : text;
      tooltip.appendChild(rationale);
    }
    tooltip.hidden = false;
    moveTooltip(event);
  }
  function moveTooltip(event) {
    var pad = 14;
    var x = Math.min(event.clientX + pad, window.innerWidth - tooltip.offsetWidth - 8);
    var y = Math.min(event.clientY + pad, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.edge-hit, .chip'), function (el) {
    var index = parseInt(el.dataset.edge, 10);
    el.addEventListener('pointermove', function (event) { showTooltip(event, index); });
    el.addEventListener('pointerleave', function () { tooltip.hidden = true; });
  });

  function anchorList(anchors) {
    if (!anchors || !anchors.length) return null;
    var list = document.createElement('ul');
    list.className = 'anchors';
    anchors.forEach(function (anchor) {
      var item = document.createElement('li');
      // anchor.href is assigned by the renderer's whitelist (http(s) URLs
      // and relative Markdown paths only); everything else stays plain
      // machine-readable text. DOM assignment, never innerHTML.
      if (anchor.href) {
        var link = document.createElement('a');
        link.href = anchor.href;
        link.textContent = anchor.text;
        if (anchor.href.indexOf('http') === 0) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        item.appendChild(link);
      } else {
        item.textContent = anchor.text;
      }
      list.appendChild(item);
    });
    return list;
  }
  function updateCard(edge, direction) {
    var other = direction === 'in' ? edge.source : edge.target;
    var otherNode = data.nodes[other] || { label: other, statement: '' };
    var card = document.createElement('div');
    card.className = 'upd';
    var header = document.createElement('div');
    header.className = 'hdr';
    var effect = document.createElement('span');
    effect.className = 'eff-' + edge.effect;
    effect.textContent = (direction === 'in' ? 'from ' : 'into ') + otherNode.label +
      ' — ' + effectWord(edge) + (edge.grade ? ', ' + edge.grade + ' ' + edge.factor : '');
    header.appendChild(effect);
    card.appendChild(header);
    if (edge.kind === 'update') {
      var probs = document.createElement('div');
      probs.className = 'probs';
      probs.textContent = 'P(e|h) = ' + fmtP(edge.p_e_given_h) +
        ' · P(e|¬h) = ' + fmtP(edge.p_e_given_not_h);
      card.appendChild(probs);
    }
    if (edge.rationale) {
      var rationale = document.createElement('div');
      rationale.className = 'rat';
      rationale.textContent = edge.rationale;
      card.appendChild(rationale);
    }
    var anchors = anchorList(edge.anchors);
    if (anchors) card.appendChild(anchors);
    return card;
  }
  function openPanel(id) {
    var node = data.nodes[id];
    if (!node) return;
    panel.innerHTML = '';
    var close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { closePanel(); });
    panel.appendChild(close);
    var role = document.createElement('div');
    role.className = 'role';
    role.textContent = node.role === 'root' ? 'root claim' :
      node.role === 'evidence' ? 'observed evidence' : 'claim';
    panel.appendChild(role);
    var heading = document.createElement('h2');
    heading.textContent = node.label;
    panel.appendChild(heading);
    var statement = document.createElement('div');
    statement.className = 'statement';
    statement.textContent = node.statement;
    panel.appendChild(statement);
    if (node.doc_href) {
      // Written by the renderer only when the package carries a rendered
      // docs/detailed-reasoning.md; the anchor is the node's own heading.
      var doc = document.createElement('div');
      doc.className = 'doclink';
      var docLink = document.createElement('a');
      docLink.href = node.doc_href;
      docLink.textContent = 'detailed reasoning \u2192';
      doc.appendChild(docLink);
      panel.appendChild(doc);
    }
    if (!node.observed && node.belief !== null && node.belief !== undefined) {
      var belief = document.createElement('div');
      belief.className = 'kv';
      belief.textContent = 'posterior belief ' + Number(node.belief).toFixed(3);
      panel.appendChild(belief);
    }
    if (node.observed) {
      var pin = document.createElement('div');
      pin.className = 'kv';
      pin.textContent = 'entered as observed evidence' +
        (node.pinned_prior !== null && node.pinned_prior !== undefined
          ? ' (pinned at ' + Number(node.pinned_prior).toFixed(3) + ')' : '');
      panel.appendChild(pin);
      if (node.observation_note) {
        var note = document.createElement('div');
        note.className = 'kv';
        note.textContent = node.observation_note;
        panel.appendChild(note);
      }
      var obsAnchors = anchorList(node.observation_anchors);
      if (obsAnchors) panel.appendChild(obsAnchors);
    }
    var incoming = data.edges.filter(function (edge) { return edge.target === id; });
    var outgoing = data.edges.filter(function (edge) { return edge.source === id; });
    if (incoming.length) {
      var headingIn = document.createElement('h3');
      headingIn.textContent = 'updated by';
      panel.appendChild(headingIn);
      incoming.forEach(function (edge) { panel.appendChild(updateCard(edge, 'in')); });
    }
    if (outgoing.length) {
      var headingOut = document.createElement('h3');
      headingOut.textContent = 'updates';
      panel.appendChild(headingOut);
      outgoing.forEach(function (edge) { panel.appendChild(updateCard(edge, 'out')); });
    }
    panel.hidden = false;
    Array.prototype.forEach.call(document.querySelectorAll('.node.selected'), function (el) {
      el.classList.remove('selected');
    });
    var selected = document.querySelector('.node[data-id="' + CSS.escape(id) + '"]');
    if (selected) selected.classList.add('selected');
  }
  function closePanel() {
    panel.hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('.node.selected'), function (el) {
      el.classList.remove('selected');
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.node[data-id]'), function (el) {
    el.addEventListener('click', function () { openPanel(el.dataset.id); });
    el.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPanel(el.dataset.id);
      }
    });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closePanel();
  });
})();
"""


def render_page(
    *,
    title: str,
    subtitle: str,
    links: list[tuple[str, str]],
    meta_line: str,
    nodes: dict[str, Node],
    edges: list[Edge],
    canvas: tuple[float, float],
    doc_path: str | None = None,
) -> str:
    canvas_w, canvas_h = canvas
    roots = [n for n in nodes.values() if n.is_root and not n.junction]
    root_chip = ""
    if roots:
        best = max(roots, key=lambda n: (n.belief is not None, n.belief or 0.0))
        if best.belief is not None:
            root_chip = (
                f'<span class="posterior-pill">{esc(pretty(best.label))} '
                f"{best.belief:.3f}</span>"
            )
    n_claims = sum(1 for n in nodes.values() if not n.junction and not n.observed)
    n_evidence = sum(1 for n in nodes.values() if n.observed)
    updates = [e for e in edges if e.kind == "update"]
    n_lowering = sum(1 for e in updates if e.effect == "lowers")
    lowering_text = (
        f' · <span class="lowering">{n_lowering} lowering</span>' if n_lowering else ""
    )
    stats = (
        f"{n_claims} claims · {n_evidence} evidence · {len(updates)} updates"
        f"{lowering_text}"
    )
    nav = "".join(f'<a href="{esc(href)}">{esc(label)}</a>' for label, href in links)

    ordered_nodes = sorted(nodes.values(), key=lambda n: (n.column, n.order, n.id))
    node_svg = "".join(svg_node(n) for n in ordered_nodes)
    edge_svg = "".join(svg_edge(e, i) for i, e in enumerate(edges))
    # No raw "<" may survive inside the inline JSON block: "</" could close
    # the script element early, and "<!--" would flip the parser into the
    # script double-escaped state. "<" only occurs inside JSON strings, and
    # the < escape decodes back to the same character on JSON.parse.
    payload = json.dumps(
        panel_payload(nodes, edges, doc_path=doc_path), sort_keys=True, ensure_ascii=False
    ).replace("<", "\\u003c")

    flow_row = (
        '\n<div class="row"><svg width="26" height="14"><line x1="0" y1="7" x2="26" '
        'y2="7" style="stroke:var(--flow);stroke-width:2.2"/></svg>gray arrow = '
        "structural step link (derive/compose), not a belief update</div>"
        if any(n.junction for n in nodes.values())
        else ""
    )
    legend = f"""
<details id="legend"><summary>Legend</summary>
<div class="row"><span class="swatch sw-evidence"></span>observed evidence (statement entered as fact)</div>
<div class="row"><span class="swatch sw-claim"></span>claim, with posterior belief bar</div>
<div class="row"><span class="swatch sw-root"></span>root claim (what the graph is about)</div>
<div class="row"><svg width="26" height="14"><line x1="0" y1="7" x2="26" y2="7" style="stroke:var(--support);stroke-width:2.6"/></svg>arrow raises belief in its target</div>
<div class="row"><svg width="26" height="14"><line x1="0" y1="7" x2="26" y2="7" style="stroke:var(--lower);stroke-width:2.6;stroke-dasharray:6 4"/></svg>arrow lowers belief in its target</div>{flow_row}
<div class="row"><span class="hint">line width and chip = update strength (likelihood ratio); click a card for likelihoods, rationale, and source anchors</span></div>
</details>"""

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<header>
  <div>
    <h1>{esc(title)}</h1>
    <div class="meta">{esc(subtitle) + " · " if subtitle else ""}{esc(meta_line)}</div>
  </div>
  {root_chip}
  <nav>{nav}</nav>
  <div class="stats">{stats}</div>
  <button id="themetoggle" title="Toggle light/dark">◐</button>
</header>
<div id="stage">
  <noscript>Static view: pan/zoom, tooltips, and the detail panel need JavaScript.</noscript>
  <svg id="graph" data-w="{canvas_w:.0f}" data-h="{canvas_h:.0f}" viewBox="0 0 {canvas_w:.0f} {canvas_h:.0f}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow-supports" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--support)"></path>
      </marker>
      <marker id="arrow-lowers" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--lower)"></path>
      </marker>
      <marker id="arrow-neutral" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--flow)"></path>
      </marker>
    </defs>
    <g id="viewport">{edge_svg}{node_svg}</g>
  </svg>
{legend}
  <div id="zoombar">
    <button id="zout" title="Zoom out">−</button>
    <button id="zin" title="Zoom in">+</button>
    <button id="zfit" title="Fit">⤢</button>
  </div>
  <aside id="panel" hidden></aside>
  <div id="tooltip" hidden></div>
</div>
<script id="graph-data" type="application/json">{payload}</script>
<script>{PAGE_JS}</script>
</body>
</html>
"""


def parse_link(raw: str) -> tuple[str, str]:
    label, separator, href = raw.partition("=")
    if not separator or not label.strip() or not href.strip():
        raise fail(f"--link expects LABEL=HREF, got {raw!r}")
    return label.strip(), href.strip()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Render a compiled+inferred Gaia argument-graph package as one "
            "self-contained HTML page (statements on cards, update direction "
            "and strength on the edges)."
        )
    )
    parser.add_argument("--package", required=True, help="package directory")
    parser.add_argument(
        "--out",
        help="output HTML path (default: <package>/argument-graph.html)",
    )
    parser.add_argument("--title", help="page title (default: package name)")
    parser.add_argument("--subtitle", default="", help="extra header line text")
    parser.add_argument(
        "--link",
        action="append",
        default=[],
        metavar="LABEL=HREF",
        help="add a header navigation link (repeatable)",
    )
    args = parser.parse_args()

    package_dir = Path(args.package).resolve()
    if not package_dir.is_dir():
        raise fail(f"package directory not found: {package_dir}")
    ir = load_json(package_dir / ".gaia" / "ir.json", "compiled IR")
    beliefs_doc = load_json(
        package_dir / ".gaia" / "beliefs.json", "inference output (beliefs)"
    )
    metadata_path = package_dir / ".gaia" / "compile_metadata.json"
    compile_metadata = (
        json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata_path.is_file()
        else {}
    )

    beliefs_by_id = {
        entry["knowledge_id"]: float(entry["belief"])
        for entry in beliefs_doc.get("beliefs", [])
        if "knowledge_id" in entry and entry.get("belief") is not None
    }

    nodes, edges = build_model(ir, beliefs_by_id)
    if not nodes:
        raise fail("the package IR contains no drawable nodes")
    assign_layers(nodes, edges)
    columns = order_columns(nodes, edges)
    size_nodes(nodes)
    canvas = place_nodes(columns)
    route_edges(nodes, edges)
    place_chips(nodes, edges)

    package_name = ir.get("package_name") or package_dir.name
    title = args.title or pretty(str(package_name))
    ir_hash = str(ir.get("ir_hash") or compile_metadata.get("ir_hash") or "")
    hash_note = f" · ir {ir_hash.removeprefix('sha256:')[:12]}" if ir_hash else ""
    compiled_note = (
        f" · compiled {compile_metadata['compiled_at']}"
        if compile_metadata.get("compiled_at")
        else ""
    )
    version_note = (
        f" · gaia-lang {compile_metadata['gaia_lang_version']}"
        if compile_metadata.get("gaia_lang_version")
        else ""
    )
    meta_line = f"{package_name}{version_note}{compiled_note}{hash_note}"

    # Deep-dive links: when the package carries the rendered
    # detailed-reasoning document, every card's detail panel links to that
    # node's section. Existence is part of the package state, so the output
    # stays a pure function of the package (byte-reproducible). The relative
    # href assumes the page sits at the package root, its default location;
    # a caller writing --out elsewhere keeps a working graph, only the
    # deep-dive links would dangle, so they are dropped in that case.
    out_path = Path(args.out) if args.out else package_dir / "argument-graph.html"
    # The production pipeline renders through an atomic-rename temp file
    # that is a SIBLING of the final page (package root), so the plain
    # parent check covers it; only a page written into some other
    # directory -- where the relative link would dangle -- drops links.
    doc_path = (
        "docs/detailed-reasoning.md"
        if out_path.parent.resolve() == package_dir
        and detailed_reasoning_matches_beliefs(package_dir)
        else None
    )
    page = render_page(
        title=title,
        subtitle=args.subtitle,
        links=[parse_link(raw) for raw in args.link],
        meta_line=meta_line,
        nodes=nodes,
        edges=edges,
        canvas=canvas,
        doc_path=doc_path,
    )
    tmp_path = out_path.with_suffix(out_path.suffix + ".part")
    tmp_path.write_text(page, encoding="utf-8")
    tmp_path.replace(out_path)
    sys.stderr.write(f"ok: argument graph -> {out_path}\n")


if __name__ == "__main__":
    main()
