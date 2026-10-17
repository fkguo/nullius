"""Count source-grounded independent evidence, separately from diversity.

The assessor is a fresh comparator invocation, not the author of a lane.
Its semantic judgments remain reviewer judgments; these checks bind them to
observed work and fail closed on absent or incomplete assessments.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

_OBSERVATION_AUTHORITY = object()


class _ObservedDerivation(dict):
    """Process-local runtime capability; JSON fields cannot reconstruct this observation."""
    pass


def observe_runtime_derivation(d: dict) -> dict:
    """Called only after the executor actually invokes its trusted runner boundary."""
    observed = _ObservedDerivation(d)
    observed._observation_authority = _OBSERVATION_AUTHORITY
    observed._observed_transport_sha256 = hashlib.sha256(
        json.dumps(d.get("transport"), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return observed


def runtime_observed(d: dict) -> bool:
    if not isinstance(d, _ObservedDerivation) or getattr(d, "_observation_authority", None) is not _OBSERVATION_AUTHORITY:
        return False
    try:
        return d._observed_transport_sha256 == hashlib.sha256(
            json.dumps(d.get("transport"), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    except (TypeError, ValueError):
        return False


def derivation_body(d: dict) -> str:
    """Original assistant context; assessors must identify the actual scientific steps."""
    transport = d.get("transport")
    if runtime_observed(d) and isinstance(transport, dict):
        from run_multi_backend import parse_derivation
        original = transport.get("raw_output")
        parsed = parse_derivation(original) if isinstance(original, str) else None
        if parsed and parsed["additional_assistant_text_present"]:
            return original
    body = d.get("derivation", d.get("derivation_body", ""))
    return body if isinstance(body, str) else ""


AXES = ("input", "execution", "construction", "applicability", "diagnostic")


def assessed_indices(derivations: list[dict], assessments: list[dict]) -> list[int]:
    accepted: set[int] = set()
    seen: set[int] = set()
    duplicate: set[int] = set()
    for a in assessments if isinstance(assessments, list) else []:
        if not isinstance(a, dict):
            continue
        i = a.get("index")
        if type(i) is not int or not 0 <= i < len(derivations):
            continue
        if i in seen:
            duplicate.add(i)
        seen.add(i)
        if any(a.get(k) is not True for k in (
            "input_independent", "execution_independent", "construction_independent",
            "method_applicable", "diagnostic",
        )) or a.get("unresolved_defects") != []:
            continue
        evidence = a.get("evidence")
        if not isinstance(evidence, dict):
            continue
        valid = True
        for axis in AXES:
            item = evidence.get(axis)
            if not isinstance(item, dict):
                valid = False
                break
            span, reason = item.get("source_span"), item.get("reason")
            if axis in ("input", "execution"):
                axis_sources = source_material(derivations[i])
            else:
                body = derivations[i]["construction_body"] if axis == "construction" and "construction_body" in derivations[i] else derivation_body(derivations[i])
                axis_sources = (body,) if isinstance(body, str) else ()
            if (not isinstance(span, str) or not span.strip() or not any(span in text for text in axis_sources)
                    or not isinstance(reason, str) or len(reason.strip()) < 20):
                valid = False
                break
        if valid:
            accepted.add(i)
    # Duplicate entries cannot conceal a contradictory assessment.
    accepted -= duplicate
    # Runtime-controlled execution ids identify evidence, never agent names.
    ids = [derivations[i].get("execution_id") for i in accepted]
    return sorted(i for i in accepted if isinstance(derivations[i].get("execution_id"), str)
                  and derivations[i]["execution_id"] and ids.count(derivations[i]["execution_id"]) == 1)


def _string_values(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _string_values(item)]
    if isinstance(value, list):
        return [text for item in value for text in _string_values(item)]
    return []


def source_material(d: dict) -> tuple[str, ...]:
    """Texts an input/execution span may quote verbatim: the complete original context, the navigation
    summary, and the observed transport record both as the comparator packet encodes it (JSON, sorted
    keys) and as its decoded string values. The packet never repeats these as one concatenated field."""
    transport = d.get("transport", {})
    return (derivation_body(d), str(d.get("derivation_summary", "")),
            json.dumps(transport, ensure_ascii=False, sort_keys=True), *_string_values(transport))


def valid_derivation_transport(d: dict) -> bool:
    """An author-provided name or fresh assertion is not a successful invocation receipt."""
    if not runtime_observed(d):
        return False
    t = d.get("transport")
    if not isinstance(d.get("derivation"), str) or not d["derivation"].strip() or not isinstance(t, dict):
        return False
    if type(t.get("exit_code")) is not int or t["exit_code"] != 0 or t.get("execution_id") != d.get("execution_id"):
        return False
    request, raw = t.get("request"), t.get("raw_output")
    if not isinstance(request, dict) or not isinstance(raw, str) or not raw.strip():
        return False
    if not isinstance(request.get("prompt"), str) or not request["prompt"].strip():
        return False
    digest = lambda x: hashlib.sha256(x.encode("utf-8")).hexdigest()
    if t.get("request_sha256") != digest(json.dumps(request, ensure_ascii=False, sort_keys=True)) or t.get("output_sha256") != digest(raw):
        return False
    # Parsed raw output must contain the complete derivation actually shown to the assessor.
    try:
        from run_multi_backend import extract_json, parse_derivation
        result = extract_json(raw, prefer_keys={"canonical_answer"})
        if not isinstance(result, dict) or result.get("derivation") != d["derivation"] or result.get("canonical_answer") != d["canonical_answer"]:
            return False
        if "original_assistant_output" in d:
            parsed = parse_derivation(raw)
            if (d["original_assistant_output"] != raw or not parsed
                    or d.get("additional_assistant_text_present") != parsed["additional_assistant_text_present"]):
                return False
        for ref in t.get("artifact_refs", []):
            path = Path(ref["path"])
            if hashlib.sha256(path.read_bytes()).hexdigest() != ref["sha256"]:
                return False
    except (KeyError, TypeError, OSError, UnicodeError):
        return False
    return True


def method_risk_passes(derivations: list[dict], eligible: list[int], records) -> bool:
    """An explicit shared-failure risk needs actual two-source examiner evidence, not distinct labels."""
    if not isinstance(records, list):
        return False
    for r in records:
        if not isinstance(r, dict) or r.get("addresses_shared_failure") is not True or r.get("methods_distinct") is not True:
            continue
        indices = r.get("indices")
        if not isinstance(indices, list) or len(indices) != 2 or any(type(i) is not int or i not in eligible for i in indices) or indices[0] == indices[1]:
            continue
        if any(not isinstance(r.get(k), str) or len(r[k].strip()) < 20 for k in ("risk", "method_analysis")):
            continue
        evidence = r.get("evidence")
        if not isinstance(evidence, list) or len(evidence) != 2:
            continue
        ok = set()
        for item in evidence:
            if not isinstance(item, dict) or type(item.get("index")) is not int or item["index"] not in indices:
                continue
            span, reason = item.get("source_span"), item.get("reason")
            if isinstance(span, str) and span.strip() and span in derivation_body(derivations[item["index"]]) and isinstance(reason, str) and len(reason.strip()) >= 20:
                ok.add(item["index"])
        if ok == set(indices):
            return True
    return False


def independence_record(derivations: list[dict], families: list[str], eligible: list[int], assessments=None) -> dict:
    return {
        "accepted_evidence_indices": eligible,
        "method_diversity": sorted({str(a["observed_method"]) for a in (assessments or []) if isinstance(a, dict) and isinstance(a.get("observed_method"), str) and a["observed_method"].strip()}),
        "method_hints": [d.get("method", "unspecified") for d in derivations],
        "model_family_diversity": sorted(set(families)),
        "execution_independence": "assessed" if eligible else "unavailable",
        "input_independence": "assessed" if eligible else "unavailable",
        "limitations": ["Method and model diversity do not establish independent construction or scientific truth."],
    }
