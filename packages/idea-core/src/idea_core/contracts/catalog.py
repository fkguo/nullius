from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR, OPENRPC_FILE


class ContractRuntimeError(RuntimeError):
    """Runtime contract validation error."""


@dataclass(frozen=True)
class MethodContract:
    name: str
    params: list[dict[str, Any]]
    result_schema: dict[str, Any]


class ContractCatalog:
    def __init__(self, contract_dir: Path = DEFAULT_CONTRACT_DIR) -> None:
        self.contract_dir = contract_dir
        self.openrpc_path = (contract_dir / OPENRPC_FILE).resolve()
        self.openrpc = self._load_json(self.openrpc_path)
        self.contract_version = str(self.openrpc.get("info", {}).get("version", "unknown"))
        self.registry = self._build_registry(contract_dir)
        self.format_checker = FormatChecker()
        self.methods: dict[str, MethodContract] = {}

        for method in self.openrpc.get("methods", []):
            self.methods[method["name"]] = MethodContract(
                name=method["name"],
                params=method.get("params", []),
                result_schema=method.get("result", {}).get("schema", {}),
            )

        error_contract = self.openrpc.get("x-error-data-contract", {})
        self.error_data_schema = error_contract.get("schema")

    @staticmethod
    def _load_json(path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def _build_registry(self, contract_dir: Path) -> Registry:
        registry = Registry()
        for schema_path in sorted(contract_dir.glob("*.schema.json")):
            schema = self._load_json(schema_path)
            registry = registry.with_resource(
                schema_path.resolve().as_uri(), Resource.from_contents(schema)
            )
        return registry

    def _validate_with_schema(
        self,
        schema: dict[str, Any],
        instance: Any,
        base_uri: str,
    ) -> None:
        wrapped_schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": base_uri,
            **schema,
        }
        validator = Draft202012Validator(
            wrapped_schema,
            registry=self.registry,
            format_checker=self.format_checker,
        )
        errors = sorted(validator.iter_errors(instance), key=lambda e: str(e.path))
        if errors:
            first = errors[0]
            location = "/".join(str(part) for part in first.path)
            raise ContractRuntimeError(
                f"schema_invalid at '{location or '<root>'}': {first.message}"
            )

    def validate_request_params(self, method_name: str, params: dict[str, Any]) -> None:
        if method_name not in self.methods:
            raise ContractRuntimeError(f"unknown method contract: {method_name}")
        if not isinstance(params, dict):
            raise ContractRuntimeError("params must be an object (by-name)")

        method = self.methods[method_name]
        required_params = {p["name"] for p in method.params if p.get("required")}

        missing = sorted(required_params - params.keys())
        if missing:
            raise ContractRuntimeError(f"missing required params: {', '.join(missing)}")

        allowed = {p["name"] for p in method.params}
        extra = sorted(set(params.keys()) - allowed)
        if extra:
            raise ContractRuntimeError(f"unknown params: {', '.join(extra)}")

        for param in method.params:
            name = param["name"]
            if name not in params:
                continue
            schema = param.get("schema")
            if not isinstance(schema, dict):
                continue
            base_uri = self.openrpc_path.resolve().as_uri() + f"#/{method_name}/params/{name}"
            self._validate_with_schema(schema, params[name], base_uri=base_uri)

    def validate_result(self, method_name: str, result: dict[str, Any]) -> None:
        method = self.methods[method_name]
        schema = method.result_schema
        base_uri = self.openrpc_path.resolve().as_uri() + f"#/{method_name}/result"
        self._validate_with_schema(schema, result, base_uri=base_uri)

    def validate_against_ref(self, ref: str, instance: Any, *, base_name: str) -> None:
        schema = {"$ref": ref}
        base_uri = self.openrpc_path.resolve().as_uri() + f"#/{base_name}"
        self._validate_with_schema(schema, instance, base_uri=base_uri)

    def validate_error_data(self, error_data: dict[str, Any]) -> None:
        if not isinstance(self.error_data_schema, dict):
            return
        base_uri = self.openrpc_path.resolve().as_uri() + "#/x-error-data-contract/schema"
        self._validate_with_schema(self.error_data_schema, error_data, base_uri=base_uri)
