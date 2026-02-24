from __future__ import annotations

import math
import os
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .run_card import ensure_run_card


@dataclass(frozen=True)
class ReproduceInputs:
    tag: str
    case: str = "toy"
    ns: tuple[int, ...] = (0, 1, 2, 5, 10)
    epsabs: float = 1e-12
    epsrel: float = 1e-12
    mpmath_dps: int = 80


def _write_artifacts(
    *,
    repo_root: Path,
    out_dir: Path,
    manifest: dict[str, Any],
    summary: dict[str, Any],
    analysis: dict[str, Any],
) -> dict[str, str]:
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    return {
        "manifest": os.fspath(manifest_path.relative_to(repo_root)),
        "summary": os.fspath(summary_path.relative_to(repo_root)),
        "analysis": os.fspath(analysis_path.relative_to(repo_root)),
        "report": report_rel,
    }


def _toy_gamma_integrals(
    *,
    ns: tuple[int, ...],
    epsabs: float,
    epsrel: float,
    mpmath_dps: int,
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    try:
        from scipy.integrate import quad
    except Exception as e:  # pragma: no cover
        raise RuntimeError(f"scipy is required for toy reproduction but is not available: {e}") from e

    try:
        import mpmath as mp
    except Exception as e:  # pragma: no cover
        raise RuntimeError(f"mpmath is required for toy reproduction but is not available: {e}") from e

    mp.mp.dps = int(mpmath_dps)

    rows: list[dict[str, Any]] = []
    max_abs_err_scipy = 0.0
    max_abs_err_mpmath = 0.0
    max_abs_diff = 0.0
    max_rel_err_scipy = 0.0
    max_rel_err_mpmath = 0.0

    for n in ns:
        if n < 0:
            raise ValueError("n must be >= 0 for the toy gamma-integral case")

        def f_scipy(x: float) -> float:
            return (x**n) * math.exp(-x)

        scipy_val, scipy_abserr = quad(f_scipy, 0.0, math.inf, epsabs=epsabs, epsrel=epsrel)

        def f_mp(x: mp.mpf) -> mp.mpf:
            return (x**n) * mp.e ** (-x)

        mp_val = mp.quad(f_mp, [mp.mpf("0.0"), mp.inf])
        mp_val_f = float(mp_val)

        exact = float(math.factorial(n))

        abs_err_scipy = abs(scipy_val - exact)
        abs_err_mpmath = abs(mp_val_f - exact)
        abs_diff = abs(scipy_val - mp_val_f)
        rel_err_scipy = abs_err_scipy / abs(exact) if exact != 0.0 else abs_err_scipy
        rel_err_mpmath = abs_err_mpmath / abs(exact) if exact != 0.0 else abs_err_mpmath

        max_abs_err_scipy = max(max_abs_err_scipy, abs_err_scipy)
        max_abs_err_mpmath = max(max_abs_err_mpmath, abs_err_mpmath)
        max_abs_diff = max(max_abs_diff, abs_diff)
        max_rel_err_scipy = max(max_rel_err_scipy, rel_err_scipy)
        max_rel_err_mpmath = max(max_rel_err_mpmath, rel_err_mpmath)

        rows.append(
            {
                "n": n,
                "scipy": {"value": float(scipy_val), "abserr_est": float(scipy_abserr), "epsabs": epsabs, "epsrel": epsrel},
                "mpmath": {
                    "value": mp_val_f,
                    "dps": int(mpmath_dps),
                    "value_str": mp.nstr(mp_val, 30),
                },
                "exact": {"value": exact},
                "abs_err_scipy": float(abs_err_scipy),
                "rel_err_scipy": float(rel_err_scipy),
                "abs_err_mpmath": float(abs_err_mpmath),
                "rel_err_mpmath": float(rel_err_mpmath),
                "abs_diff_scipy_mpmath": float(abs_diff),
            }
        )

    headlines: dict[str, float] = {
        "max_abs_err_scipy": float(max_abs_err_scipy),
        "max_abs_err_mpmath": float(max_abs_err_mpmath),
        "max_abs_diff_scipy_mpmath": float(max_abs_diff),
        "max_rel_err_scipy": float(max_rel_err_scipy),
        "max_rel_err_mpmath": float(max_rel_err_mpmath),
    }
    return rows, headlines


def reproduce_one(inps: ReproduceInputs, repo_root: Path) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")

    created_at = utc_now_iso()
    out_dir = repo_root / "artifacts" / "runs" / str(inps.tag) / "reproduce"
    errors: list[str] = []

    versions: dict[str, Any] = {"python": os.sys.version.split()[0], "os": platform.platform()}
    try:
        import scipy

        versions["scipy"] = scipy.__version__
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 optional dependency probe
        pass
    try:
        import mpmath

        versions["mpmath"] = mpmath.__version__
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 optional dependency probe
        pass

    run_card_rel, run_card_sha = ensure_run_card(
        repo_root=repo_root,
        run_id=str(inps.tag),
        workflow_id="W2_reproduce",
        params={
            "tag": inps.tag,
            "case": inps.case,
            "ns": list(inps.ns),
            "epsabs": inps.epsabs,
            "epsrel": inps.epsrel,
            "mpmath_dps": inps.mpmath_dps,
        },
        backend={"kind": "python", "argv": ["python3", "scripts/run_w2_reproduce.py"], "cwd": ".", "env": {}},
        notes="auto-generated run-card (v0)",
        overwrite=False,
    )

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_w2_reproduce.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "inputs": {
            "run_card_path": run_card_rel,
            "run_card_sha256": run_card_sha,
        },
        "params": {
            "tag": inps.tag,
            "case": inps.case,
            "ns": list(inps.ns),
            "epsabs": inps.epsabs,
            "epsrel": inps.epsrel,
            "mpmath_dps": inps.mpmath_dps,
        },
        "versions": versions,
        "outputs": [
            os.fspath((out_dir / "manifest.json").relative_to(repo_root)),
            os.fspath((out_dir / "summary.json").relative_to(repo_root)),
            os.fspath((out_dir / "analysis.json").relative_to(repo_root)),
            os.fspath((out_dir / "report.md").relative_to(repo_root)),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": inps.tag,
            "case": inps.case,
            "ns": list(inps.ns),
            "epsabs": inps.epsabs,
            "epsrel": inps.epsrel,
            "mpmath_dps": inps.mpmath_dps,
        },
        "results": {},
    }
    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "W2_reproduce", "case": inps.case},
        "stats": {},
        "outputs": [
            os.fspath((out_dir / "manifest.json").relative_to(repo_root)),
            os.fspath((out_dir / "summary.json").relative_to(repo_root)),
            os.fspath((out_dir / "analysis.json").relative_to(repo_root)),
            os.fspath((out_dir / "report.md").relative_to(repo_root)),
        ],
    }

    if inps.case != "toy":
        errors.append(f"unsupported case: {inps.case} (v0 supports only 'toy')")
        analysis["results"] = {"ok": False, "errors": errors}
        summary["stats"] = {"ok": False, "errors": len(errors)}
        artifact_paths = _write_artifacts(
            repo_root=repo_root,
            out_dir=out_dir,
            manifest=manifest,
            summary=summary,
            analysis=analysis,
        )
        return {"case": inps.case, "errors": errors, "artifact_paths": artifact_paths, "artifact_dir": os.fspath(out_dir.relative_to(repo_root))}

    try:
        rows, headlines = _toy_gamma_integrals(
            ns=inps.ns,
            epsabs=float(inps.epsabs),
            epsrel=float(inps.epsrel),
            mpmath_dps=int(inps.mpmath_dps),
        )
    except Exception as e:
        errors.append(str(e))
        analysis["results"] = {"ok": False, "errors": errors}
        summary["stats"] = {"ok": False, "errors": len(errors)}
        artifact_paths = _write_artifacts(
            repo_root=repo_root,
            out_dir=out_dir,
            manifest=manifest,
            summary=summary,
            analysis=analysis,
        )
        return {"case": inps.case, "errors": errors, "artifact_paths": artifact_paths, "artifact_dir": os.fspath(out_dir.relative_to(repo_root))}

    max_abs_err_scipy = max((r["abs_err_scipy"] for r in rows), default=0.0)
    max_abs_err_mpmath = max((r["abs_err_mpmath"] for r in rows), default=0.0)
    max_abs_diff = max((r["abs_diff_scipy_mpmath"] for r in rows), default=0.0)

    analysis["results"] = {
        "ok": True,
        "errors": [],
        "integrals": rows,
        "headlines": {
            "max_abs_err_scipy": float(max_abs_err_scipy),
            "max_abs_err_mpmath": float(max_abs_err_mpmath),
            "max_abs_diff_scipy_mpmath": float(max_abs_diff),
        },
    }

    summary["stats"] = {
        "ok": True,
        "n_points": len(rows),
        "max_abs_err_scipy": float(max_abs_err_scipy),
        "max_abs_err_mpmath": float(max_abs_err_mpmath),
        "max_abs_diff_scipy_mpmath": float(max_abs_diff),
    }

    artifact_paths = _write_artifacts(
        repo_root=repo_root,
        out_dir=out_dir,
        manifest=manifest,
        summary=summary,
        analysis=analysis,
    )
    return {
        "case": inps.case,
        "errors": errors,
        "artifact_paths": artifact_paths,
        "artifact_dir": os.fspath(out_dir.relative_to(repo_root)),
    }
