from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4

from idea_core.contracts.catalog import ContractCatalog, ContractRuntimeError
from idea_core.engine.domain_pack import (
    DomainConstraintPolicy,
    DomainPackAssets,
    DomainPackIndex,
    build_builtin_domain_pack_index,
)
from idea_core.engine.formalism_registry import FormalismRegistry
from idea_core.engine.operators import (
    OperatorContext,
    OperatorOutput,
    SearchOperator,
)
from idea_core.engine.store import EngineStore
from idea_core.engine.text_utils import (
    contains_any,
    dedupe_preserve_order,
    sanitize_text,
    sanitize_text_list,
    token_set,
)
from idea_core.engine.utils import payload_hash, sha256_hex, utc_now_iso


BUDGET_DIMENSIONS = ["tokens", "cost_usd", "wall_clock_s", "steps", "nodes"]
DIMENSION_ORDER = ["novelty", "feasibility", "impact", "tractability", "grounding"]
STAGNATION_PATIENCE_STEPS = 2
BEST_SCORE_EPSILON = 1e-9


@dataclass
class RpcError(Exception):
    code: int
    message: str
    data: dict[str, Any]

    def as_jsonrpc_error(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "data": self.data,
        }


class IdeaCoreService:
    _MAX_INITIAL_ISLAND_COUNT = 20

    def __init__(
        self,
        *,
        data_dir: Path,
        contract_dir: Path,
        search_operators: tuple[SearchOperator, ...] | None = None,
        domain_pack_index: DomainPackIndex | None = None,
    ) -> None:
        self.store = EngineStore(data_dir)
        self.catalog = ContractCatalog(contract_dir)
        if domain_pack_index is not None and search_operators is not None:
            raise ValueError("pass either domain_pack_index or search_operators, not both")
        if domain_pack_index is not None:
            self.domain_pack_index = domain_pack_index
        else:
            self.domain_pack_index = build_builtin_domain_pack_index(
                search_operators=search_operators,
            )

    def handle(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "campaign.init": self.campaign_init,
            "campaign.status": self.campaign_status,
            "campaign.topup": self.campaign_topup,
            "campaign.pause": self.campaign_pause,
            "campaign.resume": self.campaign_resume,
            "campaign.complete": self.campaign_complete,
            "node.get": self.node_get,
            "node.list": self.node_list,
            "search.step": self.search_step,
            "eval.run": self.eval_run,
            "rank.compute": self.rank_compute,
            "node.promote": self.node_promote,
        }
        if method not in handlers:
            raise RpcError(
                code=-32601,
                message="method_not_found",
                data={"reason": "method_not_found", "details": {"method": method}},
            )

        try:
            self.catalog.validate_request_params(method, params)
        except ContractRuntimeError as exc:
            raise self._schema_error(str(exc)) from exc

        result = handlers[method](params)

        try:
            self.catalog.validate_result(method, result)
        except ContractRuntimeError as exc:
            raise self._schema_error(f"result_schema_invalid: {exc}") from exc

        return result

    def _schema_error(self, detail: str, *, extra: dict[str, Any] | None = None) -> RpcError:
        data = {"reason": "schema_invalid", "details": {"message": detail}}
        if extra:
            data.update(extra)
        self.catalog.validate_error_data(data)
        return RpcError(code=-32002, message="schema_validation_failed", data=data)

    def _budget_snapshot(self, campaign: dict[str, Any]) -> dict[str, Any]:
        budget = campaign["budget"]
        usage = campaign["usage"]

        max_steps = budget.get("max_steps")
        max_nodes = budget.get("max_nodes")

        steps_remaining = None if max_steps is None else max(max_steps - usage["steps_used"], 0)
        nodes_remaining = None if max_nodes is None else max(max_nodes - usage["nodes_used"], 0)

        return {
            "tokens_used": usage["tokens_used"],
            "tokens_remaining": max(budget["max_tokens"] - usage["tokens_used"], 0),
            "cost_usd_used": usage["cost_usd_used"],
            "cost_usd_remaining": max(budget["max_cost_usd"] - usage["cost_usd_used"], 0),
            "wall_clock_s_elapsed": usage["wall_clock_s_elapsed"],
            "wall_clock_s_remaining": max(
                budget["max_wall_clock_s"] - usage["wall_clock_s_elapsed"],
                0,
            ),
            "steps_used": usage["steps_used"],
            "steps_remaining": steps_remaining,
            "nodes_used": usage["nodes_used"],
            "nodes_remaining": nodes_remaining,
        }

    def _exhausted_dimensions(self, campaign: dict[str, Any]) -> list[str]:
        snapshot = self._budget_snapshot(campaign)
        exhausted: list[str] = []
        if snapshot["tokens_remaining"] <= 0:
            exhausted.append("tokens")
        if snapshot["cost_usd_remaining"] <= 0:
            exhausted.append("cost_usd")
        if snapshot["wall_clock_s_remaining"] <= 0:
            exhausted.append("wall_clock_s")
        if snapshot["steps_remaining"] is not None and snapshot["steps_remaining"] <= 0:
            exhausted.append("steps")
        if snapshot["nodes_remaining"] is not None and snapshot["nodes_remaining"] <= 0:
            exhausted.append("nodes")
        return exhausted

    def _ensure_campaign_running(self, campaign: dict[str, Any]) -> None:
        if campaign["status"] == "exhausted":
            raise self._budget_exhausted(campaign)
        if campaign["status"] != "running":
            data = {"reason": "campaign_not_active", "campaign_id": campaign["campaign_id"]}
            self.catalog.validate_error_data(data)
            raise RpcError(code=-32015, message="campaign_not_active", data=data)

    def _budget_exhausted(self, campaign: dict[str, Any]) -> RpcError:
        exhausted = self._exhausted_dimensions(campaign) or ["steps"]
        data = {
            "reason": "dimension_exhausted",
            "campaign_id": campaign["campaign_id"],
            "details": {"exhausted_dimensions": exhausted},
        }
        self.catalog.validate_error_data(data)
        return RpcError(code=-32001, message="budget_exhausted", data=data)

    def _load_campaign_or_error(self, campaign_id: str) -> dict[str, Any]:
        campaign = self.store.load_campaign(campaign_id)
        if campaign is None:
            data = {"reason": "campaign_not_found", "campaign_id": campaign_id}
            self.catalog.validate_error_data(data)
            raise RpcError(code=-32003, message="campaign_not_found", data=data)
        if campaign.get("campaign_id") != campaign_id:
            data = {"reason": "campaign_not_found", "campaign_id": campaign_id}
            self.catalog.validate_error_data(data)
            raise RpcError(code=-32003, message="campaign_not_found", data=data)
        return campaign

    def _idempotency_scope_campaign(self, method: str) -> bool:
        return method != "campaign.init"

    @staticmethod
    def _idempotency_key(method: str, idempotency_key: str) -> str:
        return f"{method}:{idempotency_key}"

    def _record_or_replay(
        self,
        *,
        method: str,
        idempotency_key: str,
        payload_hash_value: str,
        campaign_id: str | None,
    ) -> tuple[str, dict[str, Any]] | None:
        scope_campaign_id = campaign_id if self._idempotency_scope_campaign(method) else None
        store = self.store.load_idempotency(scope_campaign_id)
        key = self._idempotency_key(method, idempotency_key)
        existing = store.get(key)
        if existing is None:
            return None

        existing_hash = existing["payload_hash"]
        if existing_hash != payload_hash_value:
            data = {
                "reason": "idempotency_key_conflict",
                "idempotency_key": idempotency_key,
                "payload_hash": payload_hash_value,
                "details": {"stored_payload_hash": existing_hash},
            }
            if campaign_id:
                data["campaign_id"] = campaign_id
            self.catalog.validate_error_data(data)
            raise RpcError(code=-32002, message="schema_validation_failed", data=data)

        if existing.get("state") == "prepared":
            if not self._prepared_side_effects_committed(method=method, record=existing, campaign_id=campaign_id):
                del store[key]
                self.store.save_idempotency(scope_campaign_id, store)
                return None
            existing["state"] = "committed"
            store[key] = existing
            self.store.save_idempotency(scope_campaign_id, store)

        response = copy.deepcopy(existing["response"])
        if response["kind"] == "result":
            result = response["payload"]
            idem = result.get("idempotency")
            if isinstance(idem, dict):
                idem["is_replay"] = True
            return ("result", result)
        return ("error", response["payload"])

    def _store_idempotency(
        self,
        *,
        method: str,
        idempotency_key: str,
        payload_hash_value: str,
        campaign_id: str | None,
        response: dict[str, Any],
        kind: str,
        state: str = "committed",
    ) -> None:
        if kind == "error":
            return
        scope_campaign_id = campaign_id if self._idempotency_scope_campaign(method) else None
        store = self.store.load_idempotency(scope_campaign_id)
        key = self._idempotency_key(method, idempotency_key)
        if key in store:
            existing = store[key]
            if existing.get("state") == "prepared" and state == "committed":
                existing["state"] = "committed"
                existing["response"] = {"kind": kind, "payload": response}
                store[key] = existing
                self.store.save_idempotency(scope_campaign_id, store)
            return
        store[key] = {
            "payload_hash": payload_hash_value,
            "created_at": utc_now_iso(),
            "state": state,
            "response": {
                "kind": kind,
                "payload": response,
            },
        }
        self.store.save_idempotency(scope_campaign_id, store)

    @staticmethod
    def _artifact_ref_exists(ref: Any) -> bool:
        if not isinstance(ref, str) or not ref.startswith("file://"):
            return False
        return Path(ref[7:]).exists()

    def _prepared_side_effects_committed(
        self,
        *,
        method: str,
        record: dict[str, Any],
        campaign_id: str | None,
    ) -> bool:
        response = record.get("response", {})
        kind = response.get("kind")
        payload = response.get("payload", {})
        if kind != "result":
            return True
        if method == "campaign.init":
            candidate_campaign_id = payload.get("campaign_id")
            if not isinstance(candidate_campaign_id, str):
                return False
            return self.store.campaign_manifest_path(candidate_campaign_id).exists()
        if method == "eval.run":
            return self._artifact_ref_exists(payload.get("scorecards_artifact_ref"))
        if method == "rank.compute":
            return self._artifact_ref_exists(payload.get("ranking_artifact_ref"))
        if method == "node.promote":
            return self._artifact_ref_exists(payload.get("handoff_artifact_ref"))
        if method == "search.step":
            if campaign_id is None:
                return False
            step_id = payload.get("step_id")
            if not isinstance(step_id, str):
                return False
            campaign = self.store.load_campaign(campaign_id)
            if campaign is None or campaign.get("last_step_id") != step_id:
                return False
            if not self._search_step_artifact_path(campaign_id, step_id).exists():
                return False

            new_node_ids = payload.get("new_node_ids", [])
            if isinstance(new_node_ids, list) and new_node_ids:
                if not self._artifact_ref_exists(payload.get("new_nodes_artifact_ref")):
                    return False
                nodes = self.store.load_nodes(campaign_id)
                for node_id in new_node_ids:
                    if node_id not in nodes:
                        return False
            return True
        return False

    def _hash_without_idempotency(self, method: str, params: dict[str, Any]) -> str:
        filtered = {k: copy.deepcopy(v) for k, v in params.items() if k != "idempotency_key"}
        method_contract = self.catalog.methods.get(method)
        if method_contract is not None:
            for spec in method_contract.params:
                name = spec["name"]
                schema = spec.get("schema", {})
                if name not in filtered and isinstance(schema, dict) and "default" in schema:
                    filtered[name] = copy.deepcopy(schema["default"])
        return payload_hash(filtered)

    def _response_idempotency(self, idempotency_key: str, payload_hash_value: str) -> dict[str, Any]:
        return {
            "idempotency_key": idempotency_key,
            "is_replay": False,
            "payload_hash": payload_hash_value,
        }

    @staticmethod
    def _merge_registry_entries(
        *,
        defaults: dict[str, Any],
        overrides: dict[str, Any] | None,
        key_name: str,
    ) -> dict[str, Any]:
        merged = {entry[key_name]: copy.deepcopy(entry) for entry in defaults["entries"]}
        if isinstance(overrides, dict):
            for entry in overrides.get("entries", []):
                merged[entry[key_name]] = copy.deepcopy(entry)
        return {"entries": list(merged.values())}

    @staticmethod
    def _extension_string_list(extensions: dict[str, Any], keys: tuple[str, ...]) -> list[str]:
        for key in keys:
            value = extensions.get(key)
            if isinstance(value, str):
                compact = value.strip()
                if compact:
                    return [compact]
            if not isinstance(value, list):
                continue
            resolved: list[str] = []
            seen: set[str] = set()
            for item in value:
                if not isinstance(item, str):
                    continue
                compact = item.strip()
                if not compact or compact in seen:
                    continue
                resolved.append(compact)
                seen.add(compact)
            return resolved
        return []

    @staticmethod
    def _resolve_initial_island_count(charter: dict[str, Any]) -> int:
        extensions = charter.get("extensions")
        if not isinstance(extensions, dict):
            return 1

        raw: Any | None = None
        for key in ("initial_island_count", "island_count"):
            if key in extensions:
                raw = extensions.get(key)
                break
        if raw is None:
            return 1

        if isinstance(raw, bool):
            raise ValueError("initial_island_count must be an integer >= 1")
        if isinstance(raw, int):
            count = raw
        elif isinstance(raw, str):
            compact = raw.strip()
            if not compact.isdigit():
                raise ValueError("initial_island_count must be an integer >= 1")
            count = int(compact)
        else:
            raise ValueError("initial_island_count must be an integer >= 1")

        if count < 1:
            raise ValueError("initial_island_count must be an integer >= 1")
        if count > IdeaCoreService._MAX_INITIAL_ISLAND_COUNT:
            raise ValueError(
                f"initial_island_count must be <= {IdeaCoreService._MAX_INITIAL_ISLAND_COUNT}"
            )
        return count

    @staticmethod
    def _initial_island_states(count: int) -> list[dict[str, Any]]:
        return [
            {
                "island_id": f"island-{index}",
                "state": "SEEDING",
                "population_size": 0,
                "stagnation_counter": 0,
                "repopulation_count": 0,
                "best_score": None,
            }
            for index in range(count)
        ]

    def _resolve_domain_pack_for_charter(
        self,
        charter: dict[str, Any],
    ) -> tuple[DomainPackAssets, list[str]]:
        extensions = charter.get("extensions")
        if not isinstance(extensions, dict):
            extensions = {}

        enabled_ids = self._extension_string_list(
            extensions,
            ("enable_domain_packs", "enabled_domain_packs"),
        )
        disabled_ids = set(
            self._extension_string_list(
                extensions,
                ("disable_domain_packs", "disabled_domain_packs"),
            )
        )

        requested_pack_id: str | None = None
        for key in ("domain_pack_id", "active_domain_pack_id"):
            candidate = extensions.get(key)
            if isinstance(candidate, str) and candidate.strip():
                requested_pack_id = candidate.strip()
                break

        if enabled_ids:
            unknown_enabled = [pack_id for pack_id in enabled_ids if not self.domain_pack_index.has_pack(pack_id)]
            if unknown_enabled:
                raise self._schema_error(
                    f"unknown enabled domain pack id(s): {', '.join(unknown_enabled)}",
                )
            candidate_pack_ids = enabled_ids
        else:
            domain = str(charter.get("domain", "")).strip()
            candidate_pack_ids = list(self.domain_pack_index.eligible_pack_ids_for_domain(domain))
            if not candidate_pack_ids:
                domain_label = domain or "<empty>"
                raise self._schema_error(
                    f"no domain pack available for domain: {domain_label}",
                )

        candidate_pack_ids = [pack_id for pack_id in candidate_pack_ids if pack_id not in disabled_ids]
        if not candidate_pack_ids:
            raise self._schema_error("domain pack candidates are empty after enable/disable filters")

        if requested_pack_id is not None:
            if not self.domain_pack_index.has_pack(requested_pack_id):
                raise self._schema_error(f"unknown domain_pack_id: {requested_pack_id}")
            if requested_pack_id not in candidate_pack_ids:
                raise self._schema_error(
                    f"requested domain_pack_id not enabled: {requested_pack_id}",
                )
            selected_pack_id = requested_pack_id
        else:
            selected_pack_id = candidate_pack_ids[0]

        try:
            pack = self.domain_pack_index.load(selected_pack_id)
        except (KeyError, ValueError) as exc:
            raise self._schema_error(f"failed to load domain pack {selected_pack_id}: {exc}") from exc
        return pack, candidate_pack_ids

    def _load_campaign_domain_pack(self, campaign: dict[str, Any]) -> DomainPackAssets:
        campaign_id = campaign["campaign_id"]
        domain_pack_meta = campaign.get("domain_pack")
        if not isinstance(domain_pack_meta, dict):
            raise self._schema_error(
                "campaign missing domain_pack metadata",
                extra={"campaign_id": campaign_id},
            )

        pack_id = domain_pack_meta.get("pack_id")
        if not isinstance(pack_id, str) or not pack_id:
            raise self._schema_error(
                "campaign domain_pack.pack_id is missing or empty",
                extra={"campaign_id": campaign_id},
            )

        enabled_pack_ids = domain_pack_meta.get("enabled_pack_ids")
        if not isinstance(enabled_pack_ids, list) or not all(isinstance(item, str) for item in enabled_pack_ids):
            raise self._schema_error(
                "campaign domain_pack.enabled_pack_ids is missing or invalid",
                extra={"campaign_id": campaign_id},
            )
        if pack_id not in enabled_pack_ids:
            raise self._schema_error(
                f"campaign domain_pack.pack_id not in enabled_pack_ids: {pack_id}",
                extra={"campaign_id": campaign_id},
            )

        try:
            return self.domain_pack_index.load(pack_id)
        except (KeyError, ValueError) as exc:
            raise self._schema_error(
                f"failed to load campaign domain pack {pack_id}: {exc}",
                extra={"campaign_id": campaign_id},
            ) from exc

    def _campaign_default_formalism_id(self, campaign: dict[str, Any]) -> str:
        campaign_id = campaign.get("campaign_id")
        try:
            return FormalismRegistry.from_payload(
                campaign.get("formalism_registry"),
                context="campaign formalism registry",
            ).default_formalism_id()
        except ValueError as exc:
            extra = {"campaign_id": campaign_id} if isinstance(campaign_id, str) else None
            raise self._schema_error(str(exc), extra=extra) from exc

    @classmethod
    def _sanitize_evidence_uris(cls, value: Any) -> list[str]:
        cleaned = sanitize_text_list(value, fallback=[])
        return cleaned or ["https://example.org/reference"]

    @classmethod
    def _node_claim_text(cls, node: dict[str, Any]) -> str:
        idea_card = node.get("idea_card")
        if isinstance(idea_card, dict):
            claims = idea_card.get("claims")
            if isinstance(claims, list):
                for claim in claims:
                    if not isinstance(claim, dict):
                        continue
                    claim_text = claim.get("claim_text")
                    if isinstance(claim_text, str) and claim_text.strip():
                        return sanitize_text(claim_text, fallback="")
        rationale = node.get("rationale_draft")
        if isinstance(rationale, dict):
            return sanitize_text(rationale.get("rationale"), fallback="")
        return ""

    @classmethod
    def _node_evidence_uris(cls, node: dict[str, Any]) -> list[str]:
        uris: list[str] = []
        idea_card = node.get("idea_card")
        if isinstance(idea_card, dict):
            claims = idea_card.get("claims")
            if isinstance(claims, list):
                for claim in claims:
                    if not isinstance(claim, dict):
                        continue
                    raw_uris = claim.get("evidence_uris")
                    if not isinstance(raw_uris, list):
                        continue
                    for uri in raw_uris:
                        if isinstance(uri, str) and uri.strip():
                            uris.append(uri)
        operator_trace = node.get("operator_trace")
        if isinstance(operator_trace, dict):
            raw_uris = operator_trace.get("evidence_uris_used")
            if isinstance(raw_uris, list):
                for uri in raw_uris:
                    if isinstance(uri, str) and uri.strip():
                        uris.append(uri)
        return dedupe_preserve_order(uris)

    @classmethod
    def _text_similarity(cls, left: str, right: str) -> float:
        left_tokens = token_set(left)
        right_tokens = token_set(right)
        if not left_tokens or not right_tokens:
            return 0.0
        overlap = left_tokens & right_tokens
        union = left_tokens | right_tokens
        return len(overlap) / len(union)

    @staticmethod
    def _priority_for_severity(severity: str) -> str:
        if severity == "critical":
            return "critical"
        if severity == "major":
            return "major"
        return "minor"

    @classmethod
    def _dedupe_fix_suggestions(cls, suggestions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str, str]] = set()
        for suggestion in suggestions:
            key = (
                str(suggestion.get("failure_mode", "")),
                str(suggestion.get("target_field", "")),
                str(suggestion.get("suggested_action", "")),
                str(suggestion.get("priority", "")),
            )
            if key in seen:
                continue
            seen.add(key)
            deduped.append(suggestion)
        return deduped

    @staticmethod
    def _constraint_failure_mode_token(
        constraint_policy: DomainConstraintPolicy,
        finding: dict[str, str],
    ) -> str:
        return (
            f"{constraint_policy.namespace}:{finding['heuristic_class']}:"
            f"{finding['validator_id']}:{finding['code']}:{finding['severity']}"
        )

    @classmethod
    def _append_domain_constraint_diagnostics(
        cls,
        *,
        node: dict[str, Any],
        failure_modes: list[str],
        fix_suggestions: list[dict[str, Any]],
        constraint_policy: DomainConstraintPolicy | None,
    ) -> None:
        if constraint_policy is None:
            return
        for finding in constraint_policy.build_findings(node):
            failure_modes.append(cls._constraint_failure_mode_token(constraint_policy, finding))
            suggestion = {
                "failure_mode": finding["failure_mode"],
                "suggested_action": finding["suggested_action"],
                "target_field": finding["target_field"],
                "priority": cls._priority_for_severity(finding["severity"]),
            }
            operator_hint = finding.get("operator_hint")
            if isinstance(operator_hint, str) and operator_hint:
                suggestion["operator_hint"] = operator_hint
            fix_suggestions.append(suggestion)

    @classmethod
    def _blocking_domain_failure_modes(
        cls,
        node: dict[str, Any],
        *,
        constraint_policy: DomainConstraintPolicy | None,
    ) -> list[str]:
        if constraint_policy is None:
            return []
        eval_info = node.get("eval_info")
        if not isinstance(eval_info, dict):
            return []
        raw_modes = eval_info.get("failure_modes")
        if not isinstance(raw_modes, list):
            return []
        blocking: list[str] = []
        for mode in raw_modes:
            if not isinstance(mode, str) or not mode.startswith(f"{constraint_policy.namespace}:"):
                continue
            segments = mode.split(":")
            if len(segments) < 5:
                continue
            if segments[-1] == "critical":
                blocking.append(mode)
        return dedupe_preserve_order(blocking)

    @classmethod
    def _infer_delta_types(cls, node: dict[str, Any]) -> list[str]:
        operator_id = sanitize_text(node.get("operator_id"), fallback="unknown")
        operator_family = sanitize_text(node.get("operator_family"), fallback="unknown")
        claim_text = cls._node_claim_text(node)
        joined = " ".join([operator_id, operator_family, claim_text]).lower()

        delta_types: list[str] = []
        if contains_any(joined, ("anomaly", "mechanism")):
            delta_types.extend(["new_mechanism", "new_observable"])
        if contains_any(joined, ("symmetry", "formalism", "selection rule")):
            delta_types.extend(["new_formalism", "new_constraint"])
        if contains_any(joined, ("limit", "scaling", "regime")):
            delta_types.extend(["new_regime", "new_constraint"])
        if contains_any(joined, ("constraint", "forbidden", "allowed transition")):
            delta_types.append("new_constraint")
        if contains_any(joined, ("bridge", "expand", "method", "reformulation")):
            delta_types.append("new_method")

        if not delta_types:
            delta_types.append("new_method")
        return dedupe_preserve_order(delta_types)

    @classmethod
    def _find_closest_prior(
        cls,
        *,
        node_id: str,
        node: dict[str, Any],
        nodes: dict[str, dict[str, Any]],
    ) -> tuple[dict[str, Any] | None, float]:
        parent_ids: list[str] = []
        raw_parent_ids = node.get("parent_node_ids")
        if isinstance(raw_parent_ids, list):
            for parent_id in raw_parent_ids:
                if isinstance(parent_id, str) and parent_id in nodes and parent_id != node_id:
                    parent_ids.append(parent_id)

        candidate_ids = list(parent_ids)
        for candidate_id in sorted(nodes.keys()):
            if candidate_id == node_id or candidate_id in candidate_ids:
                continue
            candidate_ids.append(candidate_id)

        current_claim = cls._node_claim_text(node)
        best_node: dict[str, Any] | None = None
        best_similarity = -1.0
        for candidate_id in candidate_ids:
            candidate = nodes[candidate_id]
            similarity = cls._text_similarity(current_claim, cls._node_claim_text(candidate))
            if similarity > best_similarity:
                best_similarity = similarity
                best_node = candidate
        return best_node, max(best_similarity, 0.0)

    @classmethod
    def _infer_non_novelty_flags(
        cls,
        *,
        node: dict[str, Any],
        prior_node: dict[str, Any] | None,
        claim_similarity: float,
    ) -> list[str]:
        flags: list[str] = []
        current_claim = cls._node_claim_text(node)

        if claim_similarity >= 0.92:
            flags.append("equivalent_reformulation")
        elif claim_similarity >= 0.72:
            flags.append("parameter_tuning_only")

        if prior_node is not None:
            current_uris = set(cls._node_evidence_uris(node))
            prior_uris = set(cls._node_evidence_uris(prior_node))
            if current_uris and prior_uris and current_uris.issubset(prior_uris):
                flags.append("known_components_no_testable_delta")

        predictive_keywords = (
            "predict",
            "observable",
            "testable",
            "signature",
            "scaling",
            "shift",
            "transition",
            "constraint",
        )
        if not contains_any(current_claim, predictive_keywords):
            flags.append("no_new_prediction")

        return dedupe_preserve_order(flags)

    @classmethod
    def _build_novelty_delta_table(
        cls,
        *,
        node_id: str,
        node: dict[str, Any],
        nodes: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        prior_node, claim_similarity = cls._find_closest_prior(
            node_id=node_id,
            node=node,
            nodes=nodes,
        )
        closest_prior_uris: list[str] = []
        if prior_node is not None:
            closest_prior_uris.extend(cls._node_evidence_uris(prior_node))
        closest_prior_uris.extend(cls._node_evidence_uris(node))
        closest_prior_uris = dedupe_preserve_order(closest_prior_uris)[:3]
        if not closest_prior_uris:
            closest_prior_uris = [f"urn:idea-core:novelty-prior-unavailable:{node_id}"]

        delta_types = cls._infer_delta_types(node)
        non_novelty_flags = cls._infer_non_novelty_flags(
            node=node,
            prior_node=prior_node,
            claim_similarity=claim_similarity,
        )
        operator_id = sanitize_text(node.get("operator_id"), fallback="unknown.operator")
        if non_novelty_flags:
            delta_statement = (
                f"{operator_id} must produce a measurable observable-1 shift beyond the closest prior "
                "baseline; otherwise classify this update as non-novel."
            )
        else:
            delta_statement = (
                f"{operator_id} proposes a testable delta that should change observable-1 relative to "
                "the closest prior baseline."
            )

        idea_card = node.get("idea_card", {})
        compute_plan = idea_card.get("minimal_compute_plan", []) if isinstance(idea_card, dict) else []
        method = operator_id
        if isinstance(compute_plan, list) and compute_plan:
            first_step = compute_plan[0]
            if isinstance(first_step, dict):
                method = sanitize_text(first_step.get("method"), fallback=operator_id)
        verification_hook = (
            f"Run {method} and compare observable-1 against the closest prior evidence baseline."
        )

        return [
            {
                "closest_prior_uris": closest_prior_uris,
                "delta_types": delta_types,
                "delta_statement": delta_statement,
                "non_novelty_flags": non_novelty_flags,
                "verification_hook": verification_hook,
            }
        ]

    @classmethod
    def _rationale_hash_for_trace(cls, rationale_draft: dict[str, Any]) -> str:
        title = sanitize_text(rationale_draft.get("title"), "Untitled rationale")
        rationale = sanitize_text(rationale_draft.get("rationale"), "No rationale provided.")
        return f"sha256:{sha256_hex(title + '|' + rationale)}"

    @classmethod
    def _formalize_rationale_to_idea_card(
        cls,
        *,
        rationale_draft: dict[str, Any],
        formalism_id: str,
        evidence_uris: Any,
        hypothesis: Any,
        claim_text: Any,
        support_type: str,
        compute_step: str,
        compute_method: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        title = sanitize_text(rationale_draft.get("title"), "Untitled rationale")
        rationale = sanitize_text(rationale_draft.get("rationale"), "No rationale provided.")
        risks = sanitize_text_list(rationale_draft.get("risks"), fallback=["risk not specified"])
        kill_criteria = sanitize_text_list(
            rationale_draft.get("kill_criteria"),
            fallback=["kill criterion not specified"],
        )
        thesis_statement = f"{title}: {rationale}"
        if len(thesis_statement) < 20:
            thesis_statement = (
                f"{thesis_statement} This rationale requires formal validation before promotion."
            )

        cleaned_hypothesis = sanitize_text(
            hypothesis,
            f"{title} should be testable in {formalism_id} with observable-1.",
        )
        cleaned_claim = sanitize_text(
            claim_text,
            f"{title} provides a falsifiable claim that can be checked against observable-1.",
        )
        cleaned_evidence_uris = cls._sanitize_evidence_uris(evidence_uris)

        idea_card = {
            "thesis_statement": thesis_statement,
            "testable_hypotheses": [cleaned_hypothesis],
            "required_observables": ["observable-1"],
            "candidate_formalisms": [formalism_id],
            "minimal_compute_plan": [
                {
                    "step": compute_step,
                    "method": compute_method,
                    "estimated_difficulty": "moderate",
                }
            ],
            "claims": [
                {
                    "claim_text": cleaned_claim,
                    "support_type": support_type,
                    "evidence_uris": cleaned_evidence_uris,
                }
            ],
        }

        formalization_trace = {
            "mode": "explain_then_formalize_deterministic_v1",
            "source_artifact": "rationale_draft",
            "rationale_hash": cls._rationale_hash_for_trace(rationale_draft),
            "input_fields": ["title", "rationale", "risks", "kill_criteria"],
            "risk_count": len(risks),
            "kill_criteria_count": len(kill_criteria),
        }
        return idea_card, formalization_trace

    def _validate_formalization_trace(
        self,
        *,
        node: dict[str, Any],
        campaign_id: str,
        node_id: str,
    ) -> None:
        operator_trace = node.get("operator_trace")
        if not isinstance(operator_trace, dict):
            raise self._schema_error(
                "formalization trace missing: operator_trace is not an object",
                extra={"campaign_id": campaign_id, "node_id": node_id},
            )
        params = operator_trace.get("params")
        if not isinstance(params, dict):
            raise self._schema_error(
                "formalization trace missing: operator_trace.params is not an object",
                extra={"campaign_id": campaign_id, "node_id": node_id},
            )
        formalization = params.get("formalization")
        if not isinstance(formalization, dict):
            raise self._schema_error(
                "formalization trace missing: operator_trace.params.formalization is not an object",
                extra={"campaign_id": campaign_id, "node_id": node_id},
            )

        mode = formalization.get("mode")
        if mode != "explain_then_formalize_deterministic_v1":
            raise self._schema_error(
                f"formalization trace invalid: unsupported mode {mode!r}",
                extra={"campaign_id": campaign_id, "node_id": node_id},
            )
        if formalization.get("source_artifact") != "rationale_draft":
            raise self._schema_error(
                "formalization trace invalid: source_artifact must be rationale_draft",
                extra={"campaign_id": campaign_id, "node_id": node_id},
            )

        recorded_hash = formalization.get("rationale_hash")
        expected_hash = self._rationale_hash_for_trace(node.get("rationale_draft", {}))
        if recorded_hash != expected_hash:
            raise self._schema_error(
                (
                    "formalization trace invalid: rationale_hash mismatch "
                    f"(recorded={recorded_hash!r}, expected={expected_hash!r})"
                ),
                extra={"campaign_id": campaign_id, "node_id": node_id},
            )

    def _seed_node(
        self,
        *,
        campaign_id: str,
        seed: dict[str, Any],
        formalism_id: str,
        index: int,
        island_id: str,
        now: str,
    ) -> dict[str, Any]:
        node_id = str(uuid4())
        idea_id = str(uuid4())
        content = seed["content"]
        prompt_hash = f"sha256:{sha256_hex(content)}"
        evidence_uris = self._sanitize_evidence_uris(seed.get("source_uris"))
        rationale_draft = {
            "title": f"Seed {index + 1}",
            "rationale": content,
            "risks": ["unverified hypothesis"],
            "kill_criteria": ["fails basic consistency checks"],
        }
        idea_card, formalization_trace = self._formalize_rationale_to_idea_card(
            rationale_draft=rationale_draft,
            formalism_id=formalism_id,
            evidence_uris=evidence_uris,
            hypothesis=f"Hypothesis from seed {index + 1}",
            claim_text=f"Seed-derived claim: {content}",
            support_type="literature",
            compute_step="construct toy estimate",
            compute_method="deterministic scoring stub",
        )

        return {
            "campaign_id": campaign_id,
            "idea_id": idea_id,
            "node_id": node_id,
            "revision": 1,
            "parent_node_ids": [],
            "island_id": island_id,
            "operator_id": "seed.import",
            "operator_family": "Seed",
            "origin": {
                "model": "seed_pack",
                "temperature": 0,
                "prompt_hash": prompt_hash,
                "timestamp": now,
                "role": "SeedImporter",
            },
            "operator_trace": {
                "inputs": {"seed_type": seed["seed_type"], "seed_index": index},
                "params": {"formalization": formalization_trace},
                "evidence_uris_used": evidence_uris,
            },
            "rationale_draft": rationale_draft,
            "idea_card": idea_card,
            "eval_info": None,
            "grounding_audit": None,
            "reduction_report": None,
            "reduction_audit": None,
            "created_at": now,
        }

    def campaign_init(self, params: dict[str, Any]) -> dict[str, Any]:
        idempotency_key = params["idempotency_key"]
        p_hash = self._hash_without_idempotency("campaign.init", params)
        with self.store.mutation_lock(None):
            replay = self._record_or_replay(
                method="campaign.init",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=None,
            )
            if replay is not None:
                kind, payload = replay
                if kind == "error":
                    raise RpcError(**payload)
                return payload

            now = utc_now_iso()
            campaign_id = str(uuid4())
            domain_pack, enabled_pack_ids = self._resolve_domain_pack_for_charter(params["charter"])
            default_formalisms = copy.deepcopy(domain_pack.formalism_registry)
            default_abstract_problems = copy.deepcopy(domain_pack.abstract_problem_registry)
            try:
                initial_island_count = self._resolve_initial_island_count(params["charter"])
            except ValueError as exc:
                error = self._schema_error(str(exc))
                self._store_idempotency(
                    method="campaign.init",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=None,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            seed_items = params["seed_pack"]["seeds"]
            if initial_island_count > len(seed_items):
                error = self._schema_error(
                    f"initial_island_count ({initial_island_count}) exceeds seed count ({len(seed_items)})"
                )
                self._store_idempotency(
                    method="campaign.init",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=None,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            user_abstract = params.get("abstract_problem_registry")
            if isinstance(user_abstract, dict):
                entries = user_abstract.get("entries", [])
                types = [entry["abstract_problem_type"] for entry in entries]
                if len(types) != len(set(types)):
                    data = {
                        "reason": "schema_invalid",
                        "details": {"message": "duplicate abstract_problem_type in abstract_problem_registry"},
                    }
                    self.catalog.validate_error_data(data)
                    error = RpcError(code=-32002, message="schema_validation_failed", data=data)
                    self._store_idempotency(
                        method="campaign.init",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=None,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error

            try:
                formalism_registry = FormalismRegistry.merge(
                    defaults=default_formalisms,
                    overrides=params.get("formalism_registry"),
                    context="effective formalism registry",
                ).to_payload()
            except ValueError as exc:
                error = self._schema_error(str(exc))
                self._store_idempotency(
                    method="campaign.init",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=None,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            abstract_problem_registry = self._merge_registry_entries(
                defaults=default_abstract_problems,
                overrides=user_abstract,
                key_name="abstract_problem_type",
            )

            campaign = {
                "campaign_id": campaign_id,
                "charter": params["charter"],
                "seed_pack": params["seed_pack"],
                "budget": params["budget"],
                "status": "running",
                "created_at": now,
                "usage": {
                    "tokens_used": 0,
                    "cost_usd_used": 0.0,
                    "wall_clock_s_elapsed": 0.0,
                    "steps_used": 0,
                    "nodes_used": 0,
                },
                "island_states": self._initial_island_states(initial_island_count),
                "formalism_registry": formalism_registry,
                "abstract_problem_registry": abstract_problem_registry,
                "domain_pack": {
                    "pack_id": domain_pack.pack_id,
                    "enabled_pack_ids": enabled_pack_ids,
                },
            }

            nodes: dict[str, dict[str, Any]] = {}
            first_formalism = FormalismRegistry.from_payload(
                formalism_registry,
                context="effective formalism registry",
            ).default_formalism_id()

            for index, seed in enumerate(seed_items):
                island_id = f"island-{index % initial_island_count}"
                node = self._seed_node(
                    campaign_id=campaign_id,
                    seed=seed,
                    formalism_id=first_formalism,
                    index=index,
                    island_id=island_id,
                    now=now,
                )
                try:
                    self.catalog.validate_against_ref(
                        "./idea_node_v1.schema.json",
                        node,
                        base_name=f"seed_node/{index}",
                    )
                except ContractRuntimeError as exc:
                    error = self._schema_error(
                        f"seed node {index} invalid: {exc}",
                        extra={"campaign_id": campaign_id},
                    )
                    self._store_idempotency(
                        method="campaign.init",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=None,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error
                nodes[node["node_id"]] = node

            campaign["usage"]["nodes_used"] = len(nodes)
            # Pre-existing helper (also used by search.step): keep population_size consistent.
            self._refresh_island_population_sizes(campaign, nodes)

            result = {
                "campaign_id": campaign_id,
                "status": "running",
                "created_at": now,
                "budget_snapshot": self._budget_snapshot(campaign),
                "island_states": campaign["island_states"],
                "idempotency": self._response_idempotency(idempotency_key, p_hash),
            }
            self.catalog.validate_result("campaign.init", result)
            self._store_idempotency(
                method="campaign.init",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=None,
                response=result,
                kind="result",
                state="prepared",
            )

            self.store.save_nodes(campaign_id, nodes)
            for node in nodes.values():
                self.store.append_node_log(campaign_id, node, mutation="create")
            self.store.save_campaign(campaign)

            self._store_idempotency(
                method="campaign.init",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=None,
                response=result,
                kind="result",
                state="committed",
            )
            return result

    def campaign_status(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        with self.store.mutation_lock(campaign_id):
            campaign = self._load_campaign_or_error(campaign_id)
            nodes = self.store.load_nodes(campaign["campaign_id"])
            status = {
                "campaign_id": campaign["campaign_id"],
                "status": campaign["status"],
                "created_at": campaign["created_at"],
                "budget_snapshot": self._budget_snapshot(campaign),
                "island_states": campaign["island_states"],
                "node_count": len(nodes),
            }
            if campaign["status"] == "early_stopped":
                status["early_stop_reason"] = campaign.get("early_stop_reason", "policy_halt")
            return status

    def _raise_not_implemented(self, method: str) -> None:
        data = {"reason": "method_not_implemented", "details": {"method": method}}
        self.catalog.validate_error_data(data)
        raise RpcError(
            code=-32000,
            message="method_not_implemented",
            data=data,
        )

    def campaign_topup(self, params: dict[str, Any]) -> dict[str, Any]:
        self._raise_not_implemented("campaign.topup")

    def campaign_pause(self, params: dict[str, Any]) -> dict[str, Any]:
        self._raise_not_implemented("campaign.pause")

    def campaign_resume(self, params: dict[str, Any]) -> dict[str, Any]:
        self._raise_not_implemented("campaign.resume")

    def campaign_complete(self, params: dict[str, Any]) -> dict[str, Any]:
        self._raise_not_implemented("campaign.complete")

    def _search_step_artifact_path(self, campaign_id: str, step_id: str) -> Path:
        return self.store.artifact_path(campaign_id, "search_steps", f"{step_id}.json")

    @staticmethod
    def _refresh_island_population_sizes(
        campaign: dict[str, Any],
        nodes: dict[str, dict[str, Any]],
    ) -> None:
        counts: dict[str, int] = {}
        for node in nodes.values():
            island_id = node.get("island_id")
            if isinstance(island_id, str):
                counts[island_id] = counts.get(island_id, 0) + 1
        for island in campaign.get("island_states", []):
            island_id = island.get("island_id")
            island["population_size"] = counts.get(island_id, 0)

    @staticmethod
    def _mark_islands_exhausted(campaign: dict[str, Any]) -> None:
        for island in campaign.get("island_states", []):
            island["state"] = "EXHAUSTED"

    @staticmethod
    def _pick_parent_node(
        nodes: dict[str, dict[str, Any]],
        *,
        island_id: str,
    ) -> dict[str, Any] | None:
        island_nodes = [node for node in nodes.values() if node.get("island_id") == island_id]
        if not island_nodes:
            return None
        island_nodes.sort(key=lambda node: (str(node.get("created_at", "")), node["node_id"]))
        return island_nodes[0]

    @staticmethod
    def _next_search_operator(
        runtime: dict[str, Any],
        search_operators: tuple[SearchOperator, ...],
    ) -> SearchOperator:
        # round_robin_v1 selection policy (mutates runtime counter); used via _choose_search_operator.
        next_operator_index = int(runtime.get("next_operator_index", 0))
        chosen_index = next_operator_index % len(search_operators)
        runtime["next_operator_index"] = (chosen_index + 1) % len(search_operators)
        return search_operators[chosen_index]

    @classmethod
    def _choose_search_operator(
        cls,
        runtime: dict[str, Any],
        search_operators: tuple[SearchOperator, ...],
        *,
        island_id: str,
        selection_policy: str,
    ) -> SearchOperator:
        if selection_policy == "island_index_v1":
            parts = island_id.split("-", 1)
            if len(parts) == 2 and parts[0] == "island" and parts[1].isdigit():
                index = int(parts[1])
                return search_operators[index % len(search_operators)]
        return cls._next_search_operator(runtime, search_operators)

    def _build_operator_node(
        self,
        *,
        campaign_id: str,
        island_id: str,
        parent_node_id: str,
        formalism_id: str,
        operator_output: OperatorOutput,
        evidence_uris: list[str] | None,
        now: str,
    ) -> dict[str, Any]:
        idea_id = str(uuid4())
        node_id = str(uuid4())
        prompt_fingerprint = (
            f"{operator_output.operator_id}|{campaign_id}|{island_id}|{parent_node_id}|{operator_output.hypothesis}"
        )
        evidence_uris = self._sanitize_evidence_uris(
            evidence_uris if evidence_uris is not None else operator_output.evidence_uris_used
        )
        rationale_draft = {
            "title": operator_output.rationale_title,
            "rationale": operator_output.rationale,
            "risks": ["dummy_operator_unverified"],
            "kill_criteria": [
                "fails deterministic consistency check",
                "fails eval.run grounding gate",
            ],
        }
        idea_card, formalization_trace = self._formalize_rationale_to_idea_card(
            rationale_draft=rationale_draft,
            formalism_id=formalism_id,
            evidence_uris=evidence_uris,
            hypothesis=operator_output.hypothesis,
            claim_text=operator_output.claim_text,
            support_type="calculation",
            compute_step="run deterministic operator smoke check",
            compute_method=operator_output.operator_id,
        )

        trace_params = copy.deepcopy(operator_output.trace_params)
        trace_params.setdefault("backend_id", operator_output.backend_id)
        trace_params["formalization"] = formalization_trace

        return {
            "campaign_id": campaign_id,
            "idea_id": idea_id,
            "node_id": node_id,
            "revision": 1,
            "parent_node_ids": [parent_node_id],
            "island_id": island_id,
            "operator_id": operator_output.operator_id,
            "operator_family": operator_output.operator_family,
            "origin": {
                "model": operator_output.backend_id,
                "temperature": 0.0,
                "prompt_hash": f"sha256:{sha256_hex(prompt_fingerprint)}",
                "timestamp": now,
                "role": "OperatorRunner",
            },
            "operator_trace": {
                "inputs": copy.deepcopy(operator_output.trace_inputs),
                "params": trace_params,
                "evidence_uris_used": evidence_uris,
            },
            "rationale_draft": rationale_draft,
            "idea_card": idea_card,
            "eval_info": None,
            "grounding_audit": None,
            "reduction_report": None,
            "reduction_audit": None,
            "created_at": now,
        }

    @staticmethod
    def _step_budget_exhausted(local_usage: dict[str, float], step_budget: dict[str, Any] | None) -> bool:
        if not isinstance(step_budget, dict):
            return False
        if "max_steps" in step_budget and local_usage["steps"] >= float(step_budget["max_steps"]):
            return True
        if "max_nodes" in step_budget and local_usage["nodes"] >= float(step_budget["max_nodes"]):
            return True
        if "max_tokens" in step_budget and local_usage["tokens"] >= float(step_budget["max_tokens"]):
            return True
        if "max_cost_usd" in step_budget and local_usage["cost_usd"] >= float(step_budget["max_cost_usd"]):
            return True
        if "max_wall_clock_s" in step_budget and local_usage["wall_clock_s"] >= float(step_budget["max_wall_clock_s"]):
            return True
        return False

    @staticmethod
    def _node_score(node: dict[str, Any]) -> float | None:
        eval_info = node.get("eval_info")
        if not isinstance(eval_info, dict):
            return None
        scores = eval_info.get("scores")
        if not isinstance(scores, dict):
            return None
        values = [float(v) for v in scores.values() if isinstance(v, (int, float))]
        if not values:
            return None
        return sum(values) / len(values)

    @classmethod
    def _island_best_score(cls, nodes: dict[str, dict[str, Any]], island_id: str) -> float | None:
        best: float | None = None
        for node in nodes.values():
            if node.get("island_id") != island_id:
                continue
            score = cls._node_score(node)
            if score is None:
                continue
            if best is None or score > best:
                best = score
        return best

    @staticmethod
    def _is_score_improved(previous_best: Any, current_best: float) -> bool:
        if not isinstance(previous_best, (int, float)):
            return True
        return current_best > float(previous_best) + BEST_SCORE_EPSILON

    @staticmethod
    def _advance_island_state_one_tick(
        island: dict[str, Any],
        *,
        stagnation_patience: int = STAGNATION_PATIENCE_STEPS,
        score_improved: bool = False,
    ) -> tuple[str, str, str]:
        previous_state = str(island.get("state", "SEEDING"))
        stagnation_counter = int(island.get("stagnation_counter", 0))
        repopulation_count = int(island.get("repopulation_count", 0))

        next_state = previous_state
        transition_reason = "no_change"

        if previous_state == "SEEDING":
            next_state = "EXPLORING"
            stagnation_counter = 0
            transition_reason = "seeded_population_ready"
        elif previous_state in {"EXPLORING", "CONVERGING"}:
            if score_improved:
                next_state = "CONVERGING"
                stagnation_counter = 0
                transition_reason = "best_score_improved"
            else:
                stagnation_counter += 1
                if stagnation_counter >= stagnation_patience:
                    next_state = "STAGNANT"
                    transition_reason = "stagnation_threshold_reached"
                else:
                    next_state = previous_state
                    transition_reason = "stagnation_counter_incremented"
        elif previous_state == "STAGNANT":
            next_state = "REPOPULATED"
            stagnation_counter = 0
            repopulation_count += 1
            transition_reason = "repopulate_triggered"
        elif previous_state == "REPOPULATED":
            next_state = "EXPLORING"
            stagnation_counter = 0
            transition_reason = "resume_exploration_after_repopulate"
        elif previous_state == "EXHAUSTED":
            # M2.5 semantics: island-level EXHAUSTED is terminal.
            # Revival via campaign.topup/campaign.resume is deferred to later milestones.
            next_state = "EXHAUSTED"
            transition_reason = "terminal"

        island["state"] = next_state
        island["stagnation_counter"] = max(stagnation_counter, 0)
        island["repopulation_count"] = max(repopulation_count, 0)
        island.setdefault("best_score", None)

        return previous_state, next_state, transition_reason

    def search_step(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        idempotency_key = params["idempotency_key"]
        n_steps_requested = int(params["n_steps"])
        step_budget = params.get("step_budget")
        p_hash = self._hash_without_idempotency("search.step", params)

        with self.store.mutation_lock(campaign_id):
            replay = self._record_or_replay(
                method="search.step",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
            )
            if replay is not None:
                kind, payload = replay
                if kind == "error":
                    raise RpcError(**payload)
                return payload

            campaign = self._load_campaign_or_error(campaign_id)
            self._ensure_campaign_running(campaign)
            domain_pack = self._load_campaign_domain_pack(campaign)
            search_operators = domain_pack.search_operators

            nodes = self.store.load_nodes(campaign_id)
            step_id = str(uuid4())
            planned_campaign = copy.deepcopy(campaign)
            if not planned_campaign.get("island_states"):
                planned_campaign["island_states"] = [
                    {
                        "island_id": "island-0",
                        "state": "SEEDING",
                        "population_size": 0,
                        "stagnation_counter": 0,
                        "repopulation_count": 0,
                        "best_score": None,
                    }
                ]
            planned_campaign.setdefault("search_runtime", {})
            self._refresh_island_population_sizes(planned_campaign, nodes)

            n_steps_executed = 0
            early_stop_reason: str | None = None
            local_usage: dict[str, float] = {
                # M2.6 minimally charges step+node counters during operator execution.
                # Token/cost/time accounting remains deferred for later milestones.
                "tokens": 0.0,
                "cost_usd": 0.0,
                "wall_clock_s": 0.0,
                "steps": 0.0,
                "nodes": 0.0,
            }
            transition_events: list[dict[str, Any]] = []
            operator_events: list[dict[str, Any]] = []
            operator_trace_artifacts: list[tuple[str, dict[str, Any]]] = []
            librarian_evidence_artifacts: list[tuple[str, dict[str, Any]]] = []
            new_node_ids: list[str] = []
            new_nodes_payload: list[dict[str, Any]] = []

            default_formalism = self._campaign_default_formalism_id(planned_campaign)

            for tick in range(n_steps_requested):
                if self._step_budget_exhausted(local_usage, step_budget):
                    early_stop_reason = "step_budget_exhausted"
                    break

                if self._exhausted_dimensions(planned_campaign):
                    planned_campaign["status"] = "exhausted"
                    self._mark_islands_exhausted(planned_campaign)
                    early_stop_reason = "budget_exhausted"
                    break

                islands = planned_campaign["island_states"]
                runtime = planned_campaign["search_runtime"]
                next_island_index = int(runtime.get("next_island_index", 0))
                chosen_index = next_island_index % len(islands)
                runtime["next_island_index"] = (chosen_index + 1) % len(islands)

                island = islands[chosen_index]
                island_id = str(island.get("island_id", f"island-{chosen_index}"))
                current_best_score = self._island_best_score(nodes, island_id)
                previous_best_score = island.get("best_score")
                score_improved = False
                if current_best_score is not None:
                    score_improved = self._is_score_improved(previous_best_score, current_best_score)
                    island["best_score"] = current_best_score

                from_state, to_state, reason = self._advance_island_state_one_tick(
                    island,
                    score_improved=score_improved,
                )
                transition_event: dict[str, Any] = {
                    "tick": tick + 1,
                    "island_id": island_id,
                    "from_state": from_state,
                    "to_state": to_state,
                    "reason": reason,
                    "score_improved": score_improved,
                    "best_score": island.get("best_score"),
                }

                parent_node = self._pick_parent_node(nodes, island_id=island_id)
                if parent_node is not None and island.get("state") != "EXHAUSTED":
                    operator = self._choose_search_operator(
                        runtime,
                        search_operators,
                        island_id=island_id,
                        selection_policy=domain_pack.operator_selection_policy,
                    )
                    context = OperatorContext(
                        campaign_id=campaign_id,
                        step_id=step_id,
                        tick=tick + 1,
                        island_id=island_id,
                        parent_node_id=parent_node["node_id"],
                        formalism_id=default_formalism,
                    )
                    operator_output = operator.run(context, parent_node=copy.deepcopy(parent_node))
                    now = utc_now_iso()
                    evidence_packet_name = f"{step_id}-tick-{tick + 1:03d}-librarian.json"
                    evidence_packet_ref = self.store.artifact_path(
                        campaign_id,
                        "evidence_packets",
                        evidence_packet_name,
                    ).resolve().as_uri()
                    evidence_packet_payload = domain_pack.librarian_recipes.build_packet(
                        campaign_id=campaign_id,
                        step_id=step_id,
                        tick=tick + 1,
                        island_id=island_id,
                        operator_output=operator_output,
                        domain=str(planned_campaign.get("charter", {}).get("domain", "")),
                        formalism_id=default_formalism,
                        generated_at=now,
                    )
                    combined_evidence_uris = domain_pack.librarian_recipes.claim_evidence_uris(
                        packet_ref=evidence_packet_ref,
                        packet_payload=evidence_packet_payload,
                        operator_evidence_uris=self._sanitize_evidence_uris(
                            operator_output.evidence_uris_used
                        ),
                    )

                    new_node = self._build_operator_node(
                        campaign_id=campaign_id,
                        island_id=island_id,
                        parent_node_id=parent_node["node_id"],
                        formalism_id=default_formalism,
                        operator_output=operator_output,
                        evidence_uris=combined_evidence_uris,
                        now=now,
                    )
                    try:
                        self.catalog.validate_against_ref(
                            "./idea_node_v1.schema.json",
                            new_node,
                            base_name=f"search.step/node/{new_node['node_id']}",
                        )
                    except ContractRuntimeError as exc:
                        raise self._schema_error(
                            f"search.step generated invalid node: {exc}",
                            extra={"campaign_id": campaign_id},
                        ) from exc

                    nodes[new_node["node_id"]] = new_node
                    new_node_ids.append(new_node["node_id"])
                    new_nodes_payload.append(copy.deepcopy(new_node))
                    librarian_evidence_artifacts.append((evidence_packet_name, evidence_packet_payload))
                    planned_campaign["usage"]["nodes_used"] += 1
                    local_usage["nodes"] += 1

                    trace_artifact_name = f"{step_id}-tick-{tick + 1:03d}.json"
                    trace_artifact_ref = self.store.artifact_path(
                        campaign_id,
                        "operator_traces",
                        trace_artifact_name,
                    ).resolve().as_uri()
                    trace_payload = {
                        "campaign_id": campaign_id,
                        "step_id": step_id,
                        "tick": tick + 1,
                        "island_id": island_id,
                        "operator_id": operator_output.operator_id,
                        "operator_family": operator_output.operator_family,
                        "backend_id": operator_output.backend_id,
                        "parent_node_id": parent_node["node_id"],
                        "new_node_id": new_node["node_id"],
                        "operator_trace": copy.deepcopy(new_node["operator_trace"]),
                        "evidence_packet_ref": evidence_packet_ref,
                        "generated_at": now,
                    }
                    operator_trace_artifacts.append((trace_artifact_name, trace_payload))
                    operator_events.append(
                        {
                            "tick": tick + 1,
                            "island_id": island_id,
                            "operator_id": operator_output.operator_id,
                            "operator_family": operator_output.operator_family,
                            "backend_id": operator_output.backend_id,
                            "parent_node_id": parent_node["node_id"],
                            "new_node_id": new_node["node_id"],
                            "operator_trace_artifact_ref": trace_artifact_ref,
                            "evidence_packet_ref": evidence_packet_ref,
                        }
                    )
                    transition_event["operator_id"] = operator_output.operator_id
                    transition_event["new_node_id"] = new_node["node_id"]
                else:
                    transition_event["operator_skipped"] = "no_parent_node"

                transition_events.append(transition_event)

                planned_campaign["usage"]["steps_used"] += 1
                planned_campaign["last_step_id"] = step_id
                local_usage["steps"] += 1
                n_steps_executed += 1
                self._set_campaign_running_if_budget_available(planned_campaign)

                if planned_campaign["status"] == "exhausted":
                    self._mark_islands_exhausted(planned_campaign)
                    if n_steps_executed < n_steps_requested:
                        early_stop_reason = "budget_exhausted"
                    break

            self._refresh_island_population_sizes(planned_campaign, nodes)

            new_nodes_artifact_name: str | None = None
            new_nodes_artifact_ref: str | None = None
            if new_node_ids:
                new_nodes_artifact_name = f"{step_id}-new-nodes.json"
                new_nodes_artifact_ref = self.store.artifact_path(
                    campaign_id,
                    "search_steps",
                    new_nodes_artifact_name,
                ).resolve().as_uri()

            result = {
                "campaign_id": campaign_id,
                "step_id": step_id,
                "n_steps_requested": n_steps_requested,
                "n_steps_executed": n_steps_executed,
                "new_node_ids": new_node_ids,
                "updated_node_ids": [],
                "island_states": copy.deepcopy(planned_campaign["island_states"]),
                "budget_snapshot": self._budget_snapshot(planned_campaign),
                "idempotency": self._response_idempotency(idempotency_key, p_hash),
            }
            if new_nodes_artifact_ref is not None:
                result["new_nodes_artifact_ref"] = new_nodes_artifact_ref
            if early_stop_reason is not None:
                result["early_stopped"] = True
                result["early_stop_reason"] = early_stop_reason

            self.catalog.validate_result("search.step", result)
            self._store_idempotency(
                method="search.step",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="prepared",
            )

            if new_nodes_artifact_name is not None and new_nodes_artifact_ref is not None:
                self.store.write_artifact(
                    campaign_id,
                    "search_steps",
                    new_nodes_artifact_name,
                    {
                        "campaign_id": campaign_id,
                        "step_id": step_id,
                        "new_node_ids": new_node_ids,
                        "nodes": new_nodes_payload,
                        "operator_events": operator_events,
                        "generated_at": utc_now_iso(),
                    },
                )

            for artifact_name, payload in operator_trace_artifacts:
                self.store.write_artifact(
                    campaign_id,
                    "operator_traces",
                    artifact_name,
                    payload,
                )

            for artifact_name, payload in librarian_evidence_artifacts:
                self.store.write_artifact(
                    campaign_id,
                    "evidence_packets",
                    artifact_name,
                    payload,
                )

            step_artifact = {
                "campaign_id": campaign_id,
                "step_id": step_id,
                "n_steps_requested": n_steps_requested,
                "n_steps_executed": n_steps_executed,
                "transition_events": transition_events,
                "operator_events": operator_events,
                "new_node_ids": new_node_ids,
                "new_nodes_artifact_ref": new_nodes_artifact_ref,
                "step_budget": step_budget,
                "budget_snapshot": result["budget_snapshot"],
                "island_states": result["island_states"],
                "early_stopped": result.get("early_stopped", False),
                "early_stop_reason": result.get("early_stop_reason"),
                "generated_at": utc_now_iso(),
            }
            self.store.write_artifact(
                campaign_id,
                "search_steps",
                f"{step_id}.json",
                step_artifact,
            )
            self.store.save_nodes(campaign_id, nodes)
            for node_id in new_node_ids:
                self.store.append_node_log(campaign_id, nodes[node_id], mutation="create")
            self.store.save_campaign(planned_campaign)

            self._store_idempotency(
                method="search.step",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="committed",
            )
            return result

    def node_get(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        node_id = params["node_id"]
        with self.store.mutation_lock(campaign_id):
            campaign = self._load_campaign_or_error(campaign_id)
            nodes = self.store.load_nodes(campaign["campaign_id"])
            node = nodes.get(node_id)
            if node is None:
                data = {"reason": "node_not_found", "campaign_id": campaign_id, "node_id": node_id}
                self.catalog.validate_error_data(data)
                raise RpcError(code=-32004, message="node_not_found", data=data)
            if node.get("campaign_id") != campaign_id:
                data = {"reason": "node_not_in_campaign", "campaign_id": campaign_id, "node_id": node_id}
                self.catalog.validate_error_data(data)
                raise RpcError(code=-32014, message="node_not_in_campaign", data=data)
            return node

    def node_list(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        with self.store.mutation_lock(campaign_id):
            campaign = self._load_campaign_or_error(campaign_id)
            nodes = self.store.load_nodes(campaign["campaign_id"])
            filtered = self._filter_nodes(nodes, params.get("filter"))
            filtered.sort(key=lambda n: (n.get("created_at", ""), n["node_id"]))

            raw_cursor = params.get("cursor")
            if raw_cursor is None:
                start = 0
            else:
                try:
                    start = int(raw_cursor)
                except ValueError as exc:
                    raise self._schema_error("cursor must be an integer offset string") from exc
                if start < 0:
                    raise self._schema_error("cursor must be >= 0")

            limit = int(params.get("limit", 50))
            page = filtered[start : start + limit]
            next_cursor = None
            if start + limit < len(filtered):
                next_cursor = str(start + limit)

            return {
                "campaign_id": campaign_id,
                "nodes": page,
                "cursor": next_cursor,
                "total_count": len(filtered),
            }

    def _deterministic_score(self, node_id: str, dimension: str) -> float:
        token = f"{node_id}:{dimension}".encode("utf-8")
        value = int(hashlib.sha256(token).hexdigest()[:8], 16)
        return round((value % 1000) / 1000.0, 6)

    def _set_campaign_running_if_budget_available(self, campaign: dict[str, Any]) -> None:
        if self._exhausted_dimensions(campaign):
            campaign["status"] = "exhausted"
        elif campaign["status"] == "exhausted":
            campaign["status"] = "running"

    def eval_run(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        idempotency_key = params["idempotency_key"]
        p_hash = self._hash_without_idempotency("eval.run", params)
        with self.store.mutation_lock(campaign_id):
            replay = self._record_or_replay(
                method="eval.run",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
            )
            if replay is not None:
                kind, payload = replay
                if kind == "error":
                    raise RpcError(**payload)
                return payload

            campaign = self._load_campaign_or_error(campaign_id)
            self._ensure_campaign_running(campaign)
            domain_pack = self._load_campaign_domain_pack(campaign)

            nodes = self.store.load_nodes(campaign_id)
            node_ids = params["node_ids"]
            for node_id in node_ids:
                if node_id not in nodes:
                    data = {
                        "reason": "node_not_found",
                        "campaign_id": campaign_id,
                        "node_id": node_id,
                    }
                    self.catalog.validate_error_data(data)
                    error = RpcError(code=-32004, message="node_not_found", data=data)
                    self._store_idempotency(
                        method="eval.run",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=campaign_id,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error
                if nodes[node_id].get("campaign_id") != campaign_id:
                    data = {
                        "reason": "node_not_in_campaign",
                        "campaign_id": campaign_id,
                        "node_id": node_id,
                    }
                    self.catalog.validate_error_data(data)
                    error = RpcError(code=-32014, message="node_not_in_campaign", data=data)
                    self._store_idempotency(
                        method="eval.run",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=campaign_id,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error

            dims = params["evaluator_config"]["dimensions"]
            n_reviewers = params["evaluator_config"]["n_reviewers"]
            now = utc_now_iso()

            scorecards: list[dict[str, Any]] = []
            updated_nodes: dict[str, dict[str, Any]] = copy.deepcopy(nodes)
            node_revisions: dict[str, int] = {}

            for node_id in node_ids:
                node = updated_nodes[node_id]
                scores = {dim: self._deterministic_score(node_id, dim) for dim in dims}
                novelty_delta_table: list[dict[str, Any]] | None = None
                fix_suggestions: list[dict[str, Any]] = []
                failure_modes: list[str] = []

                if "novelty" in dims:
                    novelty_delta_table = self._build_novelty_delta_table(
                        node_id=node_id,
                        node=node,
                        nodes=nodes,
                    )
                    non_novelty_flags: list[str] = []
                    for delta_row in novelty_delta_table:
                        row_flags = delta_row.get("non_novelty_flags")
                        if isinstance(row_flags, list):
                            for flag in row_flags:
                                if isinstance(flag, str):
                                    non_novelty_flags.append(flag)
                    non_novelty_flags = dedupe_preserve_order(non_novelty_flags)
                    if non_novelty_flags:
                        failure_modes.extend([f"non_novel:{flag}" for flag in non_novelty_flags])
                        fix_suggestions.append(
                            {
                                "failure_mode": "too_similar",
                                "suggested_action": (
                                    "Provide a testable delta (new observable/mechanism/regime) and "
                                    "update idea_card claims to include falsifiable novelty evidence."
                                ),
                                "target_field": "idea_card.claims[0].claim_text",
                                "priority": "major",
                            }
                        )

                self._append_domain_constraint_diagnostics(
                    node=node,
                    failure_modes=failure_modes,
                    fix_suggestions=fix_suggestions,
                    constraint_policy=domain_pack.constraint_policy,
                )
                failure_modes = dedupe_preserve_order(failure_modes)
                fix_suggestions = self._dedupe_fix_suggestions(fix_suggestions)

                scorecard = {
                    "node_id": node_id,
                    "scores": scores,
                    "reviewer_count": n_reviewers,
                    "status": "complete",
                    "fix_suggestions": copy.deepcopy(fix_suggestions),
                    "failure_modes": copy.deepcopy(failure_modes),
                }
                if novelty_delta_table is not None:
                    scorecard["novelty_delta_table"] = copy.deepcopy(novelty_delta_table)
                scorecards.append(scorecard)

                node["eval_info"] = {
                    "scores": scores,
                    "fix_suggestions": copy.deepcopy(fix_suggestions),
                    "failure_modes": copy.deepcopy(failure_modes),
                }
                if novelty_delta_table is not None:
                    node["eval_info"]["novelty_delta_table"] = copy.deepcopy(novelty_delta_table)
                if "grounding" in dims:
                    node["grounding_audit"] = {
                        "status": "pass",
                        "folklore_risk_score": 0.2,
                        "failures": [],
                        "timestamp": now,
                    }
                node["revision"] = int(node["revision"]) + 1
                node["updated_at"] = now
                node_revisions[node_id] = node["revision"]
                self.catalog.validate_against_ref(
                    "./idea_node_v1.schema.json",
                    node,
                    base_name=f"eval.run/node/{node_id}",
                )

            scorecards_payload = {
                "campaign_id": campaign_id,
                "generated_at": now,
                "evaluator_config": params["evaluator_config"],
                "scorecards": scorecards,
            }
            self.catalog.validate_against_ref(
                "./idea_scorecards_v1.schema.json",
                scorecards_payload,
                base_name=f"eval.run/scorecards/{campaign_id}",
            )
            artifact_name = f"scorecards-{uuid4()}.json"
            scorecards_ref = self.store.artifact_path(
                campaign_id,
                "scorecards",
                artifact_name,
            ).resolve().as_uri()

            planned_campaign = copy.deepcopy(campaign)
            planned_campaign["last_scorecards_artifact_ref"] = scorecards_ref
            planned_campaign["usage"]["steps_used"] += 1
            self._set_campaign_running_if_budget_available(planned_campaign)

            result = {
                "campaign_id": campaign_id,
                "node_ids": node_ids,
                "updated_node_ids": node_ids,
                "node_revisions": node_revisions,
                "scorecards_artifact_ref": scorecards_ref,
                "budget_snapshot": self._budget_snapshot(planned_campaign),
                "idempotency": self._response_idempotency(idempotency_key, p_hash),
            }
            self.catalog.validate_result("eval.run", result)
            self._store_idempotency(
                method="eval.run",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="prepared",
            )

            self.store.write_artifact(
                campaign_id,
                "scorecards",
                artifact_name,
                scorecards_payload,
            )
            self.store.save_nodes(campaign_id, updated_nodes)
            for node_id in node_ids:
                self.store.append_node_log(campaign_id, updated_nodes[node_id], mutation="eval.update")
            self.store.save_campaign(planned_campaign)

            self._store_idempotency(
                method="eval.run",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="committed",
            )
            return result

    def _filter_nodes(
        self,
        nodes: dict[str, dict[str, Any]],
        filter_obj: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if not filter_obj:
            return list(nodes.values())

        def matches(node: dict[str, Any]) -> bool:
            if "idea_id" in filter_obj and node.get("idea_id") != filter_obj["idea_id"]:
                return False
            if "node_id" in filter_obj and node.get("node_id") != filter_obj["node_id"]:
                return False
            if "island_id" in filter_obj and node.get("island_id") != filter_obj["island_id"]:
                return False
            if "operator_id" in filter_obj and node.get("operator_id") != filter_obj["operator_id"]:
                return False
            if "has_idea_card" in filter_obj:
                want = filter_obj["has_idea_card"]
                if (node.get("idea_card") is not None) != want:
                    return False
            if "has_eval_info" in filter_obj:
                want = filter_obj["has_eval_info"]
                if (node.get("eval_info") is not None) != want:
                    return False
            if "has_reduction_report" in filter_obj:
                want = filter_obj["has_reduction_report"]
                if (node.get("reduction_report") is not None) != want:
                    return False
            if "grounding_status" in filter_obj:
                actual = None
                if isinstance(node.get("grounding_audit"), dict):
                    actual = node["grounding_audit"].get("status")
                if actual != filter_obj["grounding_status"]:
                    return False
            return True

        return [node for node in nodes.values() if matches(node)]

    @staticmethod
    def _scorecard_index(scorecards_payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
        idx: dict[str, dict[str, Any]] = {}
        for card in scorecards_payload.get("scorecards", []):
            idx[card["node_id"]] = card
        return idx

    @staticmethod
    def _ordered_dimensions(items: Iterable[str]) -> list[str]:
        item_set = set(items)
        return [dim for dim in DIMENSION_ORDER if dim in item_set]

    def _insufficient_eval_data_error(
        self,
        *,
        reason: str,
        campaign_id: str,
    ) -> RpcError:
        data = {"reason": reason, "campaign_id": campaign_id}
        self.catalog.validate_error_data(data)
        return RpcError(code=-32013, message="insufficient_eval_data", data=data)

    def rank_compute(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        method = params["method"]
        idempotency_key = params["idempotency_key"]
        p_hash = self._hash_without_idempotency("rank.compute", params)
        with self.store.mutation_lock(campaign_id):
            replay = self._record_or_replay(
                method="rank.compute",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
            )
            if replay is not None:
                kind, payload = replay
                if kind == "error":
                    raise RpcError(**payload)
                return payload

            campaign = self._load_campaign_or_error(campaign_id)
            self._ensure_campaign_running(campaign)

            elo_config = params.get("elo_config")
            if method == "elo" and elo_config is None:
                data = {"reason": "elo_config_required", "campaign_id": campaign_id}
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32002, message="schema_validation_failed", data=data)
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error
            if method == "pareto" and elo_config is not None:
                data = {"reason": "elo_config_unexpected", "campaign_id": campaign_id}
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32002, message="schema_validation_failed", data=data)
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            scorecards_ref = params.get("scorecards_artifact_ref") or campaign.get(
                "last_scorecards_artifact_ref"
            )
            if not scorecards_ref:
                error = self._insufficient_eval_data_error(reason="no_scorecards", campaign_id=campaign_id)
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            try:
                scorecards_payload = self.store.load_artifact_from_ref(scorecards_ref)
            except FileNotFoundError:
                raise self._schema_error(
                    "scorecards_artifact_ref not resolvable",
                    extra={"campaign_id": campaign_id},
                )

            nodes = self.store.load_nodes(campaign_id)
            resolved_nodes = self._filter_nodes(nodes, params.get("filter"))
            resolved_node_ids = {node["node_id"] for node in resolved_nodes}
            scorecard_map = self._scorecard_index(scorecards_payload)
            resolved_scorecards = [scorecard_map[nid] for nid in resolved_node_ids if nid in scorecard_map]

            observed_keys: set[str] = set()
            for card in resolved_scorecards:
                if card.get("status") in {"complete", "partial"}:
                    observed_keys.update(card.get("scores", {}).keys())

            # Normative failure order: no_scorecards -> insufficient_dimensions -> insufficient_nodes
            if not observed_keys:
                error = self._insufficient_eval_data_error(reason="no_scorecards", campaign_id=campaign_id)
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            requested_dimensions = params.get("dimensions")
            if requested_dimensions:
                effective_dimensions = self._ordered_dimensions(
                    dim for dim in requested_dimensions if dim in observed_keys
                )
            else:
                effective_dimensions = self._ordered_dimensions(observed_keys)

            if method == "pareto" and len(effective_dimensions) < 2:
                error = self._insufficient_eval_data_error(
                    reason="insufficient_dimensions",
                    campaign_id=campaign_id,
                )
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            usable_nodes = []
            for node in resolved_nodes:
                card = scorecard_map.get(node["node_id"])
                if not card:
                    continue
                if card.get("status") == "failed":
                    continue
                usable_nodes.append(node)

            if (method == "elo" and len(usable_nodes) < 2) or (
                method == "pareto" and len(usable_nodes) < 1
            ):
                error = self._insufficient_eval_data_error(
                    reason="insufficient_nodes",
                    campaign_id=campaign_id,
                )
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            scored_rows: list[dict[str, Any]] = []
            for node in usable_nodes:
                card = scorecard_map.get(node["node_id"])
                scores = card.get("scores", {})
                aggregate = sum(float(scores.get(dim, 0.0)) for dim in effective_dimensions)
                row: dict[str, Any] = {
                    "node_id": node["node_id"],
                    "idea_id": node["idea_id"],
                    "_aggregate": aggregate,
                }
                if method == "elo":
                    row["elo_rating"] = round(1000 + aggregate * 100, 6)
                else:
                    row["pareto_front"] = False
                scored_rows.append(row)

            scored_rows.sort(key=lambda r: r["_aggregate"], reverse=True)
            ranked_nodes: list[dict[str, Any]] = []
            for rank, row in enumerate(scored_rows, start=1):
                entry = {"node_id": row["node_id"], "idea_id": row["idea_id"], "rank": rank}
                if method == "elo":
                    entry["elo_rating"] = row["elo_rating"]
                else:
                    entry["pareto_front"] = rank == 1
                ranked_nodes.append(entry)

            if not ranked_nodes:
                error = self._insufficient_eval_data_error(reason="insufficient_nodes", campaign_id=campaign_id)
                self._store_idempotency(
                    method="rank.compute",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            ranking_artifact_name = f"ranking-{uuid4()}.json"
            ranking_artifact_ref = self.store.artifact_path(
                campaign_id,
                "rankings",
                ranking_artifact_name,
            ).resolve().as_uri()
            ranking_artifact = {
                "campaign_id": campaign_id,
                "method": method,
                "effective_dimensions": effective_dimensions,
                "scorecards_artifact_ref": scorecards_ref,
                "ranked_nodes": ranked_nodes,
                "generated_at": utc_now_iso(),
            }

            planned_campaign = copy.deepcopy(campaign)
            planned_campaign["usage"]["steps_used"] += 1
            self._set_campaign_running_if_budget_available(planned_campaign)

            result = {
                "campaign_id": campaign_id,
                "method": method,
                "effective_dimensions": effective_dimensions,
                "scorecards_artifact_ref": scorecards_ref,
                "ranked_nodes": ranked_nodes,
                "budget_snapshot": self._budget_snapshot(planned_campaign),
                "idempotency": self._response_idempotency(idempotency_key, p_hash),
                "ranking_artifact_ref": ranking_artifact_ref,
            }
            self.catalog.validate_result("rank.compute", result)
            self._store_idempotency(
                method="rank.compute",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="prepared",
            )

            self.store.write_artifact(
                campaign_id,
                "rankings",
                ranking_artifact_name,
                ranking_artifact,
            )
            self.store.save_campaign(planned_campaign)

            self._store_idempotency(
                method="rank.compute",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="committed",
            )
            return result

    def node_promote(self, params: dict[str, Any]) -> dict[str, Any]:
        campaign_id = params["campaign_id"]
        node_id = params["node_id"]
        idempotency_key = params["idempotency_key"]
        p_hash = self._hash_without_idempotency("node.promote", params)
        with self.store.mutation_lock(campaign_id):
            replay = self._record_or_replay(
                method="node.promote",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
            )
            if replay is not None:
                kind, payload = replay
                if kind == "error":
                    raise RpcError(**payload)
                return payload

            campaign = self._load_campaign_or_error(campaign_id)
            self._ensure_campaign_running(campaign)
            domain_pack = self._load_campaign_domain_pack(campaign)

            nodes = self.store.load_nodes(campaign_id)
            node = nodes.get(node_id)
            if node is None:
                data = {"reason": "node_not_found", "campaign_id": campaign_id, "node_id": node_id}
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32004, message="node_not_found", data=data)
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            if node.get("campaign_id") != campaign_id:
                data = {"reason": "node_not_in_campaign", "campaign_id": campaign_id, "node_id": node_id}
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32014, message="node_not_in_campaign", data=data)
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            try:
                self._validate_formalization_trace(
                    node=node,
                    campaign_id=campaign_id,
                    node_id=node_id,
                )
            except RpcError as error:
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            if node.get("idea_card") is None:
                data = {
                    "reason": "schema_invalid",
                    "campaign_id": campaign_id,
                    "node_id": node_id,
                    "details": {"message": "idea_card is required for promotion"},
                }
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32002, message="schema_validation_failed", data=data)
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            try:
                self.catalog.validate_against_ref(
                    "./idea_card_v1.schema.json",
                    node["idea_card"],
                    base_name=f"node.promote/idea_card/{node_id}",
                )
            except ContractRuntimeError as exc:
                error = self._schema_error(
                    f"idea_card invalid: {exc}",
                    extra={"campaign_id": campaign_id, "node_id": node_id},
                )
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            blocking_constraint_modes = self._blocking_domain_failure_modes(
                node,
                constraint_policy=domain_pack.constraint_policy,
            )
            if blocking_constraint_modes:
                blocking_error_message = (
                    domain_pack.constraint_policy.blocking_error_message
                    if domain_pack.constraint_policy is not None
                    else "domain_constraints_failed"
                )
                data = {
                    "reason": "schema_invalid",
                    "campaign_id": campaign_id,
                    "node_id": node_id,
                    "details": {
                        "message": blocking_error_message,
                        "blocking_failure_modes": blocking_constraint_modes,
                    },
                }
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32002, message="schema_validation_failed", data=data)
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            grounding = node.get("grounding_audit")
            if not isinstance(grounding, dict) or grounding.get("status") != "pass":
                data = {
                    "reason": "grounding_audit_not_pass",
                    "campaign_id": campaign_id,
                    "node_id": node_id,
                }
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32011, message="grounding_audit_failed", data=data)
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            try:
                formalism_registry = FormalismRegistry.from_payload(
                    campaign.get("formalism_registry"),
                    context="campaign formalism registry",
                )
            except ValueError as exc:
                error = self._schema_error(
                    str(exc),
                    extra={"campaign_id": campaign_id, "node_id": node_id},
                )
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            candidate_formalisms = node.get("idea_card", {}).get("candidate_formalisms", [])
            missing_formalisms = formalism_registry.missing_formalisms(candidate_formalisms)
            if missing_formalisms:
                data = {
                    "reason": "schema_invalid",
                    "campaign_id": campaign_id,
                    "node_id": node_id,
                    "details": {"missing_formalisms": missing_formalisms},
                }
                self.catalog.validate_error_data(data)
                error = RpcError(code=-32012, message="formalism_not_in_registry", data=data)
                self._store_idempotency(
                    method="node.promote",
                    idempotency_key=idempotency_key,
                    payload_hash_value=p_hash,
                    campaign_id=campaign_id,
                    response=error.__dict__,
                    kind="error",
                )
                raise error

            reduction_report = node.get("reduction_report")
            reduction_audit = node.get("reduction_audit")
            has_reduction = reduction_report is not None
            reduction_summary: dict[str, Any] | None
            if has_reduction:
                if reduction_audit is None:
                    data = {
                        "reason": "reduction_audit_missing",
                        "campaign_id": campaign_id,
                        "node_id": node_id,
                    }
                    self.catalog.validate_error_data(data)
                    error = RpcError(code=-32016, message="reduction_audit_failed", data=data)
                    self._store_idempotency(
                        method="node.promote",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=campaign_id,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error

                if reduction_audit.get("status") != "pass":
                    data = {
                        "reason": "reduction_audit_not_pass",
                        "campaign_id": campaign_id,
                        "node_id": node_id,
                    }
                    self.catalog.validate_error_data(data)
                    error = RpcError(code=-32016, message="reduction_audit_failed", data=data)
                    self._store_idempotency(
                        method="node.promote",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=campaign_id,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error

                registry_types = {
                    entry["abstract_problem_type"]
                    for entry in campaign.get("abstract_problem_registry", {}).get("entries", [])
                }
                abstract_problem = reduction_audit.get("abstract_problem")
                if abstract_problem not in registry_types:
                    data = {
                        "reason": "abstract_problem_not_in_registry",
                        "campaign_id": campaign_id,
                        "node_id": node_id,
                    }
                    self.catalog.validate_error_data(data)
                    error = RpcError(code=-32016, message="reduction_audit_failed", data=data)
                    self._store_idempotency(
                        method="node.promote",
                        idempotency_key=idempotency_key,
                        payload_hash_value=p_hash,
                        campaign_id=campaign_id,
                        response=error.__dict__,
                        kind="error",
                    )
                    raise error

                reduction_summary = {
                    "status": "pass",
                    "abstract_problem": reduction_audit["abstract_problem"],
                    "toy_check_result": reduction_audit["toy_check_result"],
                    "assumption_count": len(reduction_audit["assumptions"]),
                    "all_assumptions_satisfied": True,
                }
            else:
                reduction_summary = None

            now = utc_now_iso()
            handoff_payload = {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idea_id": node["idea_id"],
                "promoted_at": now,
                "idea_card": node["idea_card"],
                "grounding_audit": grounding,
                "formalism_check": {
                    "status": "pass",
                    "missing_formalisms": [],
                },
            }
            if has_reduction:
                handoff_payload["reduction_report"] = reduction_report
                handoff_payload["reduction_audit"] = reduction_audit

            handoff_name = f"handoff-{node_id}.json"
            handoff_ref = self.store.artifact_path(
                campaign_id,
                "handoff",
                handoff_name,
            ).resolve().as_uri()

            planned_campaign = copy.deepcopy(campaign)
            planned_campaign["usage"]["steps_used"] += 1
            self._set_campaign_running_if_budget_available(planned_campaign)

            result = {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idea_id": node["idea_id"],
                "handoff_artifact_ref": handoff_ref,
                "formalism_check": {"status": "pass", "missing_formalisms": []},
                "grounding_audit_summary": {
                    "status": "pass",
                    "folklore_risk_score": grounding.get("folklore_risk_score", 0.0),
                    "failures": grounding.get("failures", []),
                },
                "budget_snapshot": self._budget_snapshot(planned_campaign),
                "idempotency": self._response_idempotency(idempotency_key, p_hash),
                "has_reduction_report": has_reduction,
                "reduction_audit_summary": reduction_summary,
            }
            self.catalog.validate_result("node.promote", result)

            promoted_node = copy.deepcopy(node)
            promoted_node["revision"] = int(promoted_node["revision"]) + 1
            promoted_node["updated_at"] = now
            self.catalog.validate_against_ref(
                "./idea_node_v1.schema.json",
                promoted_node,
                base_name=f"node.promote/node/{node_id}",
            )
            nodes[node_id] = promoted_node
            self._store_idempotency(
                method="node.promote",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="prepared",
            )

            self.store.write_artifact(
                campaign_id,
                "handoff",
                handoff_name,
                handoff_payload,
            )
            self.store.save_nodes(campaign_id, nodes)
            self.store.append_node_log(campaign_id, promoted_node, mutation="promote")
            self.store.save_campaign(planned_campaign)

            self._store_idempotency(
                method="node.promote",
                idempotency_key=idempotency_key,
                payload_hash_value=p_hash,
                campaign_id=campaign_id,
                response=result,
                kind="result",
                state="committed",
            )
            return result


def default_service(data_dir: Path, contract_dir: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=data_dir, contract_dir=contract_dir)
