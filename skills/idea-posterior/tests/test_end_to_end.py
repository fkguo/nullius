"""End-to-end test against a real pinned Gaia installation.

Skips (with the install recipe) when gaia 0.5.0a4 is not available; on the
development machine it must run for real.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

import gaia_package_scaffold as scaffold
import posterior_writeback as writeback
import run_infer_and_extract as extract

EVIDENCE_SNIPPET = '''

# Appended by the end-to-end test: one anchored observation moving one
# sub-criterion, which moves worth.
ev_tension = observe(
    "A survey artifact records an unresolved tension between two established "
    "approximation schemes.",
    rationale="anchor: literature_survey_v1 tensions section (test fixture)",
)
infer(
    ev_tension,
    hypothesis=tension_resolution,
    p_e_given_h=0.90,
    p_e_given_not_h=0.09,
    rationale=(
        "Recorded tension supports the sub-criterion; substantial grade. "
        "anchor: literature_survey_v1 tensions section (test fixture)"
    ),
)
infer(
    tension_resolution,
    hypothesis=worth,
    p_e_given_h=0.75,
    p_e_given_not_h=0.25,
    rationale=(
        "Tension resolution weakly raises worth; weak grade. "
        "anchor: gate_result_v1 record (test fixture)"
    ),
)
'''


EXCLUSIVITY_SNIPPET = '''

# Appended by the end-to-end test: three rival explanations, mutually
# exclusive, expanded pairwise (exclusive() is binary in 0.5.0a4).
from gaia.engine.lang import exclusive

rival_a = claim("Explanation A accounts for the recorded effect.")
rival_b = claim("Explanation B accounts for the recorded effect.")
rival_c = claim("Explanation C accounts for the recorded effect.")
exclusive(rival_a, rival_b, rationale="Rival explanations; at most one true.")
exclusive(rival_a, rival_c, rationale="Rival explanations; at most one true.")
exclusive(rival_b, rival_c, rationale="Rival explanations; at most one true.")
'''


def run_extract(package_dir, gaia_bin, capsys, extra_args=()):
    code = extract.main(
        [
            "--package", str(package_dir),
            "--project-root", str(Path(package_dir).parent),
            "--gaia-bin", gaia_bin,
            *extra_args,
        ]
    )
    assert code == 0
    return json.loads(capsys.readouterr().out)


def test_scaffold_infer_extract_writeback_chain(
    tmp_path, gaia_bin, fixtures_dir, capsys
) -> None:
    # 1. Generate the package skeleton with the real gaia CLI.
    code = scaffold.main(
        [
            "--slug", "example-idea",
            "--dest", str(tmp_path),
            "--gaia-bin", gaia_bin,
        ]
    )
    assert code == 0
    package_dir = tmp_path / "example-idea-gaia"
    assert package_dir.is_dir()
    module_init = scaffold.find_module_dir(package_dir) / "__init__.py"
    text = module_init.read_text(encoding="utf-8")
    assert "worth = claim(" in text
    # Post-init hardening: the zero-commit nested repository is gone and
    # the generated environment pins are retargeted (gaia's own template
    # still writes the silently-broken >=0.4.4 / 3.13 recipe).
    assert not (package_dir / ".git").exists()
    pyproject = (package_dir / "pyproject.toml").read_text(encoding="utf-8")
    assert 'gaia-lang==0.5.0a4' in pyproject
    assert 'requires-python = ">=3.12"' in pyproject
    assert (package_dir / ".python-version").read_text(
        encoding="utf-8"
    ).strip() == "3.12"
    capsys.readouterr()  # drop scaffold output

    # 2. The freshly generated skeleton compiles and infers: pure MaxEnt.
    posterior = run_extract(package_dir, gaia_bin, capsys)
    assert posterior["value"] == pytest.approx(0.5, abs=1e-9)
    assert posterior["evidence_count"] == 0
    # Machine-portable reference: project-relative, never an absolute path.
    assert posterior["gaia_package_ref"].startswith(
        "project://example-idea-gaia#sha256:"
    )

    # 3. Append one anchored observation; the posterior must move up and the
    #    evidence count must see exactly one observation. Also exercise
    #    --output and check it mirrors stdout.
    module_init.write_text(text + EVIDENCE_SNIPPET, encoding="utf-8")
    output_file = tmp_path / "posterior-out.json"
    updated = run_extract(
        package_dir, gaia_bin, capsys, ("--output", str(output_file))
    )
    assert updated["value"] > 0.5
    assert updated["evidence_count"] == 1
    assert updated["gaia_package_ref"] != posterior["gaia_package_ref"]
    assert json.loads(output_file.read_text(encoding="utf-8")) == updated

    # 4. Write the extracted posterior back through the stand-in RPC caller.
    posterior_file = tmp_path / "posterior.json"
    posterior_file.write_text(json.dumps(updated), encoding="utf-8")
    code = writeback.main(
        [
            "--posterior-json", str(posterior_file),
            "--campaign-id", "campaign-e2e",
            "--node-id", "node-e2e",
            "--store-root", str(tmp_path / "store"),
            "--project-root", str(tmp_path),
            "--idea-rpc", str(fixtures_dir / "fake_rpc.py"),
            "--runner", sys.executable,
        ]
    )
    assert code == 0
    response = json.loads(capsys.readouterr().out)
    echoed = response["result"]["echo"]["params"]["posterior"]
    assert echoed["value"] == pytest.approx(updated["value"])
    assert echoed["evidence_count"] == 1


def test_scaffold_refuses_to_overwrite(tmp_path, gaia_bin, capsys) -> None:
    args = [
        "--slug", "twice-idea",
        "--dest", str(tmp_path),
        "--gaia-bin", gaia_bin,
    ]
    assert scaffold.main(args) == 0
    capsys.readouterr()
    assert scaffold.main(args) == 2
    assert "refusing to overwrite" in capsys.readouterr().err


def test_exclusive_is_binary_and_pairwise_expansion_compiles(
    tmp_path, gaia_bin, capsys
) -> None:
    import subprocess

    # 1. The recorded 0.5.0a4 limitation still holds: three positional
    #    claims raise TypeError. If this ever starts passing, the pairwise
    #    guidance in SKILL.md and the issue-log entry must be revisited.
    #    (Runs only when the interpreter next to gaia exists, i.e. the
    #    documented venv install; the pairwise compile below always runs.)
    python = Path(gaia_bin).resolve().parent / "python"
    if python.exists():
        probe = subprocess.run(
            [
                str(python),
                "-c",
                "from gaia.engine.lang import claim, exclusive\n"
                "a = claim('A.'); b = claim('B.'); c = claim('C.')\n"
                "exclusive(a, b, c, rationale='x')\n",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert probe.returncode != 0
        assert "TypeError" in probe.stderr

    # 2. The taught workaround — pairwise expansion — compiles and checks.
    assert scaffold.main(
        ["--slug", "rivals-idea", "--dest", str(tmp_path), "--gaia-bin", gaia_bin]
    ) == 0
    capsys.readouterr()
    package_dir = tmp_path / "rivals-idea-gaia"
    module_init = scaffold.find_module_dir(package_dir) / "__init__.py"
    module_init.write_text(
        module_init.read_text(encoding="utf-8") + EXCLUSIVITY_SNIPPET,
        encoding="utf-8",
    )
    posterior = run_extract(package_dir, gaia_bin, capsys)
    assert posterior["evidence_count"] == 0  # exclusivity is not evidence
