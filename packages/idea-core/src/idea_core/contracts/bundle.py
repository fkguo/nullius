from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from idea_core.hepar.fs_ops import atomic_write_text


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT_DIR = ROOT / "contracts" / "idea-generator-snapshot" / "schemas"
OPENRPC_FILE = "idea_core_rpc_v1.openrpc.json"
BUNDLED_OPENRPC_FILE = "idea_core_rpc_v1.bundled.json"


class BundleError(RuntimeError):
    """Raised when bundle generation fails."""


@dataclass(frozen=True)
class LoadedDoc:
    path: Path
    data: dict[str, Any]


class DocumentStore:
    def __init__(self) -> None:
        self._docs: dict[Path, LoadedDoc] = {}

    def load(self, path: Path) -> LoadedDoc:
        norm = path.resolve()
        if norm in self._docs:
            return self._docs[norm]

        try:
            data = json.loads(norm.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise BundleError(f"missing referenced file: {norm}") from exc
        except json.JSONDecodeError as exc:
            raise BundleError(f"invalid JSON in {norm}: {exc}") from exc

        if not isinstance(data, dict):
            raise BundleError(f"top-level JSON must be object: {norm}")

        doc = LoadedDoc(path=norm, data=data)
        self._docs[norm] = doc
        return doc


def _iter_refs(node: Any) -> list[str]:
    refs: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            maybe_ref = value.get("$ref")
            if isinstance(maybe_ref, str):
                refs.append(maybe_ref)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(node)
    return refs


def _resolve_ref_path(current_path: Path, ref: str) -> Path | None:
    parsed = urlparse(ref)
    if parsed.scheme and parsed.scheme not in {"file"}:
        return None

    if parsed.path:
        return (current_path.parent / parsed.path).resolve()
    return current_path.resolve()


def _collect_reachable_docs(store: DocumentStore, root_doc: LoadedDoc) -> list[LoadedDoc]:
    queue: list[LoadedDoc] = [root_doc]
    seen: set[Path] = set()

    while queue:
        current = queue.pop()
        if current.path in seen:
            continue
        seen.add(current.path)

        for ref in _iter_refs(current.data):
            target_path = _resolve_ref_path(current.path, ref)
            if target_path is None:
                continue
            target_doc = store.load(target_path)
            queue.append(target_doc)

    return [store.load(path) for path in sorted(seen)]


def _build_component_names(schema_docs: list[LoadedDoc]) -> dict[Path, str]:
    by_path: dict[Path, str] = {}
    used: set[str] = set()

    for doc in sorted(schema_docs, key=lambda item: item.path.name):
        stem = doc.path.name
        if stem.endswith(".schema.json"):
            stem = stem[:-12]
        elif stem.endswith(".json"):
            stem = stem[:-5]
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", stem)
        if not stem:
            stem = "schema"

        candidate = stem
        suffix = 2
        while candidate in used:
            candidate = f"{stem}_{suffix}"
            suffix += 1

        used.add(candidate)
        by_path[doc.path] = candidate

    return by_path


def _rewrite_ref_value(ref: str, current_path: Path, component_names: dict[Path, str]) -> str:
    parsed = urlparse(ref)
    if parsed.scheme and parsed.scheme not in {"file"}:
        return ref

    target_path = _resolve_ref_path(current_path, ref)
    if target_path is None:
        return ref

    component = component_names.get(target_path.resolve())
    if component is None:
        return ref

    suffix = f"#{parsed.fragment}" if parsed.fragment else ""
    return f"#/components/schemas/{component}{suffix}"


def _rewrite_refs(node: Any, *, current_path: Path, component_names: dict[Path, str]) -> Any:
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                out[key] = _rewrite_ref_value(value, current_path=current_path, component_names=component_names)
            else:
                out[key] = _rewrite_refs(
                    value,
                    current_path=current_path,
                    component_names=component_names,
                )
        return out

    if isinstance(node, list):
        return [
            _rewrite_refs(item, current_path=current_path, component_names=component_names)
            for item in node
        ]

    return node


def build_bundle(contract_dir: Path) -> dict[str, Any]:
    if not contract_dir.exists():
        raise BundleError(f"contract directory does not exist: {contract_dir}")

    openrpc_path = (contract_dir / OPENRPC_FILE).resolve()
    store = DocumentStore()
    openrpc_doc = store.load(openrpc_path)

    all_docs = _collect_reachable_docs(store, openrpc_doc)
    schema_docs = [doc for doc in all_docs if doc.path != openrpc_doc.path]
    component_names = _build_component_names(schema_docs)

    bundled_openrpc = _rewrite_refs(
        openrpc_doc.data,
        current_path=openrpc_doc.path,
        component_names=component_names,
    )
    if not isinstance(bundled_openrpc, dict):
        raise BundleError(f"OpenRPC document is not object: {openrpc_doc.path}")

    components = bundled_openrpc.get("components")
    if components is None:
        components = {}
    if not isinstance(components, dict):
        raise BundleError("OpenRPC components must be an object when present")

    bundled_schemas: dict[str, Any] = {}
    for doc in sorted(schema_docs, key=lambda item: item.path.name):
        component_name = component_names[doc.path]
        bundled_schemas[component_name] = _rewrite_refs(
            doc.data,
            current_path=doc.path,
            component_names=component_names,
        )

    components["schemas"] = bundled_schemas
    bundled_openrpc["components"] = components
    bundled_openrpc["x-bundle-note"] = "Generated artifact for tooling compatibility. Do not hand-edit."

    return bundled_openrpc


def write_bundle(contract_dir: Path) -> Path:
    bundle = build_bundle(contract_dir)
    output_path = (contract_dir / BUNDLED_OPENRPC_FILE).resolve()
    atomic_write_text(output_path, json.dumps(bundle, indent=2, sort_keys=True) + "\n")
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build bundled OpenRPC artifact from vendored contracts")
    parser.add_argument(
        "--contract-dir",
        type=Path,
        default=DEFAULT_CONTRACT_DIR,
        help="Directory containing vendored schema/OpenRPC files",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write bundled output to idea_core_rpc_v1.bundled.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.write:
            path = write_bundle(args.contract_dir)
            print(f"[bundle] OK: wrote {path}")
        else:
            _ = build_bundle(args.contract_dir)
            print("[bundle] OK: generated bundle in-memory")
    except BundleError as exc:
        print(f"[bundle] FAIL: {exc}")
        return 1
    except Exception as exc:  # pragma: no cover - hard fail catch for CLI use
        print(f"[bundle] FAIL (unexpected): {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
