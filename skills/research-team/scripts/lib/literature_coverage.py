"""Domain-neutral bounded-discovery accounting for literature coverage gates."""

from __future__ import annotations

QUERY_PROVIDER_STATUSES = {"queried", "not_applicable", "unavailable"}
CONTINUATION_STATUSES = {"continued", "exhausted", "bounded_stop"}


def _text(value: object) -> str:
    return str(value or "").strip()


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def validate_bounded_provider_accounting(
    value: object,
    errors: list[str],
    *,
    label: str = "providers",
    require_queried: bool = True,
) -> bool:
    """Validate finite query/page-or-cursor accounting; return whether it is complete."""
    if not isinstance(value, dict) or not value:
        errors.append(f"{label} must include bounded query/page or cursor accounting")
        return False
    complete = True
    queried = 0
    for provider_name, raw_provider in value.items():
        provider_label = f"{label}.{provider_name}"
        if not isinstance(raw_provider, dict):
            errors.append(f"{provider_label} must be an object")
            complete = False
            continue
        status = _text(raw_provider.get("status"))
        if status not in QUERY_PROVIDER_STATUSES:
            errors.append(f"{provider_label}.status must be one of {sorted(QUERY_PROVIDER_STATUSES)}")
            complete = False
            continue
        if status != "queried":
            if not _text(raw_provider.get("reason")):
                errors.append(f"{provider_label}.reason is required when provider is {status!r}")
                complete = False
            continue
        queried += 1
        queries = raw_provider.get("queries", raw_provider.get("query_variants"))
        if not isinstance(queries, list) or not queries or not all(_text(item) for item in queries):
            errors.append(f"{provider_label}.queries must record at least one query variant")
            queries = []
            complete = False
        elif len({_text(item) for item in queries}) != len(queries):
            errors.append(f"{provider_label}.queries must not contain duplicates")
            complete = False
        returned_count = _integer(raw_provider.get("returned_count"))
        if returned_count is None or returned_count < 0:
            errors.append(f"{provider_label}.returned_count must be a non-negative integer")
            complete = False
        total_count = _integer(raw_provider.get("total_count"))
        total_unknown = raw_provider.get("total_count_unknown") is True
        if total_count is None and not total_unknown:
            errors.append(f"{provider_label} must record total_count or total_count_unknown=true")
            complete = False
        elif total_count is not None and (total_count < 0 or (returned_count is not None and returned_count > total_count)):
            errors.append(f"{provider_label}.total_count must be non-negative and not smaller than returned_count")
            complete = False
        elif require_queried and total_count is not None and returned_count != total_count:
            errors.append(f"{provider_label}: known total_count must be fully returned before saturation")
            complete = False
        if not _text(raw_provider.get("stop_reason")):
            errors.append(f"{provider_label}.stop_reason is required")
            complete = False

        bounds = raw_provider.get("execution_bounds")
        if not isinstance(bounds, dict):
            errors.append(f"{provider_label}.execution_bounds must be an object")
            bounds = {}
            complete = False
        max_requests = _integer(bounds.get("max_requests"))
        max_records = _integer(bounds.get("max_records"))
        if max_requests is None or max_requests <= 0:
            errors.append(f"{provider_label}.execution_bounds.max_requests must be a positive integer")
            complete = False
        if max_records is None or max_records <= 0:
            errors.append(f"{provider_label}.execution_bounds.max_records must be a positive integer")
            complete = False
        request_log = raw_provider.get("request_log")
        if not isinstance(request_log, list) or not request_log:
            errors.append(f"{provider_label}.request_log must record each bounded page or cursor request")
            request_log = []
            complete = False
        seen_requests: set[tuple[str, str]] = set()
        continuations_by_query: dict[str, list[str]] = {}
        accounted_records = 0
        for index, raw_request in enumerate(request_log):
            request_label = f"{provider_label}.request_log[{index}]"
            if not isinstance(raw_request, dict):
                errors.append(f"{request_label} must be an object")
                complete = False
                continue
            query = _text(raw_request.get("query"))
            page_or_cursor = _text(raw_request.get("page_or_cursor"))
            count = _integer(raw_request.get("returned_count"))
            continuation = _text(raw_request.get("continuation"))
            if query not in {_text(item) for item in queries}:
                errors.append(f"{request_label}.query must equal a recorded provider query variant")
                complete = False
            if not page_or_cursor:
                errors.append(f"{request_label}.page_or_cursor is required")
                complete = False
            if count is None or count < 0:
                errors.append(f"{request_label}.returned_count must be a non-negative integer")
                complete = False
            else:
                accounted_records += count
            if continuation not in CONTINUATION_STATUSES:
                errors.append(f"{request_label}.continuation must be one of {sorted(CONTINUATION_STATUSES)}")
                complete = False
            continuations_by_query.setdefault(query, []).append(continuation)
            request_key = (query, page_or_cursor)
            if request_key in seen_requests:
                errors.append(f"{request_label} duplicates a query/page-or-cursor request")
                complete = False
            seen_requests.add(request_key)
        if max_requests is not None and len(request_log) > max_requests:
            errors.append(f"{provider_label}.request_log exceeds execution_bounds.max_requests")
            complete = False
        if max_records is not None and accounted_records > max_records:
            errors.append(f"{provider_label}.request_log exceeds execution_bounds.max_records")
            complete = False
        if returned_count is not None and accounted_records != returned_count:
            errors.append(f"{provider_label}.request_log returned counts must sum to returned_count")
            complete = False
        if require_queried:
            declared_queries = {_text(item) for item in queries}
            logged_queries = set(continuations_by_query)
            if declared_queries != logged_queries:
                errors.append(f"{provider_label}: every declared query must have request_log coverage")
                complete = False
            for query, continuations in continuations_by_query.items():
                if continuations[-1:] != ["exhausted"]:
                    errors.append(
                        f"{provider_label}: saturated query {query!r} must end with continuation='exhausted'"
                    )
                    complete = False
                if "exhausted" in continuations[:-1]:
                    errors.append(f"{provider_label}: query {query!r} has requests after exhaustion")
                    complete = False
    if require_queried and queried == 0:
        errors.append(f"{label} must include at least one queried provider for saturation")
        complete = False
    return complete
