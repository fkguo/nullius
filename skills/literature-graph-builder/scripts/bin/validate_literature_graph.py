#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


DEFAULT_NODE_KINDS = {
    "paper",
    "method",
    "topic",
    "dataset",
    "result",
    "synthesis",
}

DEFAULT_RELATIONS = {
    "application",
    "cites",
    "contrast",
    "extends",
    "method-lineage",
    "same-work",
    "source-support",
    "synthesis",
    "topic",
    "uses-method",
}

RENDERABLE_FIGURE_EXTENSIONS = {
    ".gif",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".svg",
    ".webp",
}

NON_RENDERABLE_SOURCE_EXTENSIONS = {".eps", ".ps"}
NODE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")


@dataclass
class Issue:
    level: str
    path: str
    message: str


def is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https", "doi", "arxiv", "zotero"}


def is_file_url(value: str) -> bool:
    return urlparse(value).scheme == "file"


def strip_fragment(value: str) -> str:
    return value.split("#", 1)[0]


def check_relative_path(
    *,
    value: Any,
    field: str,
    item_path: str,
    project_root: Path,
    must_exist: bool = True,
    allow_url: bool = False,
) -> tuple[Path | None, list[Issue]]:
    issues: list[Issue] = []
    if not isinstance(value, str) or not value.strip():
        issues.append(Issue("error", item_path, f"{field} must be a non-empty string"))
        return None, issues

    raw = value.strip()
    if is_file_url(raw):
        issues.append(Issue("error", item_path, f"{field} must not use a file:// URL: {raw}"))
        return None, issues

    if is_url(raw):
        if allow_url:
            return None, issues
        issues.append(Issue("error", item_path, f"{field} must be a portable relative path, not a URL: {raw}"))
        return None, issues

    without_fragment = unquote(strip_fragment(raw))
    path = Path(without_fragment)
    if path.is_absolute():
        issues.append(Issue("error", item_path, f"{field} must not be an absolute path: {raw}"))
        return None, issues
    if any(part == ".." for part in path.parts):
        issues.append(Issue("error", item_path, f"{field} must not escape the project root: {raw}"))
        return None, issues

    resolved = (project_root / path).resolve()
    try:
        resolved.relative_to(project_root.resolve())
    except ValueError:
        issues.append(Issue("error", item_path, f"{field} resolves outside project root: {raw}"))
        return None, issues

    if must_exist:
        if not resolved.exists():
            issues.append(Issue("error", item_path, f"{field} target does not exist: {raw}"))
        elif not resolved.is_file():
            issues.append(Issue("error", item_path, f"{field} target is not a file: {raw}"))
    return resolved, issues


def has_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_source_uri_value(value: Any, item_path: str) -> list[Issue]:
    if not has_nonempty_string(value):
        return [Issue("error", item_path, "source_uri must be a non-empty string when present")]

    raw = value.strip()
    if is_file_url(raw):
        return [Issue("error", item_path, f"source_uri must not use a file:// URL: {raw}")]

    if re.match(r"^[A-Za-z]:[\\/]", raw):
        return [Issue("error", item_path, f"source_uri must not use a host-specific absolute path: {raw}")]
    if raw.startswith("~"):
        return [Issue("error", item_path, f"source_uri must not use a home-relative path: {raw}")]

    parsed = urlparse(raw)
    if parsed.scheme:
        return []

    without_fragment = unquote(strip_fragment(raw))
    path = Path(without_fragment)
    if path.is_absolute():
        return [Issue("error", item_path, f"source_uri must not be an absolute path: {raw}")]
    if any(part == ".." for part in path.parts):
        return [Issue("error", item_path, f"source_uri must not escape the project root: {raw}")]
    return []


def validate_source_uri_fields(container: dict[str, Any], item_path: str) -> list[Issue]:
    issues: list[Issue] = []

    source_uri = container.get("source_uri")
    if source_uri is not None:
        issues.extend(validate_source_uri_value(source_uri, f"{item_path}.source_uri"))

    source_uris = container.get("source_uris")
    if source_uris is not None:
        if not isinstance(source_uris, list):
            issues.append(Issue("error", f"{item_path}.source_uris", "source_uris must be an array when present"))
        else:
            for source_index, uri in enumerate(source_uris):
                issues.extend(validate_source_uri_value(uri, f"{item_path}.source_uris[{source_index}]"))

    return issues


def has_edge_support(edge: dict[str, Any]) -> bool:
    if any(has_nonempty_string(edge.get(field)) for field in ("evidence", "locator", "note_path", "source_uri")):
        return True
    source_uris = edge.get("source_uris")
    return isinstance(source_uris, list) and any(has_nonempty_string(uri) for uri in source_uris)


def validate_node(
    node: Any,
    index: int,
    project_root: Path,
    allowed_kinds: set[str],
) -> tuple[str | None, list[Issue]]:
    item_path = f"nodes[{index}]"
    issues: list[Issue] = []
    if not isinstance(node, dict):
        return None, [Issue("error", item_path, "node must be an object")]

    node_id = node.get("id")
    if not isinstance(node_id, str) or not node_id.strip():
        issues.append(Issue("error", item_path, "id must be a non-empty string"))
        node_id = None
    elif not NODE_ID_RE.match(node_id):
        issues.append(Issue("error", item_path, f"id is not a stable ASCII graph id: {node_id!r}"))

    label = node.get("label")
    if not isinstance(label, str) or not label.strip():
        issues.append(Issue("error", item_path, "label must be a non-empty string"))

    kind = node.get("kind")
    if not isinstance(kind, str) or not kind.strip():
        issues.append(Issue("error", item_path, "kind must be a non-empty string"))
    elif kind not in allowed_kinds:
        issues.append(Issue("error", item_path, f"unknown node kind {kind!r}; pass --allow-node-kind to permit it"))

    note_path = node.get("note_path")
    resolved_note, path_issues = check_relative_path(
        value=note_path,
        field="note_path",
        item_path=item_path,
        project_root=project_root,
    )
    issues.extend(path_issues)
    if resolved_note is not None and resolved_note.suffix.lower() not in {".md", ".markdown"}:
        issues.append(Issue("error", item_path, f"note_path should point to Markdown, got {resolved_note.name}"))
    if resolved_note is not None and resolved_note.exists() and resolved_note.stat().st_size == 0:
        issues.append(Issue("error", item_path, f"note_path is empty: {note_path}"))

    issues.extend(validate_source_uri_fields(node, item_path))

    return node_id if isinstance(node_id, str) else None, issues


def validate_edge(
    edge: Any,
    index: int,
    node_ids: set[str],
    project_root: Path,
    allowed_relations: set[str],
) -> list[Issue]:
    item_path = f"edges[{index}]"
    issues: list[Issue] = []
    if not isinstance(edge, dict):
        return [Issue("error", item_path, "edge must be an object")]

    source = edge.get("source")
    target = edge.get("target")
    for field, value in (("source", source), ("target", target)):
        if not isinstance(value, str) or not value.strip():
            issues.append(Issue("error", item_path, f"{field} must be a non-empty node id"))
        elif value not in node_ids:
            issues.append(Issue("error", item_path, f"{field} references missing node id {value!r}"))

    relation = edge.get("relation")
    if not isinstance(relation, str) or not relation.strip():
        issues.append(Issue("error", item_path, "relation must be a non-empty string"))
    elif relation not in allowed_relations:
        issues.append(Issue("error", item_path, f"unknown relation {relation!r}; pass --allow-relation to permit it"))

    if not has_edge_support(edge):
        issues.append(
            Issue(
                "error",
                item_path,
                "nontrivial edge lacks source support metadata; add evidence, locator, note_path, source_uri, or source_uris",
            )
        )

    if edge.get("note_path"):
        _, path_issues = check_relative_path(
            value=edge["note_path"],
            field="note_path",
            item_path=item_path,
            project_root=project_root,
        )
        issues.extend(path_issues)

    for field in ("evidence", "locator"):
        if field in edge and edge[field] is not None and not isinstance(edge[field], str):
            issues.append(Issue("error", item_path, f"{field} must be a string when present"))

    issues.extend(validate_source_uri_fields(edge, item_path))

    return issues


def validate_figure(
    figure: Any,
    index: int,
    node_ids: set[str],
    project_root: Path,
) -> list[Issue]:
    item_path = f"figures[{index}]"
    issues: list[Issue] = []
    if not isinstance(figure, dict):
        return [Issue("error", item_path, "figure must be an object")]

    node_id = figure.get("node_id")
    if not isinstance(node_id, str) or not node_id.strip():
        issues.append(Issue("error", item_path, "node_id must be a non-empty node id"))
    elif node_id not in node_ids:
        issues.append(Issue("error", item_path, f"node_id references missing node id {node_id!r}"))

    caption = figure.get("caption")
    if not isinstance(caption, str) or not caption.strip():
        issues.append(Issue("error", item_path, "caption must describe what the figure shows"))

    figure_path, path_issues = check_relative_path(
        value=figure.get("path"),
        field="path",
        item_path=item_path,
        project_root=project_root,
    )
    issues.extend(path_issues)
    if figure_path is not None:
        suffix = figure_path.suffix.lower()
        if suffix in NON_RENDERABLE_SOURCE_EXTENSIONS:
            issues.append(Issue("error", item_path, f"path displays a non-renderable EPS/PS source; convert it first: {figure.get('path')}"))
        elif suffix not in RENDERABLE_FIGURE_EXTENSIONS:
            issues.append(Issue("error", item_path, f"path has unsupported renderable extension {suffix!r}"))

    for field in ("source_path", "note_path"):
        if figure.get(field):
            resolved, field_issues = check_relative_path(
                value=figure[field],
                field=field,
                item_path=item_path,
                project_root=project_root,
                allow_url=(field == "source_path"),
            )
            issues.extend(field_issues)
            if field == "source_path" and resolved is not None and resolved.suffix.lower() in NON_RENDERABLE_SOURCE_EXTENSIONS:
                issues.append(
                    Issue(
                        "warning",
                        item_path,
                        f"source_path is EPS/PS; keep it only as provenance and display the converted path: {figure[field]}",
                    )
                )

    locator = figure.get("locator")
    if locator is not None and not isinstance(locator, str):
        issues.append(Issue("error", item_path, "locator must be a string when present"))

    return issues


def validate_graph(
    graph: Any,
    project_root: Path,
    allowed_kinds: set[str],
    allowed_relations: set[str],
) -> list[Issue]:
    issues: list[Issue] = []
    if not isinstance(graph, dict):
        return [Issue("error", "$", "graph must be a JSON object")]

    version = graph.get("version")
    if version != "literature_graph_v1":
        issues.append(Issue("error", "$.version", "version must be 'literature_graph_v1'"))

    nodes = graph.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        issues.append(Issue("error", "$.nodes", "nodes must be a non-empty array"))
        nodes = []

    edges = graph.get("edges", [])
    if not isinstance(edges, list):
        issues.append(Issue("error", "$.edges", "edges must be an array when present"))
        edges = []

    figures = graph.get("figures", [])
    if not isinstance(figures, list):
        issues.append(Issue("error", "$.figures", "figures must be an array when present"))
        figures = []

    node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        node_id, node_issues = validate_node(node, index, project_root, allowed_kinds)
        issues.extend(node_issues)
        if node_id:
            if node_id in node_ids:
                issues.append(Issue("error", f"nodes[{index}]", f"duplicate node id {node_id!r}"))
            node_ids.add(node_id)

    for index, edge in enumerate(edges):
        issues.extend(validate_edge(edge, index, node_ids, project_root, allowed_relations))

    for index, figure in enumerate(figures):
        issues.extend(validate_figure(figure, index, node_ids, project_root))

    return issues


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path}: invalid JSON: {exc}") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate a portable literature_graph_v1 JSON artifact.")
    parser.add_argument("--graph", type=Path, required=True, help="Path to literature_graph_v1 JSON.")
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        help="Root used to resolve relative note and figure paths. Defaults to the graph file directory.",
    )
    parser.add_argument("--allow-node-kind", action="append", default=[], help="Additional permitted node kind.")
    parser.add_argument("--allow-relation", action="append", default=[], help="Additional permitted edge relation.")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as errors.")
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    graph_path = args.graph.resolve()
    if not graph_path.exists():
        print(f"{args.graph}: graph file does not exist", file=sys.stderr)
        return 2

    project_root = (args.project_root or graph_path.parent).resolve()
    graph = load_json(graph_path)
    issues = validate_graph(
        graph,
        project_root=project_root,
        allowed_kinds=DEFAULT_NODE_KINDS | set(args.allow_node_kind),
        allowed_relations=DEFAULT_RELATIONS | set(args.allow_relation),
    )

    error_count = 0
    warning_count = 0
    for issue in issues:
        if issue.level == "warning":
            warning_count += 1
        else:
            error_count += 1
        print(f"{issue.level.upper()}: {issue.path}: {issue.message}", file=sys.stderr)

    if args.strict and warning_count:
        error_count += warning_count
    if error_count:
        print(f"[fail] {error_count} error(s), {warning_count} warning(s)", file=sys.stderr)
        return 1

    print(f"[ok] graph validated with {warning_count} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
