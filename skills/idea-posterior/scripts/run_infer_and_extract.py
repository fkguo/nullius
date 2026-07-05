#!/usr/bin/env python3
"""Run exact inference on a Gaia package and extract the worth posterior.

Pipeline: ``gaia build compile`` -> ``gaia build check`` -> ``gaia run infer``,
then parse the produced artifacts:

- ``.gaia/beliefs.json``: the entry whose ``label`` equals the worth label
  (default ``worth``) supplies the posterior value.
- ``.gaia/ir.json``: the number of observation supports — entries in
  ``knowledges[*].metadata.supported_by[*]`` with ``pattern == "observation"``
  — supplies ``evidence_count`` (one count per observe() statement).
  ``ir_hash`` is embedded into ``gaia_package_ref`` so the reference pins the
  exact compiled graph.

Output (stdout, JSON): {"value": float, "evidence_count": int,
"gaia_package_ref": "<abs package path>#<ir_hash>"}. Diagnostics go to
stderr. Standard library only; Gaia is invoked as a subprocess.
"""

from __future__ import annotations

import argparse
import ast
import json
import shutil
import subprocess
import sys
from pathlib import Path

GAIA_PIN = "0.5.0a4"

# The three likelihood grades (Jeffreys scale) and their reversals. Literal
# float comparison is exact: 0.90 parses to the same float as 0.9.
GRADE_PAIRS = {
    (0.75, 0.25), (0.9, 0.09), (0.9, 0.03),
    (0.25, 0.75), (0.09, 0.9), (0.03, 0.9),
}
PIN_INSTALL_HINT = (
    "Install the pinned Gaia toolchain (the pin is deliberate; upgrading is an "
    "explicit, reviewed action):\n"
    "  uv venv .gaia-venv --python 3.12\n"
    f"  uv pip install --python .gaia-venv/bin/python gaia-lang=={GAIA_PIN}\n"
    "then pass --gaia-bin .gaia-venv/bin/gaia or export GAIA_BIN."
)


def resolve_gaia_bin(cli_value: str | None) -> str:
    """Resolve the gaia executable: --gaia-bin, then $GAIA_BIN, then PATH."""
    import os

    candidate = cli_value or os.environ.get("GAIA_BIN") or shutil.which("gaia")
    if not candidate:
        sys.stderr.write(
            "error: no `gaia` executable found (checked --gaia-bin, $GAIA_BIN, "
            "PATH).\n" + PIN_INSTALL_HINT + "\n"
        )
        raise SystemExit(2)
    return candidate


def check_gaia_version(gaia_bin: str) -> None:
    """Fail unless `gaia --version` reports the pinned version."""
    try:
        out = subprocess.run(
            [gaia_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        sys.stderr.write(
            f"error: could not run `{gaia_bin} --version`: {exc}\n"
            + PIN_INSTALL_HINT
            + "\n"
        )
        raise SystemExit(2) from exc
    first_line = (out.stdout or out.stderr).strip().splitlines()
    banner = first_line[0] if first_line else ""
    # Exact token match: a banner like "gaia-lang 0.5.0a41" must NOT pass
    # a pin of 0.5.0a4, so substring matching is not acceptable.
    if GAIA_PIN not in banner.replace(",", " ").split():
        sys.stderr.write(
            f"error: gaia version mismatch: expected exactly {GAIA_PIN}, got "
            f"{banner!r}. The pin is explicit; do not silently upgrade or "
            "downgrade.\n" + PIN_INSTALL_HINT + "\n"
        )
        raise SystemExit(2)


def scan_discipline(source: str) -> list[str]:
    """Best-effort static scan for the grade and anchor discipline.

    Warnings only: review remains the authority. Flags infer() probability
    pairs outside the three grades, and observe/infer rationales (or
    register_prior justifications) that are missing or lack a trailing
    "anchor:" note. Non-literal arguments cannot be checked statically and
    are surfaced for review instead.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"module does not parse: {exc}"]
    findings: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.id
            if isinstance(func, ast.Name)
            else getattr(func, "attr", None)
        )
        if name not in ("observe", "infer", "register_prior"):
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        if name == "infer":
            h = kwargs.get("p_e_given_h")
            nh = kwargs.get("p_e_given_not_h")
            if isinstance(h, ast.Constant) and isinstance(nh, ast.Constant):
                pair = (h.value, nh.value)
                if pair not in GRADE_PAIRS:
                    findings.append(
                        f"line {node.lineno}: infer uses off-grade pair "
                        f"{pair}; allowed grades are 3 (0.75/0.25), "
                        "10 (0.90/0.09), 30 (0.90/0.03), or their reversals"
                    )
            elif h is not None or nh is not None:
                findings.append(
                    f"line {node.lineno}: infer probabilities are not "
                    "literal numbers; the static scan cannot check the "
                    "grade - flag for review"
                )
        note_name = "justification" if name == "register_prior" else "rationale"
        note = kwargs.get(note_name)
        if note is None:
            findings.append(f"line {node.lineno}: {name} has no {note_name}")
        elif isinstance(note, ast.Constant) and isinstance(note.value, str):
            if "anchor:" not in note.value:
                findings.append(
                    f"line {node.lineno}: {name} {note_name} lacks an "
                    "'anchor:' note"
                )
        else:
            findings.append(
                f"line {node.lineno}: {name} {note_name} is not a literal "
                "string; the static scan cannot check the anchor - flag "
                "for review"
            )
    return findings


def scan_package_discipline(package_dir: Path) -> list[str]:
    """Run the static discipline scan over every module under src/."""
    findings: list[str] = []
    src = package_dir / "src"
    if not src.is_dir():
        return findings
    for module in sorted(src.rglob("*.py")):
        for finding in scan_discipline(module.read_text(encoding="utf-8")):
            findings.append(f"{module.relative_to(package_dir)}: {finding}")
    return findings


def run_stage(gaia_bin: str, stage: list[str], package_dir: Path) -> None:
    """Run one gaia CLI stage; on failure print a readable diagnosis."""
    cmd = [gaia_bin, *stage, str(package_dir)]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600, check=False
        )
    except subprocess.TimeoutExpired as exc:
        sys.stderr.write(
            f"error: `{' '.join(cmd)}` timed out after 600 s. A healthy "
            "package of this kind finishes in seconds; inspect the package "
            "or the Gaia installation before retrying.\n"
        )
        raise SystemExit(2) from exc
    if result.returncode != 0:
        sys.stderr.write(
            f"error: `{' '.join(cmd)}` failed (exit {result.returncode}).\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}\n"
            "Fix the graph before extracting a posterior; a posterior from a "
            "package that fails compile or check is not a result.\n"
        )
        raise SystemExit(2)
    sys.stderr.write(f"ok: {' '.join(stage)}\n")


def extract_worth_belief(beliefs: dict, worth_label: str) -> float:
    """Pick the belief whose label equals worth_label; list labels on miss."""
    entries = beliefs.get("beliefs", [])
    matches = [e for e in entries if e.get("label") == worth_label]
    if len(matches) != 1:
        labels = sorted({e.get("label") for e in entries if e.get("label")})
        raise ValueError(
            f"expected exactly one belief labelled {worth_label!r}, found "
            f"{len(matches)}. Labels present: {labels!r}. The top-level claim "
            f"must be bound to a module variable named {worth_label!r}."
        )
    value = matches[0].get("belief")
    if not isinstance(value, (int, float)) or not 0.0 <= float(value) <= 1.0:
        raise ValueError(f"belief for {worth_label!r} is not in [0, 1]: {value!r}")
    return float(value)


def count_observations(ir: dict) -> int:
    """Count observation supports: one per observe() statement in the graph."""
    count = 0
    for knowledge in ir.get("knowledges", []):
        metadata = knowledge.get("metadata") or {}
        for support in metadata.get("supported_by", []) or []:
            if support.get("pattern") == "observation":
                count += 1
    return count


def extract_posterior(package_dir: Path, worth_label: str) -> dict:
    """Parse .gaia artifacts into the posterior payload."""
    gaia_dir = package_dir / ".gaia"
    beliefs_path = gaia_dir / "beliefs.json"
    ir_path = gaia_dir / "ir.json"
    for path in (beliefs_path, ir_path):
        if not path.is_file():
            raise FileNotFoundError(
                f"missing {path}; run the inference stages first"
            )
    beliefs = json.loads(beliefs_path.read_text(encoding="utf-8"))
    ir = json.loads(ir_path.read_text(encoding="utf-8"))

    value = extract_worth_belief(beliefs, worth_label)
    evidence_count = count_observations(ir)
    ir_hash = ir.get("ir_hash", "")
    if not ir_hash:
        raise ValueError(f"no ir_hash in {ir_path}; cannot pin the graph state")
    return {
        "value": value,
        "evidence_count": evidence_count,
        "gaia_package_ref": f"{package_dir.resolve()}#{ir_hash}",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package", required=True, help="path to the Gaia package directory"
    )
    parser.add_argument(
        "--worth-label",
        default="worth",
        help="module variable name of the top-level claim (default: worth)",
    )
    parser.add_argument(
        "--gaia-bin",
        default=None,
        help="path to the gaia executable (default: $GAIA_BIN, then PATH)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="optional file to write the posterior JSON to (stdout always)",
    )
    args = parser.parse_args(argv)

    package_dir = Path(args.package).resolve()
    if not package_dir.is_dir():
        sys.stderr.write(f"error: package directory not found: {package_dir}\n")
        return 2

    gaia_bin = resolve_gaia_bin(args.gaia_bin)
    check_gaia_version(gaia_bin)

    discipline = scan_package_discipline(package_dir)
    for finding in discipline:
        sys.stderr.write(f"discipline warning: {finding}\n")
    if discipline:
        sys.stderr.write(
            f"{len(discipline)} discipline warning(s): grades or anchor "
            "notes need review before the posterior is trusted.\n"
        )

    run_stage(gaia_bin, ["build", "compile"], package_dir)
    run_stage(gaia_bin, ["build", "check"], package_dir)
    run_stage(gaia_bin, ["run", "infer"], package_dir)

    try:
        posterior = extract_posterior(package_dir, args.worth_label)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2

    payload = json.dumps(posterior, indent=2, sort_keys=True)
    print(payload)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
