from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any


MINIMAL_HEP_FORMALISM_ENTRIES: tuple[dict[str, str], ...] = (
    {
        "formalism_id": "hep/toy",
        "c2_schema_ref": "https://example.org/schemas/toy-c2-v1.json",
        "validator_id": "toy-validator",
        "compiler_id": "toy-compiler",
        "description": "Default bootstrap formalism",
    },
    {
        "formalism_id": "hep/eft",
        "c2_schema_ref": "https://example.org/schemas/eft-c2-v1.json",
        "validator_id": "eft-validator",
        "compiler_id": "eft-compiler",
        "description": "Effective field theory baseline for perturbative studies.",
    },
    {
        "formalism_id": "hep/lattice",
        "c2_schema_ref": "https://example.org/schemas/lattice-c2-v1.json",
        "validator_id": "lattice-validator",
        "compiler_id": "lattice-compiler",
        "description": "Lattice-style non-perturbative baseline.",
    },
)


@dataclass(frozen=True)
class FormalismRegistry:
    entries: tuple[dict[str, Any], ...]

    @classmethod
    def from_payload(
        cls,
        payload: Any,
        *,
        context: str,
    ) -> "FormalismRegistry":
        if not isinstance(payload, dict):
            raise ValueError(f"{context} must be an object")
        entries = payload.get("entries")
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"{context} must be non-empty")

        normalized: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for index, raw_entry in enumerate(entries):
            if not isinstance(raw_entry, dict):
                raise ValueError(f"{context}.entries[{index}] must be an object")
            formalism_id = raw_entry.get("formalism_id")
            if not isinstance(formalism_id, str) or not formalism_id:
                raise ValueError(f"{context}.entries[{index}].formalism_id is missing")
            if formalism_id in seen_ids:
                raise ValueError(f"{context} contains duplicate formalism_id: {formalism_id}")
            seen_ids.add(formalism_id)
            normalized.append(copy.deepcopy(raw_entry))
        return cls(entries=tuple(normalized))

    @classmethod
    def merge(
        cls,
        *,
        defaults: Any,
        overrides: Any,
        context: str = "effective formalism registry",
    ) -> "FormalismRegistry":
        try:
            default_registry = cls.from_payload(defaults, context="default formalism registry")
        except ValueError as exc:
            if "must be non-empty" in str(exc):
                raise ValueError(f"{context} must be non-empty") from exc
            raise
        merged: dict[str, dict[str, Any]] = {
            entry["formalism_id"]: copy.deepcopy(entry)
            for entry in default_registry.entries
        }

        if overrides is not None:
            override_registry = cls.from_payload(overrides, context="override formalism registry")
            for entry in override_registry.entries:
                merged[entry["formalism_id"]] = copy.deepcopy(entry)

        if not merged:
            raise ValueError(f"{context} must be non-empty")
        return cls(entries=tuple(merged.values()))

    def to_payload(self) -> dict[str, Any]:
        return {"entries": [copy.deepcopy(entry) for entry in self.entries]}

    def default_formalism_id(self) -> str:
        return str(self.entries[0]["formalism_id"])

    def missing_formalisms(self, candidate_formalisms: Any) -> list[str]:
        if not isinstance(candidate_formalisms, list):
            return []
        ids = {entry["formalism_id"] for entry in self.entries}
        missing: list[str] = []
        seen: set[str] = set()
        for formalism_id in candidate_formalisms:
            if not isinstance(formalism_id, str):
                continue
            if formalism_id in ids or formalism_id in seen:
                continue
            missing.append(formalism_id)
            seen.add(formalism_id)
        return missing
