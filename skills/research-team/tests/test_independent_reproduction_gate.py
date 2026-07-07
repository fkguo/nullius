#!/usr/bin/env python3
"""Behavior tests for the independent-reproduction gate (artifact presence +
shared-kernel inheritance scan + convergence_gate_result_v1 emission)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = ROOT / "scripts" / "gates" / "check_independent_reproduction.py"

sys.path.insert(0, str(ROOT / "scripts" / "gates"))
from convergence_schema import validate_convergence_result  # noqa: E402

TAG = "20260707T000000Z-m1-repro-r1"


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _make_project(
    tmp_path: Path,
    *,
    kernel_modules: list[str] | None = None,
    gate_enabled: bool = True,
    mode: str = "full_access",
) -> Path:
    proj = tmp_path / "proj"
    cfg: dict = {
        "review_access_mode": mode,
        "features": {"independent_reproduction_gate": gate_enabled},
    }
    if kernel_modules is not None:
        cfg["independent_reproduction"] = {"kernel_modules": kernel_modules}
    _write(proj / "research_team_config.json", json.dumps(cfg))
    _write(proj / "notes.md", "# notes\n")
    return proj


def _member_dir(proj: Path, member: str) -> Path:
    return proj / "artifacts" / "runs" / TAG / "research_team" / member / "independent"


def _seed_member(proj: Path, member: str, sources: dict[str, str] | None = None) -> Path:
    """Create the independent artifact + optional reproduction sources; return evidence path."""
    ind = _member_dir(proj, member)
    result_rel = f"artifacts/runs/{TAG}/research_team/{member}/independent/result.json"
    _write(proj / result_rel, "{}\n")
    for rel, content in (sources or {}).items():
        _write(ind / rel, content)
    ev = {"outputs_produced": [{"path": result_rel}]}
    return _write(proj / f"{member}_evidence.json", json.dumps(ev))


def _run_gate(proj: Path, ev_a: Path, ev_b: Path, extra: list[str] | None = None) -> tuple[subprocess.CompletedProcess[str], dict | None]:
    env = dict(os.environ)
    env.pop("RESEARCH_TEAM_CONFIG", None)
    proc = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--notes", str(proj / "notes.md"),
            "--tag", TAG,
            "--member-a", str(ev_a),
            "--member-b", str(ev_b),
            "--project-root", str(proj),
            *(extra or []),
        ],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    payload = json.loads(proc.stdout.strip()) if proc.stdout.strip() else None
    return proc, payload


def _assert_valid(payload: dict) -> None:
    errors = validate_convergence_result(payload)
    assert errors == [], f"emitted verdict violates convergence_gate_result_v1: {errors}"


# ---------------------------------------------------------------------------
# PASS / artifact-presence behavior
# ---------------------------------------------------------------------------


def test_clean_pass_emits_converged_verdict(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import json\nprint('a')\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\nprint('b')\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None
    _assert_valid(payload)
    assert payload["status"] == "converged"
    assert payload["meta"]["gate_id"] == "independent_reproduction"
    for member in ("member_a", "member_b"):
        assert payload["report_status"][member]["verdict"] == "ready"
        assert payload["report_status"][member]["independence"] == "independent"


def test_missing_artifact_fails_with_label(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a")
    ev_b = _write(proj / "member_b_evidence.json", json.dumps({"outputs_produced": []}))
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    _assert_valid(payload)
    assert payload["status"] == "not_converged"
    assert any("MISSING_INDEPENDENT_ARTIFACT" in r for r in payload["reasons"])
    assert payload["report_status"]["member_b"]["verdict"] == "needs_revision"
    assert payload["report_status"]["member_a"]["verdict"] == "ready"


# ---------------------------------------------------------------------------
# K1: declared kernel-under-test
# ---------------------------------------------------------------------------


def test_declared_kernel_import_python_is_not_independent(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["mykernel"])
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import mykernel\nprint(mykernel.solve())\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import numpy\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    _assert_valid(payload)
    assert any("SHARED_KERNEL_INHERITANCE" in r and "mykernel" in r for r in payload["reasons"])
    assert payload["report_status"]["member_a"]["independence"] == "not_independent"
    assert payload["report_status"]["member_b"]["independence"] == "independent"


def test_declared_kernel_using_julia_via_cli_flag(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a", {"repro_a.jl": "using MyKernel\nprintln(MyKernel.solve())\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.jl": "println(2 + 2)\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b, extra=["--kernel-module", "MyKernel"])
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "MyKernel" in r for r in payload["reasons"])
    assert payload["report_status"]["member_a"]["independence"] == "not_independent"


def test_declared_kernel_include_path_is_flagged(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["AmplitudeKernel"])
    _write(proj / "src" / "AmplitudeKernel.jl", "module AmplitudeKernel end\n")
    ind_a = _member_dir(proj, "member_a")
    rel = os.path.relpath(proj / "src" / "AmplitudeKernel.jl", ind_a)
    ev_a = _seed_member(proj, "member_a", {"repro_a.jl": f'include("{rel}")\n'})
    ev_b = _seed_member(proj, "member_b", {"repro_b.jl": "println(1)\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "AmplitudeKernel" in r for r in payload["reasons"])


def test_declared_kernel_dynamic_import_python_is_flagged(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["mykernel"])
    ev_a = _seed_member(
        proj, "member_a",
        {"repro_a.py": "import importlib\nm = importlib.import_module('mykernel')\n"},
    )
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "mykernel" in r for r in payload["reasons"])


def test_declared_kernel_string_mention_in_python_passes(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["mykernel"])
    ev_a = _seed_member(
        proj, "member_a",
        {"repro_a.py": 'note = "we import mykernel results here only to compare"\nimport numpy\n'},
    )
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


def test_declared_kernel_mathematica_needs_is_flagged(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["AmplKernel"])
    ev_a = _seed_member(proj, "member_a", {"repro_a.wl": 'Needs["AmplKernel`"]\n'})
    ev_b = _seed_member(proj, "member_b", {"repro_b.wl": "x = 1;\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "AmplKernel" in r for r in payload["reasons"])


def test_declared_kernel_comment_only_mention_passes(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["mykernel"])
    ev_a = _seed_member(
        proj, "member_a",
        {"repro_a.py": "# unlike mykernel, recompute from scratch using the direct sum\nimport numpy\n"},
    )
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


def test_declared_kernel_with_no_sources_is_unverifiable(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["mykernel"])
    ev_a = _seed_member(proj, "member_a")  # artifact only, no sources
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("UNVERIFIABLE_INDEPENDENCE" in r for r in payload["reasons"])
    assert payload["report_status"]["member_a"]["verdict"] == "needs_revision"


def test_dotted_declared_kernel_import_is_flagged(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["shared_utils.kernel"])
    _write(proj / "shared_utils" / "__init__.py", "")
    _write(proj / "shared_utils" / "kernel.py", "def solve():\n    return 42\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import shared_utils.kernel\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "shared_utils.kernel" in r for r in payload["reasons"])
    assert payload["report_status"]["member_a"]["independence"] == "not_independent"


def test_dotted_declared_kernel_from_import_is_flagged(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["shared_utils.kernel"])
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "from shared_utils import kernel\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r for r in payload["reasons"])


def test_dotted_declared_kernel_include_under_allowlisted_root_is_flagged(tmp_path: Path):
    # A declared kernel under an allowlisted root must NOT escape through the
    # allowlist when loaded by path (include spelling of the dotted module).
    proj = _make_project(tmp_path, kernel_modules=["shared_utils.kernel"])
    _write(proj / "shared_utils" / "kernel.jl", "module kernel end\n")
    rel_a = os.path.relpath(proj / "shared_utils" / "kernel.jl", _member_dir(proj, "member_a"))
    rel_b = os.path.relpath(proj / "shared_utils" / "kernel.jl", _member_dir(proj, "member_b"))
    ev_a = _seed_member(proj, "member_a", {"repro_a.jl": f'include("{rel_a}")\n'})
    ev_b = _seed_member(proj, "member_b", {"repro_b.jl": f'include("{rel_b}")\n'})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r for r in payload["reasons"])
    assert payload["report_status"]["member_a"]["independence"] == "not_independent"
    assert payload["report_status"]["member_b"]["independence"] == "not_independent"


def test_parent_package_import_of_dotted_kernel_is_flagged(tmp_path: Path):
    # Importing the PACKAGE that contains the declared kernel is a
    # call-through risk (its __init__ may load the kernel): fail-closed.
    proj = _make_project(tmp_path, kernel_modules=["shared_utils.kernel"])
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import shared_utils\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r for r in payload["reasons"])


def test_dotted_kernel_sibling_file_include_passes(tmp_path: Path):
    # Sibling artifacts and enclosing segments must NOT match the declared
    # dotted kernel's path spelling (true path-segment boundaries):
    #   shared_utils/kernel_extra.jl, shared_utils/kernel-extra.jl,
    #   shared_utils/kernel.extra.jl, my-shared_utils/kernel.jl
    proj = _make_project(tmp_path, kernel_modules=["shared_utils.kernel"])
    siblings = [
        proj / "shared_utils" / "kernel_extra.jl",
        proj / "shared_utils" / "kernel-extra.jl",
        proj / "shared_utils" / "kernel.extra.jl",
        proj / "my-shared_utils" / "kernel.jl",
    ]
    for s in siblings:
        _write(s, "const HELPER = 1\n")
    ind_a = _member_dir(proj, "member_a")
    lines = "".join(f'include("{os.path.relpath(s, ind_a)}")\n' for s in siblings)
    ev_a = _seed_member(proj, "member_a", {"repro_a.jl": lines})
    ev_b = _seed_member(proj, "member_b", {"repro_b.jl": "println(1)\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


def test_dotted_kernel_path_spelling_in_c_include_is_flagged(tmp_path: Path):
    # The slash spelling must still MATCH the real kernel path in languages
    # without structured include extraction (e.g. C) — both the quoted and
    # the angle-bracket include forms.
    for i, line in enumerate(('#include "../shared_utils/kernel.h"\n', "#include <shared_utils/kernel.h>\n")):
        proj = _make_project(tmp_path / f"case{i}", kernel_modules=["shared_utils.kernel"])
        ev_a = _seed_member(proj, "member_a", {"repro_a.c": line})
        ev_b = _seed_member(proj, "member_b", {"repro_b.c": "int main(void) { return 0; }\n"})
        proc, payload = _run_gate(proj, ev_a, ev_b)
        assert proc.returncode == 1, f"line not flagged: {line!r}\n{proc.stderr}"
        assert payload is not None
        assert any("SHARED_KERNEL_INHERITANCE" in r for r in payload["reasons"])


def test_oversized_source_with_declared_kernel_is_unverifiable(tmp_path: Path):
    proj = _make_project(tmp_path, kernel_modules=["mykernel"])
    big = "# pad\n" * 400_000  # > 2 MB: the scan must refuse to certify it
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": big + "import mykernel\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("UNVERIFIABLE_INDEPENDENCE" in r for r in payload["reasons"])
    # The only-source-is-oversized member gets ONE unverifiable reason, not a
    # misleading extra "no reproduction sources were found".
    assert sum("UNVERIFIABLE_INDEPENDENCE" in r for r in payload["reasons"]) == 1


def test_oversized_source_without_kernels_passes_with_scan_note(tmp_path: Path):
    proj = _make_project(tmp_path)
    big = "# pad\n" * 400_000
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": big})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import math\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None
    assert payload["status"] == "converged"
    assert any("SCAN_INCOMPLETE" in r for r in payload["reasons"])


# ---------------------------------------------------------------------------
# K2: shared project-local module (no declaration needed)
# ---------------------------------------------------------------------------


def test_shared_project_local_python_module_fails_both(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "src" / "litekernel.py", "def solve():\n    return 42\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import litekernel\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import litekernel\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    _assert_valid(payload)
    assert any("SHARED_KERNEL_INHERITANCE" in r and "litekernel" in r for r in payload["reasons"])
    assert payload["report_status"]["member_a"]["independence"] == "not_independent"
    assert payload["report_status"]["member_b"]["independence"] == "not_independent"


def test_shared_julia_package_via_project_toml_name(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "Project.toml", 'name = "ProjPkg"\nuuid = "00000000-0000-0000-0000-000000000000"\n')
    _write(proj / "src" / "somethingelse.jl", "module somethingelse end\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.jl": "using ProjPkg\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.jl": "import ProjPkg: solve\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "ProjPkg" in r for r in payload["reasons"])


def test_shared_aliased_multi_import_is_flagged(tmp_path: Path):
    # `import numpy as np, litekernel as lk` must record BOTH names.
    proj = _make_project(tmp_path)
    _write(proj / "src" / "litekernel.py", "def solve():\n    return 42\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import numpy as np, litekernel as lk\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import litekernel\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "litekernel" in r for r in payload["reasons"])


def test_shared_namespace_package_dotted_import_is_flagged(tmp_path: Path):
    # src/pkg/kernel.py WITHOUT src/pkg/__init__.py (namespace package): the
    # dotted import must still resolve through its path spelling.
    proj = _make_project(tmp_path)
    _write(proj / "src" / "pkg" / "kernel.py", "def solve():\n    return 42\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import pkg.kernel\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "from pkg import kernel\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "pkg.kernel" in r for r in payload["reasons"])


def test_aliased_multi_import_in_unparseable_python_still_recorded(tmp_path: Path):
    # The regex fallback (syntax-broken file) must not drop names after an
    # alias: `import numpy as np, litekernel as lk` records litekernel too.
    proj = _make_project(tmp_path)
    _write(proj / "src" / "litekernel.py", "def solve():\n    return 42\n")
    broken = "import numpy as np, litekernel as lk\ndef broken(:\n"
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": broken})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import litekernel\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "litekernel" in r for r in payload["reasons"])


def test_shared_third_party_import_passes(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import numpy\nimport json\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import numpy\nimport json\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


def test_deep_basename_collision_does_not_flag_third_party(tmp_path: Path):
    # docs/numpy.py is not importable as `numpy` from the project root: a
    # shared third-party import must not be flagged by a basename collision.
    proj = _make_project(tmp_path)
    _write(proj / "docs" / "numpy.py", "PLACEHOLDER = True\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import numpy\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import numpy\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


def test_same_name_own_dir_helpers_pass(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "helpers.py", "SHOULD_NOT_MATTER = True\n")
    ev_a = _seed_member(
        proj, "member_a",
        {"repro_a.py": "import helpers\n", "helpers.py": "def own_a():\n    return 1\n"},
    )
    ev_b = _seed_member(
        proj, "member_b",
        {"repro_b.py": "import helpers\n", "helpers.py": "def own_b():\n    return 2\n"},
    )
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


def test_allowlisted_shared_root_passes_unless_declared_kernel(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "shared_utils" / "__init__.py", "def plot():\n    pass\n")
    ev_a = _seed_member(proj, "member_a", {"repro_a.py": "import shared_utils\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.py": "import shared_utils\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"

    # Declaring the same root as kernel-under-test overrides the allowlist.
    proc, payload = _run_gate(proj, ev_a, ev_b, extra=["--kernel-module", "shared_utils"])
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r for r in payload["reasons"])


# ---------------------------------------------------------------------------
# K3: shared include-by-path
# ---------------------------------------------------------------------------


def test_shared_include_path_fails_both(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "src" / "common.jl", "const C = 1\n")
    rel_a = os.path.relpath(proj / "src" / "common.jl", _member_dir(proj, "member_a"))
    rel_b = os.path.relpath(proj / "src" / "common.jl", _member_dir(proj, "member_b"))
    ev_a = _seed_member(proj, "member_a", {"repro_a.jl": f'include("{rel_a}")\n'})
    ev_b = _seed_member(proj, "member_b", {"repro_b.jl": f'include("{rel_b}")\n'})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    _assert_valid(payload)
    assert any("SHARED_KERNEL_INHERITANCE" in r and "common.jl" in r for r in payload["reasons"])


def test_shared_r_source_fails_both(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "src" / "kernel_common.R", "solve <- function() 42\n")
    rel_a = os.path.relpath(proj / "src" / "kernel_common.R", _member_dir(proj, "member_a"))
    rel_b = os.path.relpath(proj / "src" / "kernel_common.R", _member_dir(proj, "member_b"))
    ev_a = _seed_member(proj, "member_a", {"repro_a.R": f'source("{rel_a}")\n'})
    ev_b = _seed_member(proj, "member_b", {"repro_b.R": f'source("{rel_b}")\n'})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "kernel_common.R" in r for r in payload["reasons"])


def test_shared_shell_source_fails_both(tmp_path: Path):
    proj = _make_project(tmp_path)
    _write(proj / "tools" / "env.sh", "export KERNEL_MODE=prod\n")
    rel_a = os.path.relpath(proj / "tools" / "env.sh", _member_dir(proj, "member_a"))
    rel_b = os.path.relpath(proj / "tools" / "env.sh", _member_dir(proj, "member_b"))
    ev_a = _seed_member(proj, "member_a", {"repro_a.sh": f"source {rel_a}\n"})
    ev_b = _seed_member(proj, "member_b", {"repro_b.sh": f". {rel_b}\n"})
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 1
    assert payload is not None
    assert any("SHARED_KERNEL_INHERITANCE" in r and "env.sh" in r for r in payload["reasons"])


def test_own_dir_include_passes(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(
        proj, "member_a",
        {"repro_a.jl": 'include("lib_a.jl")\n', "lib_a.jl": "const A = 1\n"},
    )
    ev_b = _seed_member(
        proj, "member_b",
        {"repro_b.jl": 'include("lib_b.jl")\n', "lib_b.jl": "const B = 2\n"},
    )
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and payload["status"] == "converged"


# ---------------------------------------------------------------------------
# Contract plumbing
# ---------------------------------------------------------------------------


def test_out_json_matches_stdout(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a")
    ev_b = _seed_member(proj, "member_b")
    out_json = tmp_path / "verdict.json"
    proc, payload = _run_gate(proj, ev_a, ev_b, extra=["--out-json", str(out_json)])
    assert proc.returncode == 0, proc.stderr
    assert out_json.is_file()
    assert json.loads(out_json.read_text(encoding="utf-8")) == payload


def test_skip_when_disabled_emits_no_json(tmp_path: Path):
    proj = _make_project(tmp_path, gate_enabled=False)
    ev_a = _seed_member(proj, "member_a")
    ev_b = _seed_member(proj, "member_b")
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0
    assert payload is None
    assert "SKIP" in proc.stderr


def test_skip_when_packet_only_mode(tmp_path: Path):
    proj = _make_project(tmp_path, mode="packet_only")
    ev_a = _seed_member(proj, "member_a")
    ev_b = _seed_member(proj, "member_b")
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 0
    assert payload is None


def test_missing_notes_is_parse_error(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a")
    ev_b = _seed_member(proj, "member_b")
    proc = subprocess.run(
        [
            sys.executable, str(GATE),
            "--notes", str(proj / "does_not_exist.md"),
            "--tag", TAG,
            "--member-a", str(ev_a),
            "--member-b", str(ev_b),
            "--project-root", str(proj),
        ],
        capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 2
    payload = json.loads(proc.stdout.strip())
    _assert_valid(payload)
    assert payload["status"] == "parse_error"


def test_bad_evidence_json_is_parse_error(tmp_path: Path):
    proj = _make_project(tmp_path)
    ev_a = _seed_member(proj, "member_a")
    ev_b = _write(proj / "member_b_evidence.json", "{not json")
    proc, payload = _run_gate(proj, ev_a, ev_b)
    assert proc.returncode == 2
    assert payload is not None
    assert payload["status"] == "parse_error"


def _import_gate_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("cir_gate_under_test", GATE)
    gate_mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["cir_gate_under_test"] = gate_mod
    try:
        spec.loader.exec_module(gate_mod)
    finally:
        sys.modules.pop("cir_gate_under_test", None)
    return gate_mod


def test_unexpected_crash_emits_parse_error_verdict(tmp_path: Path, capsys, monkeypatch):
    # An unforeseen crash inside evaluation must still leave a machine
    # verdict (parse_error / exit 2), never a bare traceback.
    gate_mod = _import_gate_module()

    def _boom(args, base_meta, _input_error):
        raise RuntimeError("synthetic crash")

    monkeypatch.setattr(gate_mod, "_run", _boom)
    monkeypatch.setattr(
        sys, "argv",
        ["check_independent_reproduction.py", "--notes", str(tmp_path / "notes.md"),
         "--tag", TAG, "--member-a", str(tmp_path / "a.json"), "--member-b", str(tmp_path / "b.json")],
    )
    rc = gate_mod.main()
    assert rc == 2
    out, err = capsys.readouterr()
    payload = json.loads(out.strip())
    _assert_valid(payload)
    assert payload["status"] == "parse_error"
    assert any("unexpected gate error" in r and "synthetic crash" in r for r in payload["reasons"])
    assert "unexpected gate error" in err


def test_emitter_fallback_rewrites_invalid_payload(capsys):
    gate_mod = _import_gate_module()

    # status/exit_code cross-field mismatch must be rewritten to parse_error/2,
    # never emitted as-is.
    members = {
        m: {"verdict": "ready", "blocking_count": 0, "parse_ok": True}
        for m in ("member_a", "member_b")
    }
    rc = gate_mod._emit_result_or_fallback(
        status="converged",
        exit_code=1,
        reasons=[],
        report_status=members,
        meta=gate_mod.build_gate_meta("independent_reproduction"),
        out_json=None,
    )
    assert rc == 2
    payload = json.loads(capsys.readouterr().out.strip())
    _assert_valid(payload)
    assert payload["status"] == "parse_error"
    assert any("schema validation failed" in r for r in payload["reasons"])
