#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# Numerical artifact extensions that suggest a numerics sidecar would be useful.
_NUMERIC_EXTS = frozenset({
    ".csv", ".tsv", ".json", ".jsonl",
    ".h5", ".hdf5", ".parquet", ".nc", ".npz", ".npy",
    ".mat", ".fits", ".root",
})


def _parse_milestone_kind(notes: Path) -> str:
    kind = "computational"
    try:
        text = notes.read_text(encoding="utf-8", errors="replace")
        start = "<!-- REPRO_CAPSULE_START -->"
        end = "<!-- REPRO_CAPSULE_END -->"
        if start in text and end in text:
            a = text.index(start) + len(start)
            b = text.index(end)
            capsule = text[a:b]
            m = re.search(r"^\s*(?:-\s*)?Milestone kind\s*:\s*(.+?)\s*$", capsule, flags=re.IGNORECASE | re.MULTILINE)
            if m:
                v = m.group(1).strip().lower()
                if v in ("theory", "theory-only", "analytic", "derivation"):
                    kind = "theory"
                elif v in ("dataset", "data_prep", "data-prep", "dataprep", "data", "generate-data"):
                    kind = "dataset"
                else:
                    kind = "computational"
    except Exception:
        pass
    return kind


def _has_numerical_artifacts(notes: Path) -> bool:
    """Auto-detect whether the notebook references numerical artifacts.

    Checks:
    1. Capsule "Expected outputs" lists files with numerical extensions.
    2. The notebook text mentions paths ending in numerical extensions.
    """
    try:
        text = notes.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False

    # Check capsule outputs
    start_marker = "<!-- REPRO_CAPSULE_START -->"
    end_marker = "<!-- REPRO_CAPSULE_END -->"
    capsule = ""
    if start_marker in text and end_marker in text:
        a = text.index(start_marker) + len(start_marker)
        b = text.index(end_marker)
        capsule = text[a:b]

    # Scan for numerical artifact paths in capsule and notebook text
    for line in (capsule + "\n" + text).splitlines():
        stripped = line.strip()
        # Match bullet lines with paths
        m = re.match(r"^\s*-\s+(\S+)", stripped)
        if m:
            path_str = m.group(1).rstrip(",;)")
            if any(path_str.lower().endswith(ext) for ext in _NUMERIC_EXTS):
                return True
        # Match inline path references (backtick or bare)
        for ext in _NUMERIC_EXTS:
            if ext in stripped.lower():
                return True

    return False


def main() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Probe sidecar config and print tab-separated launch lines for non-blocking sidecar reviews.\n\n"
            "Back-compat:\n"
            "- If config.sidecar_reviews is a non-empty list, it is used.\n"
            "- Else config.sidecar_review (singular dict) is used.\n\n"
            "Auto-detection (RT-01):\n"
            "- If SIDECAR_MODE=auto and notebook references numerical artifacts,\n"
            "  auto-enable the numerics sidecar even if config.enabled=false.\n"
        )
    )
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
    from team_config import load_team_config  # type: ignore

    notes = args.notes
    cfg = load_team_config(notes)

    force = os.environ.get("SIDECAR_FORCE", "").lower() in ("force_on", "1", "true", "yes", "on")
    sidecar_mode = os.environ.get("SIDECAR_MODE", "auto").strip().lower()
    kind = _parse_milestone_kind(notes)

    # RT-01: auto-detect numerical artifacts for sidecar auto-enable
    auto_enable = False
    if sidecar_mode == "auto" and not force:
        auto_enable = _has_numerical_artifacts(notes)

    sidecar_reviews = cfg.data.get("sidecar_reviews", [])
    sidecars: list[dict] = []
    if isinstance(sidecar_reviews, list) and sidecar_reviews:
        sidecars = [x for x in sidecar_reviews if isinstance(x, dict)]
    else:
        sc = cfg.data.get("sidecar_review", {})
        if isinstance(sc, dict) and sc:
            sidecars = [sc]

    for sc in sidecars:
        exclude_kinds = sc.get("kinds_exclude", None)
        if not isinstance(exclude_kinds, list):
            # Back-compat: numerics sidecars should not run on theory milestones by default.
            exclude_kinds = ["theory"]
        exclude_kinds = [str(x).strip().lower() for x in exclude_kinds if str(x).strip()]

        config_enabled = bool(sc.get("enabled", False))
        kind_ok = kind not in set(exclude_kinds)

        # RT-01: auto-enable overrides config_enabled when numerical artifacts detected
        enabled = force or ((config_enabled or auto_enable) and kind_ok)
        if not enabled:
            continue

        model = str(sc.get("model", "") or "")
        system_prompt = str(sc.get("system_prompt", "") or "")
        runner = str(sc.get("runner", "claude") or "claude").lower()
        output_format = str(sc.get("output_format", "text") or "text")
        tag_suffix = str(sc.get("tag_suffix", "member_c") or "member_c")
        timeout_secs = sc.get("timeout_secs", 0)
        try:
            timeout_n = int(timeout_secs)
        except Exception:
            timeout_n = 0
        if timeout_n < 0:
            timeout_n = 0

        source = "force" if force else ("auto" if auto_enable and not config_enabled else "config")
        print("\t".join([str(bool(enabled)).lower(), model, system_prompt, runner, output_format, tag_suffix, str(timeout_n), source]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
