from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from jsonschema import Draft202012Validator

from idea_core.contracts.bundle import BUNDLED_OPENRPC_FILE, BundleError, build_bundle

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT_DIR = ROOT / "contracts" / "idea-generator-snapshot" / "schemas"
OPENRPC_FILE = "idea_core_rpc_v1.openrpc.json"


class ContractValidationError(RuntimeError):
    """Raised on contract validation failures."""


@dataclass(frozen=True)
class LoadedDoc:
    path: Path
    data: dict[str, Any]


class DocumentStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._docs: dict[Path, LoadedDoc] = {}

    def load(self, path: Path) -> LoadedDoc:
        norm = path.resolve()
        if norm in self._docs:
            return self._docs[norm]

        try:
            data = json.loads(norm.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ContractValidationError(f"missing referenced file: {norm}") from exc
        except json.JSONDecodeError as exc:
            raise ContractValidationError(f"invalid JSON in {norm}: {exc}") from exc

        if not isinstance(data, dict):
            raise ContractValidationError(f"top-level JSON must be object: {norm}")

        loaded = LoadedDoc(path=norm, data=data)
        self._docs[norm] = loaded
        return loaded

    def iter_docs(self) -> list[LoadedDoc]:
        return list(self._docs.values())


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


def _json_pointer_exists(doc: Any, fragment: str) -> bool:
    if not fragment or fragment == "#":
        return True

    if not fragment.startswith("#/"):
        return False

    parts = fragment[2:].split("/")
    cur = doc
    for raw in parts:
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, dict) and token in cur:
            cur = cur[token]
            continue
        if isinstance(cur, list):
            if not token.isdigit():
                return False
            idx = int(token)
            if idx >= len(cur):
                return False
            cur = cur[idx]
            continue
        return False
    return True


def validate_openrpc_minimal(openrpc_doc: LoadedDoc) -> None:
    data = openrpc_doc.data
    required_top = ["openrpc", "info", "methods"]
    for field in required_top:
        if field not in data:
            raise ContractValidationError(f"OpenRPC missing required field: {field}")

    if not isinstance(data["methods"], list) or not data["methods"]:
        raise ContractValidationError("OpenRPC methods must be a non-empty array")

    for idx, method in enumerate(data["methods"]):
        if not isinstance(method, dict):
            raise ContractValidationError(f"OpenRPC method at index {idx} must be an object")
        for key in ("name", "params", "result"):
            if key not in method:
                raise ContractValidationError(f"OpenRPC method {idx} missing '{key}'")


def validate_schema_legality(schema_doc: LoadedDoc) -> None:
    Draft202012Validator.check_schema(schema_doc.data)


def _is_inline_complex_schema(schema: dict[str, Any]) -> bool:
    if "$ref" in schema:
        return False
    if schema.get("type") == "object":
        return True
    if schema.get("type") == "array":
        items = schema.get("items")
        if not isinstance(items, dict):
            return True
        return _is_inline_complex_schema(items)

    complex_keys = {
        "properties",
        "required",
        "allOf",
        "anyOf",
        "oneOf",
        "if",
        "then",
        "else",
        "contains",
    }
    return any(key in schema for key in complex_keys)


def validate_drift_guard(openrpc_doc: LoadedDoc) -> None:
    data = openrpc_doc.data
    components = data.get("components")
    if isinstance(components, dict):
        schemas = components.get("schemas")
        if isinstance(schemas, dict) and schemas:
            raise ContractValidationError("drift-guard: OpenRPC must not define components.schemas")

    for method in data.get("methods", []):
        name = method.get("name", "<unknown>")
        for param in method.get("params", []):
            schema = param.get("schema")
            if isinstance(schema, dict) and _is_inline_complex_schema(schema):
                raise ContractValidationError(
                    f"drift-guard: method '{name}' param '{param.get('name')}' uses inline complex schema"
                )

        result = method.get("result", {})
        result_schema = result.get("schema")
        if isinstance(result_schema, dict) and _is_inline_complex_schema(result_schema):
            raise ContractValidationError(
                f"drift-guard: method '{name}' result uses inline complex schema"
            )


def validate_ref_closure(contract_dir: Path, openrpc_doc: LoadedDoc) -> None:
    store = DocumentStore(contract_dir)
    store.load(openrpc_doc.path)

    queue: list[LoadedDoc] = [openrpc_doc]
    seen: set[Path] = set()

    while queue:
        current = queue.pop()
        if current.path in seen:
            continue
        seen.add(current.path)

        refs = _iter_refs(current.data)
        for ref in refs:
            parsed = urlparse(ref)
            if parsed.scheme and parsed.scheme not in {"file"}:
                continue

            target_path = current.path
            if parsed.path:
                target_path = (current.path.parent / parsed.path).resolve()

            target = store.load(target_path)
            if parsed.fragment:
                fragment = f"#{parsed.fragment}"
                if not _json_pointer_exists(target.data, fragment):
                    raise ContractValidationError(
                        f"unresolved $ref pointer '{ref}' from {current.path}"
                    )

            queue.append(target)


def validate_bundle_consistency(contract_dir: Path) -> None:
    bundle_path = (contract_dir / BUNDLED_OPENRPC_FILE).resolve()
    try:
        bundle_data = json.loads(bundle_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ContractValidationError(
            f"bundle artifact missing: {bundle_path} (run `make bundle-contracts`)"
        ) from exc
    except json.JSONDecodeError as exc:
        raise ContractValidationError(f"invalid JSON in bundle artifact {bundle_path}: {exc}") from exc

    if not isinstance(bundle_data, dict):
        raise ContractValidationError(f"bundle artifact top-level must be object: {bundle_path}")

    try:
        generated_bundle = build_bundle(contract_dir)
    except BundleError as exc:
        raise ContractValidationError(f"failed to generate expected bundle: {exc}") from exc

    if bundle_data != generated_bundle:
        raise ContractValidationError(
            f"bundle artifact drift detected: {bundle_path} is out-of-date (run `make bundle-contracts`)"
        )

    bundle_doc = LoadedDoc(path=bundle_path, data=bundle_data)
    validate_openrpc_minimal(bundle_doc)
    validate_ref_closure(contract_dir, bundle_doc)


def run_validation(contract_dir: Path, *, check_bundle: bool = True) -> None:
    if not contract_dir.exists():
        raise ContractValidationError(f"contract directory does not exist: {contract_dir}")

    openrpc_path = (contract_dir / OPENRPC_FILE).resolve()
    store = DocumentStore(contract_dir)

    openrpc_doc = store.load(openrpc_path)
    validate_openrpc_minimal(openrpc_doc)
    validate_drift_guard(openrpc_doc)

    for schema_path in sorted(contract_dir.glob("*.schema.json")):
        schema_doc = store.load(schema_path.resolve())
        validate_schema_legality(schema_doc)

    validate_ref_closure(contract_dir, openrpc_doc)
    if check_bundle:
        validate_bundle_consistency(contract_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate idea-core OpenRPC/schema contracts")
    parser.add_argument(
        "--contract-dir",
        type=Path,
        default=DEFAULT_CONTRACT_DIR,
        help="Directory containing vendored schema/OpenRPC files",
    )
    parser.add_argument(
        "--skip-bundle-check",
        action="store_true",
        help="Skip bundled OpenRPC consistency check",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        run_validation(args.contract_dir, check_bundle=not args.skip_bundle_check)
    except ContractValidationError as exc:
        print(f"[validate] FAIL: {exc}")
        return 1
    except Exception as exc:  # pragma: no cover - hard fail catch for CLI use
        print(f"[validate] FAIL (unexpected): {exc}")
        return 1

    print(
        "[validate] OK: JSON parse, schema legality, OpenRPC minimal shape, "
        "$ref closure, drift-guard, bundle-consistency"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
