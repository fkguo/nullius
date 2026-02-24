#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


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


def main() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Probe sidecar config and print tab-separated launch lines for non-blocking sidecar reviews.\n\n"
            "Back-compat:\n"
            "- If config.sidecar_reviews is a non-empty list, it is used.\n"
            "- Else config.sidecar_review (singular dict) is used.\n"
        )
    )
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
    from team_config import load_team_config  # type: ignore

    notes = args.notes
    cfg = load_team_config(notes)

    force = os.environ.get("SIDECAR_FORCE", "").lower() in ("force_on", "1", "true", "yes", "on")
    kind = _parse_milestone_kind(notes)

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

        enabled = force or (bool(sc.get("enabled", False)) and kind not in set(exclude_kinds))
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

        print("\t".join([str(bool(enabled)).lower(), model, system_prompt, runner, output_format, tag_suffix, str(timeout_n)]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
