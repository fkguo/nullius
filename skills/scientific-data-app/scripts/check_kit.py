#!/usr/bin/env python3
"""Fail-closed structural check for a scientific-data-app design kit.

It verifies that the normative documents exist, carry the required sections, contain no
unresolved placeholders, and meet a few content signals. It is deliberately structural:
passing it is necessary, not sufficient.

Exit codes: 0 = pass, 1 = fail, 2 = usage/input error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PLACEHOLDER = re.compile(r"\{\{|TODO:|TBD|FIXME|<<<|FILLME")
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
CJK = r"\u4e00-\u9fff"

# file -> required sections, each a list of accepted aliases (English / Chinese)
FILES = {
    "AGENTS.md": {
        "gate": None,
        "sections": [
            ["read order", "阅读顺序"],
            ["authority", "权威"],
            ["rules", "规则"],
        ],
    },
    "docs/00-data-atlas.md": {
        "gate": "G0",
        "sections": [
            ["scope", "范围"],
            ["tables", "表结构", "全表"],
            ["identity", "身份"],
            ["cannot provide", "不能提供", "无法提供"],
            ["verification", "核验", "验证"],
        ],
        "body": [["cannot provide", "不能提供", "无法提供"]],
    },
    "docs/01-product-ux.md": {
        "gate": "G1",
        "sections": [
            ["primary flows", "主流程", "核心流程"],
            ["navigation", "导航"],
            ["states", "状态"],
            ["non-goals", "非目标"],
        ],
    },
    "docs/02-interface-contract.md": {
        "gate": "G2",
        "sections": [
            ["interfaces", "接口"],
            ["error", "错误"],
            ["provenance", "溯源", "来源"],
            ["invariants", "不变量", "约束"],
        ],
    },
    "docs/03-frozen-rules.md": {
        "gate": "G3",
        "sections": [
            ["layers", "分层"],
            ["rules", "规则"],
            ["partition", "分区"],
            ["fixture", "夹具"],
            ["change control", "变更控制"],
        ],
        "signals": ["number", "fixture"],
    },
    "docs/04-acceptance-matrix.md": {
        "gate": "G4",
        "sections": [
            ["real-data examples", "真实数据", "真实例"],
            ["failure states", "失败状态"],
            ["exhaustive", "穷举", "全库"],
            ["synthetic", "合成"],
        ],
        "min_table_rows": 3,
    },
    "docs/05-review-record.md": {
        "gate": None,
        "optional": True,
        "sections": [
            ["scope", "范围"],
            ["findings", "发现"],
            ["dispositions", "处置"],
            ["unverified", "未验证"],
            ["convergence", "收敛"],
        ],
    },
    "docs/07-release.md": {
        "gate": "G5",
        "sections": [
            ["toolchain", "工具链"],
            ["data licensing", "数据许可"],
            ["signing", "签名"],
            ["checklist", "清单"],
        ],
    },
}


def norm(text: str) -> str:
    return re.sub(r"[^0-9a-z" + CJK + r"]+", " ", text.lower()).strip()


def headings(text: str) -> list[tuple[int, str, str]]:
    """Return (line_no, normalized_heading, raw_line)."""
    out = []
    for index, line in enumerate(text.splitlines(), start=1):
        match = HEADING.match(line.strip())
        if match:
            out.append((index, norm(match.group(2)), line.strip()))
    return out


def find_section(text: str, aliases: list[str]) -> tuple[bool, str]:
    """Return (found, body_text_of_first_matching_section)."""
    lines = text.splitlines()
    heads = headings(text)
    wanted = [norm(alias) for alias in aliases]
    for position, (line_no, heading, _raw) in enumerate(heads):
        if any(alias and alias in heading for alias in wanted):
            start = line_no
            end = heads[position + 1][0] - 1 if position + 1 < len(heads) else len(lines)
            body = "\n".join(lines[start:end])
            return True, body
        # keep the loop simple: first match wins
    return False, ""


def check_file(root: Path, rel: str, spec: dict) -> list[dict]:
    checks: list[dict] = []
    path = root / rel
    if not path.exists():
        checks.append({"file": rel, "check": "exists", "ok": False, "detail": "missing"})
        return checks
    checks.append({"file": rel, "check": "exists", "ok": True, "detail": str(path)})

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        checks.append(
            {"file": rel, "check": "utf-8", "ok": False, "detail": str(exc)}
        )
        return checks

    body_chars = len(re.sub(r"\s+", "", text))
    checks.append(
        {
            "file": rel,
            "check": "min_length",
            "ok": body_chars >= 400,
            "detail": f"{body_chars} non-space characters (need >= 400)",
        }
    )

    found = [m for m in PLACEHOLDER.finditer(text)]
    if found:
        where = []
        for match in found[:5]:
            line_no = text[: match.start()].count("\n") + 1
            where.append(f"line {line_no}")
        checks.append(
            {
                "file": rel,
                "check": "no_placeholders",
                "ok": False,
                "detail": f"{len(found)} placeholder(s): {', '.join(where)}",
            }
        )
    else:
        checks.append(
            {"file": rel, "check": "no_placeholders", "ok": True, "detail": "clean"}
        )

    heads = headings(text)
    for aliases in spec.get("sections", []):
        hit = any(
            any(norm(alias) in heading for alias in aliases) for _n, heading, _r in heads
        )
        checks.append(
            {
                "file": rel,
                "check": "section:" + aliases[0],
                "ok": hit,
                "detail": "found" if hit else "heading missing",
            }
        )

    for aliases in spec.get("body", []):
        found_section, body = find_section(text, aliases)
        meaningful = [
            line
            for line in body.splitlines()
            if line.strip() and not line.strip().startswith("#") and len(line.strip()) >= 20
        ]
        ok = found_section and bool(meaningful)
        checks.append(
            {
                "file": rel,
                "check": "body:" + aliases[0],
                "ok": ok,
                "detail": f"{len(meaningful)} substantive line(s)"
                if found_section
                else "section missing",
            }
        )

    for signal in spec.get("signals", []):
        if signal == "number":
            ok = bool(re.search(r"\b\d{2,}\b", text))
            checks.append(
                {
                    "file": rel,
                    "check": "signal:partition_total",
                    "ok": ok,
                    "detail": "a total count (>= 2 digits) is present"
                    if ok
                    else "no total count found (partition must sum to the dataset)",
                }
            )
        elif signal == "fixture":
            ok = bool(re.search(r"(\.jsonl?|\.sqlite|tool/|test/fixtures)", text))
            checks.append(
                {
                    "file": rel,
                    "check": "signal:fixture_path",
                    "ok": ok,
                    "detail": "fixture path present"
                    if ok
                    else "no fixture path found",
                }
            )

    min_rows = spec.get("min_table_rows")
    if min_rows:
        rows = [line for line in text.splitlines() if line.strip().startswith("|")]
        checks.append(
            {
                "file": rel,
                "check": "signal:table_rows",
                "ok": len(rows) >= min_rows,
                "detail": f"{len(rows)} table row(s) (need >= {min_rows})",
            }
        )

    return checks


def required_files(gate: str) -> list[tuple[str, dict]]:
    selected: list[tuple[str, dict]] = []
    for rel, spec in FILES.items():
        spec_gate = spec.get("gate")
        if spec.get("optional"):
            continue
        if spec_gate is None:
            selected.append((rel, spec))
        elif gate == "all" or gate == spec_gate:
            selected.append((rel, spec))
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit-root", required=True, type=Path)
    parser.add_argument(
        "--gate",
        default="all",
        choices=["G0", "G1", "G2", "G3", "G4", "G5", "all"],
    )
    parser.add_argument("--json", action="store_true", help="print only the JSON verdict")
    args = parser.parse_args()

    root = args.kit_root.resolve()
    if not root.is_dir():
        print(f"check_kit: not a directory: {root}", file=sys.stderr)
        return 2

    checks: list[dict] = []
    for rel, spec in required_files(args.gate):
        checks.extend(check_file(root, rel, spec))

    failed = [check for check in checks if not check["ok"]]
    payload = {
        "schema": "scientific_data_app_kit_check_v1",
        "gate": args.gate,
        "kit_root": str(root),
        "passed": not failed,
        "checks": checks,
        "failed": len(failed),
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2))
    else:
        current = None
        for check in checks:
            if check["file"] != current:
                current = check["file"]
                print(f"\n{current}")
            mark = "ok  " if check["ok"] else "FAIL"
            print(f"  [{mark}] {check['check']}: {check['detail']}")
        print(
            f"\nverdict: {'PASS' if not failed else 'FAIL'} "
            f"({len(checks) - len(failed)}/{len(checks)} checks, gate {args.gate})"
        )

    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
