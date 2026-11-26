#!/usr/bin/env python3
"""Run one fresh source-grounded assessor with the existing review launcher."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SKILLS / "research-team/scripts/gates"))
sys.path.insert(0, str(SKILLS / "derivation-verify/scripts"))
from check_independent_reproduction import MEMBERS, _collect_member_sources, _safe_tag, assessment_packet
from run_multi_backend import MultiTaskRunner, extract_json, _DEFAULT_RUNNER
from request_capacity import request_budgets, validate_request_bytes, validate_request_capacity


ASSESSOR_SYSTEM = (
        "You are a fresh independent source reviewer, separate from both reproduction authors. "
        "Read the exact evidence, source, input visibility and execution records. Evaluate whether each "
        "member actually constructed/derived and executed a check from the neutral problem and raw inputs. "
        "Same/similar method names, model families, hashes and legitimate libraries do not disqualify. "
        "Copied implementations/answers, original-code reruns, contaminated input framing, known relevant "
        "defects and non-diagnostic checks do. Check method preconditions and diagnostic power substantively; "
        "author assertions and no-defect checkboxes are insufficient. Missing evidence means unavailable. "
        "Return ONLY JSON with methods (array of method descriptions), families (array, unknown if absent), "
        "independence_assessments (one record for index 0 and 1). Each record: index, input_independent, "
        "execution_independent, construction_independent, method_applicable, diagnostic (booleans), "
        "unresolved_defects (array), evidence (object with input, execution, construction, applicability, "
        "diagnostic entries). Construction must quote exact source_span from that lane's construction_body, "
        "which contains only producer-origin member source. Shared dependencies are marked in source_roles "
        "and cannot stand in for member construction. Applicability/diagnostic must quote exact source_span from the complete "
        "scientific/code derivation body in that lane's derivation. Input/execution must quote full original "
        "transport or body; derivation_summary includes complete material, never selected quotations. "
        "and explain a substantive source-grounded reason. Examine every shared_source_locators entry and return "
        "shared_source_assessments: [{locator: exact locator string, independence_preserved: boolean, reason: substantive analysis, "
        "evidence:[{index:0,source_span:exact construction_body excerpt,reason:substantive analysis}, "
        "{index:1,source_span:exact construction_body excerpt,reason:substantive analysis}]}]. Distinguish a legitimate "
        "library from reuse of the claimant computation; unaddressed shared code prevents confirmation. "
        "Also read the exact project requirements. "
        "If requires_method_diversity is true, assess the declared shared-failure risk and return "
        "method_risk_assessments: array of {indices:[i,j], addresses_shared_failure:boolean, "
        "methods_distinct:boolean (actual mechanisms, never labels), risk:string, method_analysis:string, "
        "evidence:[{index:i,source_span:string,reason:string},{index:j,source_span:string,reason:string}]}. Both spans must be exact "
        "scientific-body excerpts. A required distinct mechanism must test or avoid the declared shared failure; "
        "renamed hints, matching results or copied implementations cannot satisfy it. "
        "False/unavailable is preferable to invented evidence."
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True)
    p.add_argument("--project-root", type=Path, required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--member-a", type=Path, required=True)
    p.add_argument("--member-b", type=Path, required=True)
    p.add_argument("--model", default="claude/opus")
    p.add_argument("--runner", type=Path, default=_DEFAULT_RUNNER, help="Explicit launcher path, including deterministic offline witnesses.")
    p.add_argument("--timeout-secs", type=int, default=0, help="Hard deadline in seconds (0: no hard deadline).")
    p.add_argument("--live-capture", action="store_true", help="Preserve actual Claude events, terminal result and usage receipt.")
    p.add_argument("--context-bytes", type=int, default=None)
    p.add_argument("--context-tokens", type=int, default=200000)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    if a.timeout_secs < 0:
        p.error("--timeout-secs must be nonnegative")
    from team_config import load_strict_team_config
    try:
        cfg = load_strict_team_config(a.notes)
    except (ValueError, OSError, UnicodeError) as error:
        print(f"UNAVAILABLE: review configuration invalid: {error}", file=sys.stderr)
        return 1
    if not cfg.feature_enabled("independent_reproduction_gate", default=False):
        return 0
    # Never let a failed rerun leave an old assessment available for this invocation.
    a.out.unlink(missing_ok=True)
    root, tag = a.project_root.resolve(), _safe_tag(a.tag)
    sources = {m: _collect_member_sources(m, root / f"artifacts/runs/{tag}/research_team/{m}/independent") for m in MEMBERS}
    if any(not m.files or m.skipped for m in sources.values()):
        print("UNAVAILABLE: source scan/closure is incomplete; no assessment is accepted", file=sys.stderr)
        return 1
    try:
        packet = assessment_packet(sources, {"member_a": a.member_a, "member_b": a.member_b}, root, cfg)
    except (OSError, ValueError, UnicodeError) as e:
        print(f"UNAVAILABLE: cannot read complete assessment inputs: {e}", file=sys.stderr)
        return 1

    prompt = json.dumps(packet, ensure_ascii=False)
    try:
        budgets = request_budgets(a.context_tokens, a.context_bytes)
        validate_request_bytes(ASSESSOR_SYSTEM, prompt, budgets)
    except ValueError as e:
        print(f"UNAVAILABLE: {e}", file=sys.stderr)
        return 1
    runner = MultiTaskRunner(runner_path=a.runner, work_dir=a.out.parent / "independence_assessor",
                             timeout=a.timeout_secs, tools=False, config=None,
                             live_capture=a.live_capture or a.model.startswith("claude/"),
                             context_tokens=budgets["context_tokens"], context_bytes=budgets["context_bytes"])
    result = extract_json(runner.run(a.model, ASSESSOR_SYSTEM, prompt, "source-assessment"))
    if not result:
        return 1
    # Bind the parsed assessment to the exact actual launcher request/output.
    invocation = runner.invocations.get("source-assessment", {})
    if type(invocation.get("exit_code")) is not int or invocation["exit_code"] != 0:
        return 1
    try:
        capacity = validate_request_capacity(ASSESSOR_SYSTEM, prompt, invocation, budgets, expected_working_directory=root)
    except (ValueError, OSError, KeyError) as e:
        print(f"UNAVAILABLE: {e}", file=sys.stderr)
        return 1
    transport = {"request_capacity": capacity, "exit_code": 0, "model": a.model, "input_sha256": packet["input_sha256"],
                 "assessor_entrypoint_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    for key in ("system", "prompt", "output"):
        path = Path(invocation[key]).resolve()
        transport[key] = {"path": path.relative_to(root).as_posix(),
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    observation_path = Path(str(invocation["output"]) + ".runtime-observation.json")
    if not observation_path.is_file():
        print("UNAVAILABLE: runtime observation disappeared before transport freeze", file=sys.stderr)
        return 1
    supporting = [observation_path]
    meta_path = Path(invocation["output"]).parent / "meta.json"
    if meta_path.is_file():
        supporting.append(meta_path)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        for agent in meta.get("agents", []):
            receipt = agent.get("capture_receipt")
            if receipt:
                capture_root = Path(receipt).parent
                supporting.extend(p for p in capture_root.iterdir() if p.is_file())
    transport["capacity_artifacts"] = [{"path": p.resolve().relative_to(root).as_posix(),
        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(set(supporting))]
    transport_path = a.out.parent / "independence_transport.json"
    transport_path.write_text(json.dumps(transport, indent=2) + "\n", encoding="utf-8")
    result.update(input_sha256=packet["input_sha256"], assessor_role="independent_source_review",
                  transport_ref={"path": transport_path.resolve().relative_to(root).as_posix(),
                                 "sha256": hashlib.sha256(transport_path.read_bytes()).hexdigest()})
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
