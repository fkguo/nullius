#!/usr/bin/env python3
"""
dl_lab_scaffold.py

Create a reproducible deep-learning research project skeleton with:
- Draft_Derivation.md (method/definitions notebook stub)
- knowledge_base/ (audit trail: data, decisions, literature, methodology traces)
- artifacts/runs/<tag>/ layout + a demo `scripts/make_artifacts.py` emitting (manifest/summary/analysis)

This is framework-agnostic scaffolding (PyTorch/JAX/TF can be added later).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _ensure_empty_dir(path: Path, *, force: bool) -> None:
    if path.exists():
        if any(path.iterdir()) and not force:
            raise FileExistsError(f"destination not empty: {path} (use --force to overwrite)")
    path.mkdir(parents=True, exist_ok=True)


PROJECT_README = """# {name}

Reproducible deep-learning research project scaffold (framework-agnostic).

## Quickstart

Generate a demo artifacts run:

```bash
python3 scripts/make_artifacts.py --tag M0-demo
```

## Layout

- `Draft_Derivation.md`: derivations / definitions / evaluation protocol (living notebook).
- `knowledge_base/`: audit trail (data provenance, decisions, literature notes, methodology traces).
- `artifacts/runs/<tag>/`: run outputs (manifest/summary/analysis), designed to interoperate with `research-writer`.
"""


DERIVATION_MD = """# Draft Derivation / Notes (deep learning)

## Problem definition

\\textbf{[TODO: define the task/observable precisely | source: data + protocol]}

## Model and training objective

\\textbf{[TODO: define the loss, architecture, and training setup | source: code + config]}

## Evaluation protocol

\\textbf{[TODO: define metrics, datasets/splits, and uncertainty estimation | source: methodology traces]}

## Results

\\textbf{[TODO: summarize headline metrics with provenance pointers into artifacts | source: artifacts/runs/<tag>/analysis.json]}
"""


MAKE_ARTIFACTS_PY = """#!/usr/bin/env python3
\"\"\"
make_artifacts.py

Demo artifacts generator for the deep-learning-lab scaffold.

Writes:
- artifacts/runs/<tag>/manifest.json
- artifacts/runs/<tag>/summary.json
- artifacts/runs/<tag>/analysis.json

This is a placeholder run to validate wiring. Replace the demo numbers with real training/eval.
\"\"\"

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


ARTIFACT_SCHEMA_VERSION = 1


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + \"\\n\", encoding=\"utf-8\")


def _sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open(\"rb\") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _run_cmd(cmd: list[str], *, cwd: Optional[Path] = None, timeout_s: float = 2.0) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except FileNotFoundError as exc:
        return 127, \"\", str(exc)
    except subprocess.TimeoutExpired as exc:
        return 124, \"\", str(exc)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _find_git_root(start: Path) -> Optional[Path]:
    cur = start.resolve()
    for p in [cur, *cur.parents]:
        if (p / \".git\").exists():
            return p
    return None


def _git_meta(repo_root: Path) -> dict[str, Any]:
    git_root = _find_git_root(repo_root)
    if git_root is None:
        return {\"available\": False, \"error\": \"no .git found\", \"repo_root\": str(repo_root)}
    meta: dict[str, Any] = {\"available\": True, \"repo_root\": str(git_root)}

    rc, out, err = _run_cmd([\"git\", \"rev-parse\", \"HEAD\"], cwd=git_root)
    meta[\"commit\"] = out if rc == 0 else None
    if rc != 0:
        meta[\"commit_error\"] = err or out

    rc, out, err = _run_cmd([\"git\", \"rev-parse\", \"--abbrev-ref\", \"HEAD\"], cwd=git_root)
    meta[\"branch\"] = out if rc == 0 else None
    if rc != 0:
        meta[\"branch_error\"] = err or out

    rc, out, err = _run_cmd([\"git\", \"status\", \"--porcelain=v1\"], cwd=git_root)
    meta[\"is_dirty\"] = bool(out) if rc == 0 else None
    if rc != 0:
        meta[\"dirty_error\"] = err or out

    return meta


def _pip_freeze() -> dict[str, Any]:
    rc, out, err = _run_cmd([sys.executable, \"-m\", \"pip\", \"freeze\"], timeout_s=10.0)
    if rc != 0:
        return {\"available\": False, \"error\": err or out}
    return {\"available\": True, \"packages\": [ln for ln in out.splitlines() if ln.strip()]}


def _environment() -> dict[str, Any]:
    return {
        \"python\": {\"executable\": sys.executable, \"version\": sys.version.replace(\"\\n\", \" \")},
        \"platform\": {
            \"system\": platform.system(),
            \"release\": platform.release(),
            \"machine\": platform.machine(),
        },
        \"process\": {\"pid\": os.getpid()},
        \"pip_freeze\": _pip_freeze(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(\"--tag\", required=True)
    ap.add_argument(\"--run-card\", type=Path, default=None, help=\"Optional JSON run-card.\")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    run_dir = root / \"artifacts\" / \"runs\" / args.tag
    run_dir.mkdir(parents=True, exist_ok=True)
    started_at = time.time()

    run_card_path: Optional[Path] = None
    run_card_sha256: Optional[str] = None
    if args.run_card is not None:
        run_card_path = args.run_card.expanduser().resolve()
        run_card_sha256 = _sha256_file(run_card_path)

    ckpt_path = run_dir / \"checkpoints\" / \"best.json\"
    _write_json(
        ckpt_path,
        {
            \"schema_version\": ARTIFACT_SCHEMA_VERSION,
            \"epoch\": 7,
            \"model\": {\"type\": \"placeholder\"},
            \"selected_by\": \"val_accuracy_best\",
        },
    )

    duration_s = time.time() - started_at

    summary = {
        \"schema_version\": ARTIFACT_SCHEMA_VERSION,
        \"created_at\": _utc_now(),
        \"primary_metric\": \"val_accuracy_best\",
        \"metrics\": {
            \"val_accuracy_best\": 0.90,
            \"test_accuracy\": 0.88,
            \"best_epoch\": 7,
            \"duration_seconds\": duration_s,
        },
        \"metric_definitions\": {
            \"val_accuracy_best\": {
                \"definition\": \"Demo accuracy on validation split at best epoch.\",
                \"unit\": \"fraction\",
                \"higher_is_better\": True,
            },
            \"test_accuracy\": {
                \"definition\": \"Demo accuracy on test split.\",
                \"unit\": \"fraction\",
                \"higher_is_better\": True,
            },
            \"best_epoch\": {
                \"definition\": \"Epoch index chosen as best in this demo.\",
                \"unit\": \"epoch\",
                \"higher_is_better\": False,
            },
            \"duration_seconds\": {
                \"definition\": \"Wall-clock duration of this run in seconds.\",
                \"unit\": \"s\",
                \"higher_is_better\": False,
            },
        },
        \"best_checkpoint\": {
            \"path\": \"checkpoints/best.json\",
            \"selected_by\": \"val_accuracy_best\",
            \"epoch\": 7,
        },
        \"notes\": \"Demo numbers only. Replace with real training/eval outputs.\",
    }
    _write_json(run_dir / \"summary.json\", summary)

    analysis = {
        \"schema_version\": ARTIFACT_SCHEMA_VERSION,
        \"created_at\": summary[\"created_at\"],
        \"results\": {
            \"val_accuracy_best\": 0.90,
            \"test_accuracy\": 0.88,
            \"best_epoch\": 7,
        },
        \"history\": [{\"epoch\": 1, \"train_loss\": 1.0}, {\"epoch\": 7, \"train_loss\": 0.4}],
        \"notes\": summary[\"notes\"],
    }
    _write_json(run_dir / \"analysis.json\", analysis)

    manifest = {
        \"schema_version\": ARTIFACT_SCHEMA_VERSION,
        \"created_at\": summary[\"created_at\"],
        \"tag\": args.tag,
        \"code\": {\"git\": _git_meta(repo_root=root)},
        \"environment\": _environment(),
        \"data\": [
            {
                \"name\": \"UNSET\",
                \"path\": \"UNSET\",
                \"url\": \"UNSET\",
                \"sha256\": \"UNSET\",
                \"notes\": \"Fill in dataset provenance (path/hash/url) here.\",
            }
        ],
        \"hyperparameters\": {\"seed\": \"UNSET\", \"config\": \"UNSET\"},
        \"inputs\": {
            \"run_card\": {\"path\": str(run_card_path) if run_card_path else None, \"sha256\": run_card_sha256}
        },
        \"outputs\": [
            {\"path\": f\"artifacts/runs/{args.tag}/manifest.json\"},
            {\"path\": f\"artifacts/runs/{args.tag}/summary.json\"},
            {\"path\": f\"artifacts/runs/{args.tag}/analysis.json\"},
            {\"path\": f\"artifacts/runs/{args.tag}/checkpoints/best.json\"},
        ],
        \"paths_are_relative_to\": \"project_root\",
        \"run\": {\"command\": [sys.executable, *sys.argv], \"run_dir\": str(run_dir), \"duration_seconds\": duration_s},
    }
    _write_json(run_dir / \"manifest.json\", manifest)

    print(f\"[ok] wrote demo artifacts: {run_dir}\")
    return 0


if __name__ == \"__main__\":
    raise SystemExit(main())
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path, help="Output directory for the new project.")
    ap.add_argument("--name", default="dl-project", help="Project name (used in README).")
    ap.add_argument("--force", action="store_true", help="Allow non-empty destination (overwrite files).")
    args = ap.parse_args()

    out_dir = args.out.expanduser().resolve()
    try:
        _ensure_empty_dir(out_dir, force=bool(args.force))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    _write_text(out_dir / "README.md", PROJECT_README.format(name=args.name).rstrip() + "\n")
    _write_text(out_dir / "Draft_Derivation.md", DERIVATION_MD.rstrip() + "\n")

    _write_text(out_dir / "references.bib", '% Minimal BibTeX placeholder\n@article{Placeholder,\n  title={TODO},\n  year={2026},\n  journal=\"\"\n}\n')

    for sub in (
        out_dir / "knowledge_base" / "data",
        out_dir / "knowledge_base" / "decisions",
        out_dir / "knowledge_base" / "literature",
        out_dir / "knowledge_base" / "methodology_traces",
        out_dir / "artifacts" / "runs",
        out_dir / "scripts",
    ):
        sub.mkdir(parents=True, exist_ok=True)

    _write_text(
        out_dir / "knowledge_base" / "data" / "README.md",
        "# Data provenance\n\n- [TODO] source URLs, checksums, split logic, and preprocessing.\n",
    )
    _write_text(
        out_dir / "knowledge_base" / "decisions" / "README.md",
        "# Decisions log\n\n- [TODO] what was tried, what failed, why, and what to try next.\n",
    )
    _write_text(
        out_dir / "knowledge_base" / "methodology_traces" / "README.md",
        "# Methodology traces\n\n- [TODO] metrics definitions, baselines, ablations, evaluation protocol.\n",
    )
    _write_text(
        out_dir / "knowledge_base" / "literature" / "README.md",
        "# Literature notes\n\n- [TODO] key prior work notes + UNVERIFIED claims and validation plans.\n",
    )

    _write_text(out_dir / "scripts" / "make_artifacts.py", MAKE_ARTIFACTS_PY)
    (out_dir / "scripts" / "make_artifacts.py").chmod(0o755)

    _write_json(
        out_dir / "project_meta.json",
        {
            "created_at": _utc_now(),
            "project_name": args.name,
            "generator": "deep-learning-lab/scripts/bin/dl_lab_scaffold.py",
        },
    )

    print("[ok] deep-learning-lab project scaffolded")
    print(f"- out: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
