"""End-to-end test against a real pinned Gaia installation.

Skips (with the install recipe) when gaia 0.5.0a4 is not available; on the
development machine it must run for real.
"""

from __future__ import annotations

import json
import sys

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


def run_extract(package_dir, gaia_bin, capsys):
    code = extract.main(
        ["--package", str(package_dir), "--gaia-bin", gaia_bin]
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
    capsys.readouterr()  # drop scaffold output

    # 2. The freshly generated skeleton compiles and infers: pure MaxEnt.
    posterior = run_extract(package_dir, gaia_bin, capsys)
    assert posterior["value"] == pytest.approx(0.5, abs=1e-9)
    assert posterior["evidence_count"] == 0
    assert posterior["gaia_package_ref"].startswith(str(package_dir.resolve()))
    assert "#sha256:" in posterior["gaia_package_ref"]

    # 3. Append one anchored observation; the posterior must move up and the
    #    evidence count must see exactly one observation.
    module_init.write_text(text + EVIDENCE_SNIPPET, encoding="utf-8")
    updated = run_extract(package_dir, gaia_bin, capsys)
    assert updated["value"] > 0.5
    assert updated["evidence_count"] == 1
    assert updated["gaia_package_ref"] != posterior["gaia_package_ref"]

    # 4. Write the extracted posterior back through the stand-in RPC caller.
    posterior_file = tmp_path / "posterior.json"
    posterior_file.write_text(json.dumps(updated), encoding="utf-8")
    code = writeback.main(
        [
            "--posterior-json", str(posterior_file),
            "--campaign-id", "campaign-e2e",
            "--node-id", "node-e2e",
            "--store-root", str(tmp_path / "store"),
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
