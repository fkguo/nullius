#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SchemaValidationError(Exception):
    path: str
    message: str

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.path}: {self.message}"


def _resolve_ref(root_schema: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise SchemaValidationError(path="$schema", message=f"Unsupported $ref: {ref!r}")
    node: Any = root_schema
    for part in ref.removeprefix("#/").split("/"):
        if not isinstance(node, dict) or part not in node:
            raise SchemaValidationError(path="$schema", message=f"Unresolvable $ref: {ref!r}")
        node = node[part]
    if not isinstance(node, dict):
        raise SchemaValidationError(path="$schema", message=f"$ref target is not a schema object: {ref!r}")
    return node


def _validate_json_schema_subset(instance: Any, schema: dict[str, Any], root_schema: dict[str, Any], path: str) -> None:
    if "$ref" in schema:
        schema = _resolve_ref(root_schema, schema["$ref"])

    if "const" in schema and instance != schema["const"]:
        raise SchemaValidationError(path=path, message=f"Expected const {schema['const']!r}, got {instance!r}")

    if "enum" in schema and instance not in schema["enum"]:
        raise SchemaValidationError(path=path, message=f"Expected one of {schema['enum']!r}, got {instance!r}")

    schema_type = schema.get("type")
    if schema_type == "object":
        if not isinstance(instance, dict):
            raise SchemaValidationError(path=path, message=f"Expected object, got {type(instance).__name__}")

        required = schema.get("required", [])
        for key in required:
            if key not in instance:
                raise SchemaValidationError(path=path, message=f"Missing required key: {key!r}")

        properties: dict[str, Any] = schema.get("properties", {})
        additional_properties = schema.get("additionalProperties", True)
        for key, value in instance.items():
            if key in properties:
                _validate_json_schema_subset(
                    instance=value,
                    schema=properties[key],
                    root_schema=root_schema,
                    path=f"{path}.{key}",
                )
                continue

            if additional_properties is False:
                raise SchemaValidationError(path=path, message=f"Unexpected key: {key!r}")
            if isinstance(additional_properties, dict):
                _validate_json_schema_subset(
                    instance=value,
                    schema=additional_properties,
                    root_schema=root_schema,
                    path=f"{path}.{key}",
                )

        return

    if schema_type == "array":
        if not isinstance(instance, list):
            raise SchemaValidationError(path=path, message=f"Expected array, got {type(instance).__name__}")
        items_schema = schema.get("items")
        if isinstance(items_schema, dict):
            for i, value in enumerate(instance):
                _validate_json_schema_subset(
                    instance=value,
                    schema=items_schema,
                    root_schema=root_schema,
                    path=f"{path}[{i}]",
                )
        return

    if schema_type == "string":
        if not isinstance(instance, str):
            raise SchemaValidationError(path=path, message=f"Expected string, got {type(instance).__name__}")
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(instance) < min_length:
            raise SchemaValidationError(path=path, message=f"Expected minLength {min_length}, got {len(instance)}")
        return

    if schema_type == "integer":
        if not isinstance(instance, int) or isinstance(instance, bool):
            raise SchemaValidationError(path=path, message=f"Expected integer, got {type(instance).__name__}")
        return

    if schema_type == "boolean":
        if not isinstance(instance, bool):
            raise SchemaValidationError(path=path, message=f"Expected boolean, got {type(instance).__name__}")
        return

    if schema_type is None:
        return

    raise SchemaValidationError(path=path, message=f"Unsupported schema type: {schema_type!r}")


def validate_review_json(review: dict[str, Any], schema_path: Path) -> None:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    _validate_json_schema_subset(instance=review, schema=schema, root_schema=schema, path="$")


def extract_section(packet_text: str, heading: str) -> str | None:
    lines = packet_text.splitlines()
    current: list[str] = []
    in_section = False
    heading_re = re.compile(r"^##\s+(?P<title>.+?)\s*$")
    for line in lines:
        match = heading_re.match(line)
        if match:
            title = match.group("title").strip().lower()
            if in_section:
                break
            in_section = title == heading.strip().lower()
            continue
        if in_section:
            current.append(line)
    if not in_section:
        return None
    content = "\n".join(current).strip()
    return content or None


def extract_artifact_pointers(packet_text: str) -> list[str]:
    content = extract_section(packet_text, "Artifact pointers")
    if not content:
        return []

    pointers: list[str] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^[-*]\s+", "", line)
        line = re.sub(r"^\d+\.\s+", "", line)
        if not line:
            continue
        if re.match(r"^(hep://|file:|s3://|gs://|/)", line):
            pointers.append(line)
            continue
        if "://" in line:
            pointers.append(line)
            continue
    # de-dup, preserve order
    seen: set[str] = set()
    out: list[str] = []
    for p in pointers:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def build_review(packet_text: str, *, profile: str) -> dict[str, Any]:
    if profile != "generic":
        raise ValueError(f"Unsupported profile: {profile!r}")

    artifact_pointers = extract_artifact_pointers(packet_text)
    missing_artifact_pointers: list[str] = []

    paper_diff = extract_section(packet_text, "Paper diff")
    references = extract_section(packet_text, "References")

    major_issues: list[dict[str, str]] = []
    minor_issues: list[dict[str, str]] = []
    required_actions: list[dict[str, Any]] = []
    grounding_risks: list[dict[str, Any]] = []
    compile_risks: list[dict[str, Any]] = []
    evidence_requests: list[dict[str, Any]] = []

    if not artifact_pointers:
        missing_artifact_pointers.append("artifact_pointers")
        major_issues.append(
            {
                "id": "M1",
                "description": "No artifact pointers provided; cannot ground claims to concrete sources/artifacts.",
            }
        )
        required_actions.append(
            {
                "id": "A1",
                "action": "Provide artifact pointers for the paper bundle and any referenced artifacts (diff, TeX source, figures, data, logs).",
                "acceptance_criteria": "Packet includes an `## Artifact pointers` section with resolvable pointers (e.g., hep://... or file:/...).",
                "blocking": True,
            }
        )

    if not paper_diff:
        major_issues.append(
            {
                "id": "M2",
                "description": "No paper diff provided; cannot assess what changed or verify targeted edits.",
            }
        )
        required_actions.append(
            {
                "id": "A2",
                "action": "Provide a minimal paper diff (or excerpt) covering the claims under review.",
                "acceptance_criteria": "Packet contains a `## Paper diff` section with enough context to review the main claims.",
                "blocking": True,
            }
        )

    if not references:
        major_issues.append(
            {
                "id": "M3",
                "description": "No references summary provided; novelty and related-work grounding cannot be checked from the packet alone.",
            }
        )
        grounding_risks.append(
            {
                "risk": "Related-work coverage is ungrounded without a references list or notes.",
                "needs": "Provide a minimal references list (DOIs/arXiv IDs) or a short related-work summary with explicit citations.",
                "blocking": True,
            }
        )
        evidence_requests.append(
            {
                "source": "other",
                "query": "Provide DOIs/arXiv IDs for the closest prior work and any baseline methods explicitly compared against.",
                "purpose": "Enable novelty and positioning checks without reviewer-initiated web searches.",
                "expected_return": "A short list of identifiers + 1–2 sentence notes on each paper's relation.",
                "blocking": True,
            }
        )

    if paper_diff and ("\\cite" in paper_diff or "cite{" in paper_diff) and not references:
        # If references are missing but citations exist, make it explicit.
        grounding_risks.append(
            {
                "risk": "Citations appear in the diff but no bibliography/identifier list is provided in the packet.",
                "needs": "Provide the BibTeX entries or at minimum the arXiv/DOI identifiers for cited works.",
                "blocking": True,
            }
        )

    if paper_diff and re.search(r"\\(begin|end)\\{figure\\}", paper_diff):
        compile_risks.append(
            {
                "risk": "Figure environments changed; build may fail if figure files/paths are missing.",
                "needs": "Include figure files or pointers to the compiled PDF/build logs demonstrating success.",
                "blocking": False,
            }
        )

    if paper_diff and not any(k["id"] == "M2" for k in major_issues):
        minor_issues.append(
            {
                "id": "m1",
                "description": "Consider adding a short 'limitations' paragraph to clearly state assumptions and applicability bounds.",
            }
        )

    verdict = "NOT_READY" if any(a["blocking"] for a in required_actions) else "READY"

    return {
        "schema_version": 1,
        "profile": "generic",
        "verdict": verdict,
        "major_issues": major_issues,
        "minor_issues": minor_issues,
        "required_actions": required_actions,
        "grounding_risks": grounding_risks,
        "compile_risks": compile_risks,
        "artifact_pointers_used": artifact_pointers,
        "missing_artifact_pointers": missing_artifact_pointers,
        "evidence_requests": evidence_requests,
    }


def render_review_md(review: dict[str, Any]) -> str:
    verdict = review["verdict"]
    lines: list[str] = [f"VERDICT: {verdict}", ""]

    def render_issue_list(title: str, issues: list[dict[str, Any]]) -> None:
        lines.append(f"## {title}")
        if not issues:
            lines.append("- (none)")
            lines.append("")
            return
        for item in issues:
            lines.append(f"- [{item.get('id','')}] {item.get('description','')}".rstrip())
        lines.append("")

    render_issue_list("Major issues", review["major_issues"])
    render_issue_list("Minor issues", review["minor_issues"])

    lines.append("## Required actions")
    if not review["required_actions"]:
        lines.append("- (none)")
        lines.append("")
    else:
        for action in review["required_actions"]:
            blocking = "BLOCKING" if action["blocking"] else "non-blocking"
            lines.append(f"- [{action['id']}] ({blocking}) {action['action']}")
            lines.append(f"  - Acceptance: {action['acceptance_criteria']}")
        lines.append("")

    lines.append("## Artifact pointers used")
    if not review["artifact_pointers_used"]:
        lines.append("- (none)")
    else:
        for p in review["artifact_pointers_used"]:
            lines.append(f"- {p}")
    lines.append("")

    if review["missing_artifact_pointers"]:
        lines.append("## Missing artifact pointers")
        for p in review["missing_artifact_pointers"]:
            lines.append(f"- {p}")
        lines.append("")

    lines.append("## Grounding risks")
    if not review["grounding_risks"]:
        lines.append("- (none)")
    else:
        for r in review["grounding_risks"]:
            blocking = "BLOCKING" if r["blocking"] else "non-blocking"
            lines.append(f"- ({blocking}) Risk: {r['risk']}")
            lines.append(f"  - Needs: {r['needs']}")
    lines.append("")

    lines.append("## Compile risks")
    if not review["compile_risks"]:
        lines.append("- (none)")
    else:
        for r in review["compile_risks"]:
            blocking = "BLOCKING" if r["blocking"] else "non-blocking"
            lines.append(f"- ({blocking}) Risk: {r['risk']}")
            lines.append(f"  - Needs: {r['needs']}")
    lines.append("")

    lines.append("## Evidence requests (do not execute here)")
    if not review["evidence_requests"]:
        lines.append("- (none)")
    else:
        for req in review["evidence_requests"]:
            blocking = "BLOCKING" if req["blocking"] else "non-blocking"
            lines.append(f"- ({blocking}) [{req['source']}] {req['query']}")
            lines.append(f"  - Purpose: {req['purpose']}")
            lines.append(f"  - Expected: {req['expected_return']}")
    lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an offline, generic referee review (Markdown + JSON).")
    parser.add_argument("--profile", required=True, choices=["generic"], help="Review profile (only generic is supported).")
    parser.add_argument("--packet", required=True, help="Path to the Markdown review packet.")
    parser.add_argument("--out-dir", required=True, help="Output directory for review.md and review.json.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    packet_path = Path(args.packet)
    out_dir = Path(args.out_dir)
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    schema_path = repo_root / "schemas" / "review.schema.json"

    if not packet_path.is_file():
        print(f"error: packet not found: {packet_path}", file=sys.stderr)
        return 2
    if not schema_path.is_file():
        print(f"error: schema not found: {schema_path}", file=sys.stderr)
        return 2

    packet_text = packet_path.read_text(encoding="utf-8")
    review = build_review(packet_text, profile=args.profile)

    try:
        validate_review_json(review, schema_path=schema_path)
    except SchemaValidationError as exc:
        print(f"schema validation failed: {exc}", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "review.json").write_text(json.dumps(review, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out_dir / "review.md").write_text(render_review_md(review), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

