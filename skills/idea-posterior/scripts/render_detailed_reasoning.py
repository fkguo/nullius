#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "nh3==0.3.6",
# ]
# ///
"""Render Gaia's detailed-reasoning Markdown as safe standalone HTML.

The renderer is deliberately package-centric and reusable after a human edits
``docs/detailed-reasoning.md``.  It parses Markdown with Pandoc, renders each
Pandoc ``mermaid`` code block through Mermaid CLI, emits MathML, sanitizes the
HTML with pinned nh3/Ammonia, and publishes two files atomically:

* ``docs/detailed-reasoning.html`` -- a script-free, self-contained page;
* ``docs/detailed-reasoning.manifest.json`` -- exact SHA-256 bindings for the
  current beliefs, compiled IR, Markdown, and HTML bytes.

The manifest is installed last. Missing dependencies or any failed stage
invalidates the manifest and withholds the page; callers must never fabricate
the sidecar. The argument-graph renderer independently rehashes all four
inputs before it emits a deep-dive link.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from html.parser import HTMLParser
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from urllib.parse import unquote, urlsplit

from idea_package_contract import (
    audit_evidence_families,
    load_compiled_ir,
    require_authored_infer_rationales,
    require_unique_exported_root,
)

ARTIFACT = "detailed_reasoning_html_binding_v2"
NH3_PIN = "0.3.6"
HELPER_LABEL_PREFIXES = ("__", "_anon")
HTML_NAME = "detailed-reasoning.html"
MANIFEST_NAME = "detailed-reasoning.manifest.json"
MARKDOWN_NAME = "detailed-reasoning.md"
LEGACY_STAMP_NAME = "detailed-reasoning.beliefs-sha256"

INSTALL_HINT = (
    "Run this PEP 723 script with `uv run --script`; uv provisions pinned "
    f"nh3=={NH3_PIN} automatically. Install the optional host presentation "
    "tools Pandoc and Mermaid CLI (`mmdc`). Presentation does not gate "
    "posterior extraction."
)

_PORTABILITY_PATTERNS = (
    (re.compile(r"(?i)file://"), "file URI"),
    (
        re.compile(
            r"(?i)(?:/"
            r"Users/[^/\s]+|/home/[^/\s]+|/tmp|/private/tmp|"
            r"/var/tmp|/var/folders|/private/var/folders)(?:/|\b)"
        ),
        "machine-local home or temporary path",
    ),
    (
        re.compile(r"(?i)\b[A-Z]:[\\/](?:Users|Temp)[\\/]"),
        "machine-local Windows path",
    ),
    (
        re.compile(
            r"(?i)(?:/opt(?:/homebrew)?|/usr(?:/local)?)/[^\s\"'<>]*"
            r"/(?:pandoc|mmdc)(?:\b|$)"
        ),
        "resolved presentation-tool path",
    ),
)


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def portability_violation(text: str) -> str | None:
    """Return the first forbidden persisted-path class, if any."""
    for pattern, description in _PORTABILITY_PATTERNS:
        if pattern.search(text):
            return description
    return None


def _resolve_tool(cli_value: str | None, env_name: str, command: str) -> str:
    candidate = cli_value or os.environ.get(env_name) or shutil.which(command)
    if not candidate:
        raise RuntimeError(f"no `{command}` executable found. {INSTALL_HINT}")
    return candidate


def _run(
    cmd: list[str],
    *,
    input_bytes: bytes | None = None,
    timeout: int,
) -> bytes:
    try:
        result = subprocess.run(
            cmd,
            input=input_bytes,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"could not run {Path(cmd[0]).name}: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace")
        tail = detail.strip().splitlines()
        raise RuntimeError(
            f"{Path(cmd[0]).name} failed: "
            f"{tail[-1] if tail else f'exit {result.returncode}'}"
        )
    return result.stdout


_VERSION_TOKEN = re.compile(r"(?<![A-Za-z0-9])v?(\d+\.\d+\.\d+(?:[-+.]?[A-Za-z0-9]+)*)")


def _tool_version(tool: str, tool_name: str, timeout: int) -> str:
    output = _run([tool, "--version"], timeout=timeout)
    lines = output.decode("utf-8", errors="replace").strip().splitlines()
    if not lines:
        raise RuntimeError(f"{Path(tool).name} --version returned no version")
    matches = list(_VERSION_TOKEN.finditer(lines[0]))
    if not matches:
        raise RuntimeError(
            f"{tool_name} --version returned an unrecognized version banner"
        )
    # Persist only a normalized token under a fixed manifest key. Wrapper
    # banners may contain arbitrary resolved executable paths.
    return matches[-1].group(1)


def _load_labels(ir_bytes: bytes) -> set[str]:
    try:
        ir = json.loads(ir_bytes)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"unreadable .gaia/ir.json: {exc}") from exc
    labels = {
        str(item.get("label") or "")
        for item in ir.get("knowledges", [])
        if item.get("label")
    }
    return {label for label in labels if not label.startswith(HELPER_LABEL_PREFIXES)}


def _quote_markdown(text: str) -> str:
    """Render authored Markdown as a contained quotation block."""
    normalized = text.strip() or "(no statement recorded)"
    return "\n".join("> " + line if line else ">" for line in normalized.splitlines())


def _rationale_parts(text: str) -> tuple[str, str]:
    marker = text.find("anchor:")
    if marker < 0:
        rationale, anchor = text.strip(), ""
    else:
        rationale = text[:marker].strip()
        anchor = text[marker + len("anchor:") :].strip()
    rationale = re.sub(
        r"^reader_reasoning:\s*", "", rationale, count=1
    ).strip()
    return rationale, anchor


def _likelihood_effect(p_h: float, p_nh: float) -> tuple[str, str, float]:
    ratio = p_h / p_nh if p_nh > 0 else float("inf")
    if abs(ratio - 1.0) < 1e-12:
        return "does not move", "neutral", ratio
    magnitude = ratio if ratio > 1.0 else (1.0 / ratio if ratio > 0 else float("inf"))
    if math.isfinite(magnitude):
        grade = min(
            ((3.0, "weak"), (10.0, "substantial"), (30.0, "strong")),
            key=lambda item: abs(item[0] - magnitude),
        )[1]
    else:
        grade = "strong"
    factor = f"{magnitude:.2g}"
    if ratio > 1.0:
        return "raises", f"{grade}, likelihood ratio ×{factor}", ratio
    return "lowers", f"{grade}, likelihood ratio ÷{factor}", ratio


def _path_polarity(edges: list["_ReaderEdge"]) -> str:
    """Return direction only; local likelihood ratios are not composable BFs."""
    lowering_edges = 0
    for edge in edges:
        if abs(edge.p_h - edge.p_nh) < 1e-12:
            return "neutral"
        if edge.p_h < edge.p_nh:
            lowering_edges += 1
    return "lowering" if lowering_edges % 2 else "supporting"


@dataclass(frozen=True)
class _ReaderEdge:
    source: str
    target: str
    p_h: float
    p_nh: float
    rationale: str
    strategy_id: str


def _reader_reasoning_markdown(ir: dict) -> str:
    """Build an evidence-first reading surface from authored IR content.

    Gaia stores infer relations in generative direction. This view inverts
    them exactly once and follows recorded observations through authored
    likelihood rationales into the unique exported conclusion.
    """
    root = require_unique_exported_root(ir)
    require_authored_infer_rationales(ir)
    family_records = audit_evidence_families(ir)
    root_id = str(root["id"])
    knowledges = {
        str(item["id"]): item
        for item in ir.get("knowledges", [])
        if isinstance(item, dict) and item.get("id")
    }
    observed_ids = []
    for kid, item in knowledges.items():
        metadata = item.get("metadata") or {}
        supports = metadata.get("supported_by") or []
        if any(
            isinstance(support, dict) and support.get("pattern") == "observation"
            for support in supports
        ):
            observed_ids.append(kid)

    def declaration_index(item: dict) -> int:
        try:
            return int(item.get("declaration_index", 0))
        except (TypeError, ValueError):
            return 0

    outgoing: dict[str, list[_ReaderEdge]] = {kid: [] for kid in knowledges}
    for index, strategy in enumerate(ir.get("strategies", [])):
        if not isinstance(strategy, dict) or strategy.get("type") != "infer":
            continue
        premises = strategy.get("premises") or []
        probabilities = strategy.get("conditional_probabilities") or []
        evidence = strategy.get("conclusion")
        if (
            len(premises) != 1
            or len(probabilities) != 2
            or evidence not in knowledges
            or premises[0] not in knowledges
        ):
            continue
        rationale = " ".join(
            str(step.get("reasoning") or "").strip()
            for step in strategy.get("steps", [])
            if isinstance(step, dict) and str(step.get("reasoning") or "").strip()
        )
        outgoing[evidence].append(
            _ReaderEdge(
                source=str(evidence),
                target=str(premises[0]),
                p_h=float(probabilities[1]),
                p_nh=float(probabilities[0]),
                rationale=rationale,
                strategy_id=str(strategy.get("strategy_id") or f"infer-{index}"),
            )
        )
    for edges in outgoing.values():
        edges.sort(
            key=lambda edge: (
                declaration_index(knowledges[edge.target]),
                edge.strategy_id,
            )
        )

    paths: list[tuple[str, list[_ReaderEdge]]] = []

    def walk(source_id: str, current: str, edges: list[_ReaderEdge], seen: set[str]) -> None:
        if current == root_id:
            paths.append((source_id, list(edges)))
            if len(paths) > 1000:
                raise RuntimeError(
                    "reader reasoning view exceeds 1000 evidence-to-conclusion paths"
                )
            return
        for edge in outgoing.get(current, []):
            if edge.target in seen:
                raise RuntimeError("reader evidence-flow graph contains a cycle")
            walk(source_id, edge.target, [*edges, edge], {*seen, edge.target})

    observed_ids.sort(
        key=lambda kid: (declaration_index(knowledges[kid]), kid)
    )
    for source_id in observed_ids:
        walk(source_id, source_id, [], {source_id})

    lowering = []
    supporting = []
    neutral = []
    for path in paths:
        polarity = _path_polarity(path[1])
        if polarity == "lowering":
            lowering.append(path)
        elif polarity == "supporting":
            supporting.append(path)
        else:
            neutral.append(path)

    lines = [
        "# Evidence-to-conclusion reasoning",
        "",
        "Read these chains from concrete recorded evidence to the exported conclusion. "
        "Each intermediate statement is a structural criterion or claim; it is not the "
        "explanation. The explanation is the authored likelihood rationale shown at each "
        "update. Lowering evidence is listed before supporting evidence.",
        "",
    ]

    if family_records:
        lines.extend(
            [
                "## Evidence-family accounting",
                "",
                "Evidence-family identifiers disclose shared provenance. Gaia "
                "0.5.0a4 multiplies separate likelihood factors, so at most one "
                "observation from a family may lie on a path to the exported "
                "conclusion. Correlated material is represented by one composite "
                "observation and one likelihood update; any repeated occurrences "
                "shown here are disconnected source notes and do not change "
                "the posterior.",
                "",
            ]
        )
        families: dict[str, list[dict]] = {}
        for record in family_records.values():
            families.setdefault(record["family"], []).append(record)
        for family in sorted(families):
            records = families[family]
            model = records[0]["correlation_model"]
            lines.append(
                f"- `{family}`: {len(records)} recorded observation(s); "
                f"correlation model `{model}`."
            )
        lines.append("")

    def append_group(title: str, group: list[tuple[str, list[_ReaderEdge]]]) -> None:
        lines.extend([f"## {title}", ""])
        if not group:
            lines.extend(["No such evidence-to-conclusion path is recorded.", ""])
            return
        for path_index, (source_id, edges) in enumerate(group, 1):
            source = knowledges[source_id]
            path_polarity = _path_polarity(edges)
            lines.extend(
                [
                    f"### {title[:-1]} {path_index}",
                    "",
                    f"**Local path polarity:** {path_polarity}. This is direction "
                    "only; local likelihood ratios are not multiplied into an "
                    "end-to-end Bayes factor or a global posterior update.",
                    "",
                    "#### Step 1 — recorded evidence",
                    "",
                    _quote_markdown(str(source.get("content") or "")),
                    "",
                ]
            )
            supports = (source.get("metadata") or {}).get("supported_by") or []
            observation_notes = [
                str(item.get("rationale") or "")
                for item in supports
                if isinstance(item, dict) and item.get("pattern") == "observation"
            ]
            if observation_notes:
                lines.extend(
                    [
                        "**Observation record**",
                        "",
                        _quote_markdown(" ".join(observation_notes)),
                        "",
                    ]
                )
            family_record = family_records.get(source_id)
            if family_record:
                lines.extend(
                    [
                        "**Evidence-family declaration**",
                        "",
                        _quote_markdown(
                            f"{family_record['family']}; correlation model "
                            f"{family_record['correlation_model']}; reused by "
                            f"{family_record['reuse_count']} recorded observation(s)."
                        ),
                        "",
                    ]
                )
            for step_index, edge in enumerate(edges, 2):
                target = knowledges[edge.target]
                direction, strength, _ = _likelihood_effect(edge.p_h, edge.p_nh)
                metadata = target.get("metadata") or {}
                reader_role = metadata.get("reader_role")
                if edge.target == root_id:
                    target_role = "exported conclusion"
                elif reader_role == "criterion":
                    target_role = "structural criterion"
                else:
                    target_role = "intermediate criterion or claim"
                rationale, anchors = _rationale_parts(edge.rationale)
                lines.extend(
                    [
                        f"#### Step {step_index} — {target_role} update",
                        "",
                        _quote_markdown(str(target.get("content") or "")),
                        "",
                        f"**Likelihood effect:** {direction} ({strength}).",
                        "",
                        "**Authored likelihood rationale**",
                        "",
                        _quote_markdown(
                            rationale or "No authored likelihood rationale is recorded."
                        ),
                        "",
                    ]
                )
                if anchors:
                    lines.extend(
                        ["**Source anchor**", "", _quote_markdown(anchors), ""]
                    )

    append_group("Lowering paths", lowering)
    append_group("Supporting paths", supporting)
    if neutral:
        append_group("Neutral paths", neutral)
    connected = {source_id for source_id, _edges in paths}
    unconnected = [kid for kid in observed_ids if kid not in connected]
    if unconnected:
        lines.extend(["## Recorded evidence outside the exported conclusion", ""])
        for kid in unconnected:
            lines.extend([_quote_markdown(str(knowledges[kid].get("content") or "")), ""])

    lines.extend(
        [
            "# Gaia model details",
            "",
            "The material below is Gaia's raw model report. Criterion statements are "
            "structural hypotheses, not explanations. Any raw Gaia graph is a "
            "generative probability-model graph: its arrows run from a hypothesis to "
            "possible evidence. That arrow direction is not the reader's evidence "
            "flow; use the evidence-to-conclusion chains above for that reading.",
            "",
        ]
    )
    return "\n".join(lines)


def _inline_text(value) -> str:
    if isinstance(value, list):
        return "".join(_inline_text(item) for item in value)
    if not isinstance(value, dict):
        return ""
    kind = value.get("t")
    content = value.get("c")
    if kind == "Str":
        return str(content)
    if kind in {"Space", "SoftBreak", "LineBreak"}:
        return " "
    if kind == "Code" and isinstance(content, list) and len(content) == 2:
        return str(content[1])
    if kind == "Math" and isinstance(content, list) and len(content) == 2:
        return str(content[1])
    return _inline_text(content)


def _text_inlines(text: str) -> list[dict]:
    words = text.split()
    result: list[dict] = []
    for index, word in enumerate(words):
        if index:
            result.append({"t": "Space"})
        result.append({"t": "Str", "c": word})
    return result


def _label_mermaid_direction(document: dict) -> None:
    """Attach an explicit generative-direction label to every raw diagram."""
    blocks = document.get("blocks")
    if not isinstance(blocks, list):
        return
    output = []
    for block in blocks:
        if isinstance(block, dict) and block.get("t") == "CodeBlock":
            content = block.get("c") or []
            attrs = content[0] if len(content) == 2 else []
            classes = set(
                attrs[1] if isinstance(attrs, list) and len(attrs) == 3 else []
            )
            if "mermaid" in classes:
                output.extend(
                    [
                        {
                            "t": "Header",
                            "c": [
                                4,
                                ["", [], []],
                                _text_inlines(
                                    "Raw Gaia generative probability-model graph"
                                ),
                            ],
                        },
                        {
                            "t": "Para",
                            "c": _text_inlines(
                                "Arrows run from a hypothesis to possible evidence. "
                                "They do not show the reader's evidence flow."
                            ),
                        },
                    ]
                )
        output.append(block)
    document["blocks"] = output


class _ExactAnchorProbe(HTMLParser):
    """Recognize one empty ``a`` element carrying only an ``id``."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchor_id: str | None = None
        self.opened = False
        self.closed = False
        self.invalid = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if self.opened or tag.lower() != "a" or len(attrs) != 1:
            self.invalid = True
            return
        name, value = attrs[0]
        if name.lower() != "id" or not value:
            self.invalid = True
            return
        self.opened = True
        self.anchor_id = value

    def handle_startendtag(self, tag: str, attrs) -> None:
        self.handle_starttag(tag, attrs)
        self.closed = self.opened and not self.invalid

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a" or not self.opened or self.closed:
            self.invalid = True
            return
        self.closed = True

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.invalid = True

    def handle_comment(self, _data: str) -> None:
        self.invalid = True

    def handle_decl(self, _decl: str) -> None:
        self.invalid = True


def _explicit_anchor_id(block: dict) -> str | None:
    raw = ""
    kind = block.get("t")
    content = block.get("c")
    if kind in {"Para", "Plain"} and isinstance(content, list) and content:
        pieces = []
        for inline in content:
            if not isinstance(inline, dict) or inline.get("t") != "RawInline":
                return None
            raw_content = inline.get("c")
            if (
                not isinstance(raw_content, list)
                or len(raw_content) != 2
                or raw_content[0] != "html"
            ):
                return None
            pieces.append(str(raw_content[1]))
        raw = "".join(pieces)
    elif (
        kind == "RawBlock"
        and isinstance(content, list)
        and len(content) == 2
        and content[0] == "html"
    ):
        raw = str(content[1])
    else:
        return None

    probe = _ExactAnchorProbe()
    probe.feed(raw)
    probe.close()
    if probe.invalid or not probe.opened or not probe.closed:
        return None
    return probe.anchor_id


def _heading_label(block: dict) -> str | None:
    if block.get("t") != "Header":
        return None
    content = block.get("c") or []
    if len(content) != 3:
        return None
    heading = _inline_text(content[2]).strip()
    if heading.endswith("★"):
        heading = heading[:-1].rstrip()
    return heading


def _assign_exact_fragment_ids(document: dict, labels: set[str]) -> set[str]:
    """Bind fragments only through Gaia's explicit preceding anchor.

    Gaia repeats the exported root in its introduction, but only the canonical
    node section has an explicit case-preserving ``<a id=...></a>`` immediately
    before its heading. A label is installed only when exactly one such anchor
    occurs and its adjacent heading text matches. Missing, duplicated, or
    mismatched anchors fail closed; later human headings with the same text do
    not move the deep-dive target.
    """
    blocks = document.get("blocks", [])
    if not isinstance(blocks, list):
        return set()
    occurrences: dict[str, list[dict | None]] = {label: [] for label in labels}
    all_headers = [
        block
        for block in blocks
        if isinstance(block, dict) and block.get("t") == "Header"
    ]
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            continue
        anchor_id = _explicit_anchor_id(block)
        if anchor_id not in occurrences:
            continue
        adjacent = blocks[index + 1] if index + 1 < len(blocks) else None
        if isinstance(adjacent, dict) and _heading_label(adjacent) == anchor_id:
            occurrences[anchor_id].append(adjacent)
        else:
            occurrences[anchor_id].append(None)

    installed: set[str] = set()
    for label, candidates in occurrences.items():
        if len(candidates) != 1 or candidates[0] is None:
            continue
        heading = candidates[0]
        if any(
            other is not heading
            and isinstance(other.get("c"), list)
            and len(other["c"]) == 3
            and isinstance(other["c"][1], list)
            and bool(other["c"][1])
            and other["c"][1][0] == label
            for other in all_headers
        ):
            continue
        heading["c"][1][0] = label
        installed.add(label)
    return installed


def _safe_link(target: str) -> bool:
    if not target or any(ord(ch) < 32 for ch in target):
        return False
    if "\\" in target or target.startswith("//"):
        return False
    parsed = urlsplit(target)
    if parsed.scheme:
        return parsed.scheme.lower() in {"http", "https", "mailto"}
    # Relative links and same-document fragments remain useful under file://.
    decoded_path = unquote(parsed.path)
    if "\\" in decoded_path or any(
        segment in {".", ".."} for segment in decoded_path.split("/")
    ):
        return False
    return not target.startswith("/") and portability_violation(target) is None


@dataclass
class _Splice:
    values: list


_DROP = object()


def _sequence(values: list, transform) -> list:
    output = []
    for value in values:
        cleaned = transform(value)
        if cleaned is _DROP:
            continue
        if isinstance(cleaned, _Splice):
            output.extend(cleaned.values)
        else:
            output.append(cleaned)
    return output


def _render_mermaid(
    source: str,
    *,
    mmdc: str,
    config_path: Path,
    index: int,
    timeout: int,
) -> str:
    svg = _run(
        [
            mmdc,
            "--quiet",
            "--input",
            "-",
            "--output",
            "-",
            "--outputFormat",
            "svg",
            "--configFile",
            str(config_path),
            "--svgId",
            f"detailed-mermaid-{index}",
        ],
        input_bytes=source.encode("utf-8"),
        timeout=timeout,
    )
    if b"javascript:" in svg.lower():
        raise RuntimeError("mmdc returned active content under strict security")
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise RuntimeError("mmdc returned malformed SVG") from exc
    if root.tag.rsplit("}", 1)[-1].lower() != "svg":
        raise RuntimeError("mmdc returned success without an SVG")
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1].lower() == "script":
            raise RuntimeError("mmdc returned active content under strict security")
        for raw_name, raw_value in element.attrib.items():
            name = raw_name.rsplit("}", 1)[-1].lower()
            if name.startswith("on") or "javascript:" in raw_value.lower():
                raise RuntimeError("mmdc returned active content under strict security")
    return "data:image/svg+xml;base64," + base64.b64encode(svg).decode("ascii")


def _transform_document(
    document: dict,
    *,
    mmdc: str,
    config_path: Path,
    timeout: int,
) -> tuple[dict, set[str]]:
    """Strip raw HTML, neutralize unsafe resources, and render Mermaid."""
    trusted_images: set[str] = set()
    diagram_index = 0

    def transform(value):
        nonlocal diagram_index
        if isinstance(value, list):
            return _sequence(value, transform)
        if not isinstance(value, dict):
            return value
        kind = value.get("t")
        content = value.get("c")
        if kind in {"RawBlock", "RawInline"}:
            return _DROP
        if kind == "CodeBlock" and isinstance(content, list) and len(content) == 2:
            attrs, source = content
            classes = set(
                attrs[1] if isinstance(attrs, list) and len(attrs) == 3 else []
            )
            if "mermaid" in classes:
                uri = _render_mermaid(
                    str(source),
                    mmdc=mmdc,
                    config_path=config_path,
                    index=diagram_index,
                    timeout=timeout,
                )
                diagram_index += 1
                trusted_images.add(uri)
                return {
                    "t": "Para",
                    "c": [
                        {
                            "t": "Image",
                            "c": [
                                ["", ["mermaid-diagram"], []],
                                [{"t": "Str", "c": "Knowledge graph"}],
                                [uri, ""],
                            ],
                        }
                    ],
                }
        if kind == "Link" and isinstance(content, list) and len(content) == 3:
            attrs, inlines, target = content
            clean_inlines = _sequence(inlines, transform)
            href = str(target[0]) if isinstance(target, list) and target else ""
            if not _safe_link(href):
                return _Splice(clean_inlines)
            value["c"] = [[attrs[0], attrs[1], []], clean_inlines, target]
            return value
        if kind == "Image" and isinstance(content, list) and len(content) == 3:
            attrs, alt, target = content
            clean_alt = _sequence(alt, transform)
            src = str(target[0]) if isinstance(target, list) and target else ""
            if src not in trusted_images:
                return _Splice(clean_alt)
            value["c"] = [[attrs[0], attrs[1], []], clean_alt, target]
            return value
        if isinstance(content, list):
            value["c"] = _sequence(content, transform)
        elif isinstance(content, dict):
            value["c"] = transform(content)
        if kind in {"Para", "Plain"} and not value.get("c"):
            return _DROP
        return value

    document["blocks"] = _sequence(document.get("blocks", []), transform)
    return document, trusted_images


_HTML_TAGS = {
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "samp",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
}
_MATHML_TAGS = {
    "annotation",
    "annotation-xml",
    "maction",
    "math",
    "menclose",
    "merror",
    "mfenced",
    "mfrac",
    "mglyph",
    "mi",
    "mlabeledtr",
    "mmultiscripts",
    "mn",
    "mo",
    "mover",
    "mpadded",
    "mphantom",
    "mprescripts",
    "mroot",
    "mrow",
    "ms",
    "mspace",
    "msqrt",
    "mstyle",
    "msub",
    "msubsup",
    "msup",
    "mtable",
    "mtd",
    "mtext",
    "mtr",
    "munder",
    "munderover",
    "none",
    "semantics",
}
_MATHML_ATTRS = {
    "accent",
    "accentunder",
    "bevelled",
    "close",
    "columnalign",
    "columnspacing",
    "displaystyle",
    "display",
    "encoding",
    "fence",
    "linethickness",
    "lspace",
    "mathvariant",
    "notation",
    "open",
    "rowalign",
    "rowspacing",
    "rspace",
    "scriptlevel",
    "separators",
    "stretchy",
    "xmlns",
}


def _sanitize_html(fragment: str, trusted_images: set[str]) -> str:
    try:
        import nh3
    except ImportError as exc:
        raise RuntimeError(
            f"Python package nh3=={NH3_PIN} is required. {INSTALL_HINT}"
        ) from exc
    try:
        installed = package_version("nh3")
    except PackageNotFoundError as exc:
        raise RuntimeError(
            f"Python package nh3=={NH3_PIN} is required. {INSTALL_HINT}"
        ) from exc
    if installed != NH3_PIN:
        raise RuntimeError(
            f"nh3 version mismatch: expected {NH3_PIN}, got {installed}. "
            + INSTALL_HINT
        )

    def filter_attribute(tag: str, name: str, value: str) -> str | None:
        tag = tag.lower()
        name = name.lower()
        if name.startswith("on") or name == "style":
            return None
        if name in {"role", "aria-label"}:
            return value if tag == "img" else None
        if tag == "a" and name == "href":
            return value if _safe_link(value) else None
        if tag == "img" and name == "src":
            return value if value in trusted_images else None
        return value

    attributes = {
        "*": {"id", "class", "title", "lang", "dir"},
        "a": {"href"},
        "img": {"src", "alt", "width", "height", "role", "aria-label"},
        "td": {"colspan", "rowspan", "scope"},
        "th": {"colspan", "rowspan", "scope"},
    }
    for tag in _MATHML_TAGS:
        attributes[tag] = set(_MATHML_ATTRS)

    return nh3.clean(
        fragment,
        tags=_HTML_TAGS | _MATHML_TAGS,
        clean_content_tags={"script", "style", "iframe", "object", "embed"},
        attributes=attributes,
        attribute_filter=filter_attribute,
        url_schemes={"http", "https", "mailto", "data"},
        strip_comments=True,
        link_rel="noopener noreferrer",
    )


class _IdCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: set[str] = set()

    def handle_starttag(self, _tag: str, attrs) -> None:
        for name, value in attrs:
            if name == "id" and value:
                self.ids.add(value)


_PAGE_CSS = """
:root { color-scheme: light dark; --bg:#f6f8fb; --paper:#fff; --ink:#17202a; --muted:#5f6b7a; --line:#d9e0e8; --link:#1261a0; }
@media (prefers-color-scheme: dark) { :root { --bg:#11161d; --paper:#18212b; --ink:#e8edf2; --muted:#aeb8c4; --line:#354250; --link:#7dc4ff; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.62 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
main { width:min(100% - 2rem, 980px); margin:2rem auto; padding:clamp(1.25rem,3vw,3rem); background:var(--paper); border:1px solid var(--line); border-radius:14px; box-shadow:0 12px 35px rgb(0 0 0 / .08); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; scroll-margin-top:1rem; }
h2 { margin-top:2.4rem; border-bottom:1px solid var(--line); padding-bottom:.35rem; }
a { color:var(--link); text-underline-offset:.16em; }
blockquote { margin:1rem 0; padding:.25rem 1rem; border-left:4px solid var(--line); color:var(--muted); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { overflow:auto; padding:1rem; background:var(--bg); border:1px solid var(--line); border-radius:8px; }
table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }
th,td { padding:.45rem .65rem; border:1px solid var(--line); text-align:left; }
img.mermaid-diagram { display:block; width:100%; height:auto; margin:1.25rem auto; background:#fff; border:1px solid var(--line); border-radius:10px; }
math[display="block"] { display:block; overflow-x:auto; margin:1rem 0; }
""".strip()


def _page(
    *,
    title: str,
    body: str,
) -> bytes:
    content = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<title>{html.escape(title)}</title>
<style>{_PAGE_CSS}</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>
"""
    return content.encode("utf-8")


def _unlink(path: Path, description: str) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(
            f"warning: could not remove {description} {path.name}: {exc}",
            file=sys.stderr,
        )


def _contained_docs_dir(package: Path, *, create: bool) -> Path | None:
    """Return a real docs directory inside package, never a symlink target."""
    candidate = package / "docs"
    if candidate.is_symlink():
        raise RuntimeError("refusing an indirect package docs directory")
    if not candidate.exists():
        if not create:
            return None
        candidate.mkdir(parents=False)
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(package)
    except (OSError, ValueError) as exc:
        raise RuntimeError("package docs directory escapes the package") from exc
    if not resolved.is_dir():
        raise RuntimeError("package docs path is not a directory")
    return resolved


def _invalidate(docs_dir: Path, package: Path) -> None:
    try:
        docs_dir.resolve(strict=True).relative_to(package)
    except (OSError, ValueError) as exc:
        raise RuntimeError("refusing to invalidate an escaping docs directory") from exc
    # Authority disappears first; a surviving page can never authorize itself.
    for name in (
        MANIFEST_NAME,
        MANIFEST_NAME + ".tmp",
        HTML_NAME,
        HTML_NAME + ".tmp",
        LEGACY_STAMP_NAME,
    ):
        _unlink(docs_dir / name, "stale")


def render_package(
    package_dir: Path,
    *,
    pandoc_bin: str | None = None,
    mmdc_bin: str | None = None,
    timeout: int = 120,
) -> tuple[Path, Path]:
    package = package_dir.resolve(strict=True)
    docs = _contained_docs_dir(package, create=True)
    assert docs is not None
    _invalidate(docs, package)

    markdown_path = docs / MARKDOWN_NAME
    beliefs_path = package / ".gaia" / "beliefs.json"
    ir_path = package / ".gaia" / "ir.json"
    for path, name in (
        (markdown_path, "fresh detailed-reasoning Markdown"),
        (beliefs_path, "current beliefs"),
        (ir_path, "current compiled IR"),
    ):
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(package)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"missing or escaping {name}: {path.name}") from exc
        if not resolved.is_file():
            raise RuntimeError(f"missing {name}: {path.name}")

    markdown_bytes = markdown_path.read_bytes()
    beliefs_bytes = beliefs_path.read_bytes()
    ir_bytes = ir_path.read_bytes()
    try:
        markdown_text = markdown_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError(f"{MARKDOWN_NAME} is not UTF-8: {exc}") from exc
    violation = portability_violation(markdown_text)
    if violation:
        raise RuntimeError(
            f"{MARKDOWN_NAME} contains a {violation}; portable docs are required"
        )

    pandoc = _resolve_tool(pandoc_bin, "PANDOC_BIN", "pandoc")
    mmdc = _resolve_tool(mmdc_bin, "MMDC_BIN", "mmdc")
    pandoc_version = _tool_version(pandoc, "Pandoc", timeout)
    mmdc_version = _tool_version(mmdc, "Mermaid CLI", timeout)
    beliefs_sha = sha256_bytes(beliefs_bytes)
    ir_sha = sha256_bytes(ir_bytes)
    markdown_sha = sha256_bytes(markdown_bytes)
    labels = _load_labels(ir_bytes)
    ir = load_compiled_ir(ir_bytes)
    require_unique_exported_root(ir)
    require_authored_infer_rationales(ir)
    audit_evidence_families(ir)
    reader_markdown = _reader_reasoning_markdown(ir).encode("utf-8")

    with tempfile.TemporaryDirectory(prefix=".detailed-render-", dir=docs) as tmp_name:
        tmp = Path(tmp_name)
        config = tmp / "mermaid-config.json"
        config.write_text(
            json.dumps(
                {
                    "securityLevel": "strict",
                    "htmlLabels": False,
                    "deterministicIds": True,
                    "deterministicIDSeed": markdown_sha,
                    "flowchart": {"htmlLabels": False},
                    "secure": [
                        "secure",
                        "securityLevel",
                        "htmlLabels",
                        "flowchart",
                        "themeCSS",
                        "deterministicIds",
                        "deterministicIDSeed",
                    ],
                },
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        ast_bytes = _run(
            [pandoc, "--from=gfm", "--to=json", "--fail-if-warnings"],
            input_bytes=reader_markdown + b"\n\n" + markdown_bytes,
            timeout=timeout,
        )
        try:
            document = json.loads(ast_bytes)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Pandoc returned invalid JSON AST: {exc}") from exc
        expected_fragments = _assign_exact_fragment_ids(document, labels)
        _label_mermaid_direction(document)
        document, trusted_images = _transform_document(
            document,
            mmdc=mmdc,
            config_path=config,
            timeout=timeout,
        )
        body_raw = _run(
            [
                pandoc,
                "--from=json",
                "--to=html5",
                "--mathml",
                "--sandbox",
                "--strip-comments",
                "--fail-if-warnings",
            ],
            input_bytes=json.dumps(document, ensure_ascii=False).encode("utf-8"),
            timeout=timeout,
        ).decode("utf-8")
        body = _sanitize_html(body_raw, trusted_images)
        collector = _IdCollector()
        collector.feed(body)
        fragments = sorted(expected_fragments & collector.ids)

        html_bytes = _page(
            title=f"{package.name} detailed reasoning",
            body=body,
        )
        rendered_text = html_bytes.decode("utf-8")
        violation = portability_violation(rendered_text)
        if violation:
            raise RuntimeError(f"generated HTML contains a {violation}")
        html_sha = sha256_bytes(html_bytes)
        manifest = {
            "artifact": ARTIFACT,
            "beliefs_sha256": beliefs_sha,
            "fragments": fragments,
            "html_sha256": html_sha,
            "ir_sha256": ir_sha,
            "markdown_sha256": markdown_sha,
            "renderer": {
                "nh3": NH3_PIN,
                "mermaid_cli": mmdc_version,
                "pandoc": pandoc_version,
            },
        }
        manifest_bytes = (
            json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        ).encode("utf-8")
        violation = portability_violation(manifest_bytes.decode("utf-8"))
        if violation:
            raise RuntimeError(f"generated manifest contains a {violation}")

        # Re-read both inputs immediately before publication; an edit racing
        # the renderer must produce no authoritative sidecar.
        if sha256_bytes(beliefs_path.read_bytes()) != beliefs_sha:
            raise RuntimeError("beliefs changed during detailed-page rendering")
        if sha256_bytes(ir_path.read_bytes()) != ir_sha:
            raise RuntimeError("compiled IR changed during detailed-page rendering")
        if sha256_bytes(markdown_path.read_bytes()) != markdown_sha:
            raise RuntimeError("Markdown changed during detailed-page rendering")

        html_tmp = tmp / HTML_NAME
        manifest_tmp = tmp / MANIFEST_NAME
        html_tmp.write_bytes(html_bytes)
        manifest_tmp.write_bytes(manifest_bytes)
        html_path = docs / HTML_NAME
        manifest_path = docs / MANIFEST_NAME
        html_tmp.replace(html_path)
        # Publish authority last. A crash before this rename leaves an
        # unverifiable page, never a falsely current one.
        manifest_tmp.replace(manifest_path)

        # A source edit detected immediately after publication invalidates
        # both outputs. No finite sequence of filesystem reads can prevent a
        # later edit, so every consumer also rechecks all four hashes.
        if (
            sha256_bytes(beliefs_path.read_bytes()) != beliefs_sha
            or sha256_bytes(ir_path.read_bytes()) != ir_sha
            or sha256_bytes(markdown_path.read_bytes()) != markdown_sha
        ):
            _invalidate(docs, package)
            raise RuntimeError(
                "detailed-page inputs changed at publication; outputs invalidated"
            )

    return docs / HTML_NAME, docs / MANIFEST_NAME


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, help="Gaia package directory")
    parser.add_argument(
        "--pandoc-bin",
        default=None,
        help="Pandoc executable (default: $PANDOC_BIN, then PATH)",
    )
    parser.add_argument(
        "--mmdc-bin",
        default=None,
        help="Mermaid CLI executable (default: $MMDC_BIN, then PATH)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="timeout per external render stage in seconds (default: 120)",
    )
    args = parser.parse_args(argv)
    package = Path(args.package)
    if not package.is_dir():
        sys.stderr.write(f"error: package directory not found: {package}\n")
        return 2
    try:
        html_path, manifest_path = render_package(
            package,
            pandoc_bin=args.pandoc_bin,
            mmdc_bin=args.mmdc_bin,
            timeout=args.timeout,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        # Invalidate again in case the failure landed between the HTML rename
        # and the manifest rename. An unremovable survivor still cannot pass
        # the graph's independent four-hash verification.
        try:
            docs = _contained_docs_dir(package.resolve(), create=False)
            if docs is not None:
                _invalidate(docs, package.resolve())
        except (OSError, RuntimeError, ValueError) as cleanup_exc:
            sys.stderr.write(f"warning: detailed-page cleanup skipped: {cleanup_exc}\n")
        sys.stderr.write(f"error: detailed reasoning HTML not published: {exc}\n")
        return 2
    sys.stderr.write(
        f"ok: detailed reasoning HTML -> {html_path.name} "
        f"(binding: {manifest_path.name})\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
