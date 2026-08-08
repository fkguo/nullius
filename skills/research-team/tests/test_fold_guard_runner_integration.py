#!/usr/bin/env python3
"""Runner-level integration tests for the converged-branch fold guard.

The unit tests prove check_adjudication_completeness.py's verdicts; these
prove the runner actually consumes them: a converged cycle with recorded
Minor Issues keeps its convergence record but withholds the automatic
plan/claim fold and writes the pending marker, while a converged cycle with
zero minors folds exactly as before. Deterministic stub runners only.
"""

from __future__ import annotations

import json
import subprocess
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "scripts" / "bin"
SCAFFOLD = BIN / "scaffold_research_workflow.sh"
DEMO = BIN / "generate_demo_milestone.sh"
RUN_TEAM = BIN / "run_team_cycle.sh"

DEMO_TAG = "20260731T000000Z-m0-fg-demo-r1"

STUB_TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "${out}" ]] || {{ echo "stub: missing --out" >&2; exit 2; }}
mkdir -p "$(dirname "${out}")"
cat >"${out}" <<'MD'
# Member Report

| Check | Result |
|---|---|
| Derivation replication | pass |
| Computation replication | pass |

## Derivation Replication
Comparison: match

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass
__MINOR_SECTION__
## Verdict

Verdict: ready for next milestone
- Blocking issues: none
MD
exit 0
"""

MINOR_SECTION = """
## Minor Issues
- fixture hardening idea beyond declared scope
"""


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    subprocess.run(
        ["bash", str(SCAFFOLD), "--root", str(root), "--project", "FoldGuardIT",
         "--profile", "exploratory", "--full"],
        check=True, capture_output=True, text=True,
    )
    _write(
        root / "project_brief.md",
        "# Deterministic fold-guard brief\n\nGoal:\n- Validate the converged-branch fold guard with stub runners.\n",
    )
    subprocess.run(
        ["bash", str(DEMO), "--root", str(root), "--tag", DEMO_TAG],
        check=True, capture_output=True, text=True,
    )
    today = date.today().isoformat()
    _write(
        root / "project_charter.md",
        f"""# project_charter.md

Status: APPROVED
Project: FoldGuardIT
Root: {root}
Created: {today}
Last updated: {today}

## 0. Purpose

One-sentence project purpose: deterministic validation of the fold guard.

## 1. Goals

Primary goal: deterministic fold-guard validation
Validation goal(s): converged-with-minors withholds the automatic fold

Anti-goals / non-goals:
- Do not validate a domain-specific scientific claim.
- Do not call external LLMs or network services.
""",
    )
    cfg_path = root / "research_team_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg.setdefault("features", {})["independent_reproduction_gate"] = False
    cfg["project_stage"] = "exploration"
    # packet_only keeps the stub single-phase: it writes the final report
    # directly instead of answering the full_access REQUESTS_ONLY handshake.
    cfg["review_access_mode"] = "packet_only"
    cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return root


def _make_stub(tmp_path: Path, name: str, *, minors: bool) -> Path:
    body = STUB_TEMPLATE.replace("{{", "{").replace("}}", "}").replace(
        "__MINOR_SECTION__", MINOR_SECTION if minors else ""
    )
    stub = tmp_path / name
    _write(stub, body)
    stub.chmod(0o755)
    return stub


def _run_full_cycle(root: Path, tag: str, stub: Path) -> subprocess.CompletedProcess:
    argv = [
        "bash", str(RUN_TEAM),
        "--tag", tag,
        "--notes", "research_contract.md",
        "--out-dir", "team",
        "--member-a-system", "prompts/_system_member_a.txt",
        "--member-b-system", "prompts/_system_member_b.txt",
        "--member-a-runner-kind", "codex",
        "--member-b-runner-kind", "codex",
        "--member-a-runner", str(stub),
        "--member-b-runner", str(stub),
        "--no-sidecar",
    ]
    return subprocess.run(argv, cwd=root, capture_output=True, text=True)


def test_converged_with_minors_withholds_fold_and_writes_marker(
    project: Path, tmp_path: Path
) -> None:
    stub = _make_stub(tmp_path, "stub_minors.sh", minors=True)
    tag = "20260731T000000Z-m0-fg-minors-r1"
    proc = _run_full_cycle(project, tag, stub)
    assert proc.returncode == 0, f"cycle should converge; log:\n{proc.stderr[-3000:]}"

    run_dir = project / "team" / "runs" / tag
    gate_verdict = json.loads(
        (run_dir / f"{tag}_dispositions_gate.json").read_text(encoding="utf-8")
    )
    assert gate_verdict["status"] == "fail"
    marker = run_dir / f"{tag}_dispositions_pending.md"
    assert marker.is_file(), "pending marker must name the withheld fold"
    assert "withheld" in marker.read_text(encoding="utf-8")
    assert "fold pending" in proc.stderr
    # The automatic plan fold was withheld: no converged progress entry for
    # this tag in the research plan.
    plan_text = (project / "research_plan.md").read_text(encoding="utf-8")
    assert tag not in plan_text


def test_converged_without_minors_folds_as_before(project: Path, tmp_path: Path) -> None:
    stub = _make_stub(tmp_path, "stub_clean.sh", minors=False)
    tag = "20260731T000000Z-m0-fg-clean-r1"
    proc = _run_full_cycle(project, tag, stub)
    assert proc.returncode == 0, f"cycle should converge; log:\n{proc.stderr[-3000:]}"

    run_dir = project / "team" / "runs" / tag
    gate_verdict = json.loads(
        (run_dir / f"{tag}_dispositions_gate.json").read_text(encoding="utf-8")
    )
    assert gate_verdict["status"] == "pass"
    # No launcher in this fixture: the registration gate SKIPs, so the fold
    # proceeds exactly as before on non-nullius projects.
    registration_verdict = json.loads(
        (run_dir / f"{tag}_registration_gate.json").read_text(encoding="utf-8")
    )
    assert registration_verdict["status"] == "skip"
    assert not (run_dir / f"{tag}_dispositions_pending.md").exists()
    assert "fold pending" not in proc.stderr


def test_launcher_project_zero_minors_withholds_fold_until_registration(
    project: Path, tmp_path: Path
) -> None:
    # On a project WITH a nullius launcher, the registration gate is live:
    # a zero-minors converged cycle whose adjudication (and its Result
    # registration declaration) does not exist yet withholds the automatic
    # fold — writing the declaration is part of the convergence deliverable.
    launcher = project / ".nullius" / "bin" / "nullius"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text(
        "#!/usr/bin/env bash\n"
        'for a in "$@"; do\n'
        '  if [[ "$a" == "current" ]]; then echo "{}"; exit 0; fi\n'
        "done\n"
        "exit 0\n",
        encoding="utf-8",
    )
    launcher.chmod(0o755)

    stub = _make_stub(tmp_path, "stub_clean_launcher.sh", minors=False)
    tag = "20260731T000000Z-m0-fg-launcher-r1"
    proc = _run_full_cycle(project, tag, stub)
    assert proc.returncode == 0, f"cycle should converge; log:\n{proc.stderr[-3000:]}"

    run_dir = project / "team" / "runs" / tag
    registration_verdict = json.loads(
        (run_dir / f"{tag}_registration_gate.json").read_text(encoding="utf-8")
    )
    assert registration_verdict["status"] == "fail"
    marker = run_dir / f"{tag}_dispositions_pending.md"
    assert marker.is_file(), "registration gate refusal must withhold the fold"
    marker_text = marker.read_text(encoding="utf-8")
    assert "result registration gate: PENDING" in marker_text
    assert "check_convergence_registration.py" in marker_text
    assert "fold pending" in proc.stderr
    plan_text = (project / "research_plan.md").read_text(encoding="utf-8")
    assert tag not in plan_text
