#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import zlib
from datetime import datetime, timezone
from pathlib import Path


def _png_1x1_rgba(*, r: int = 0, g: int = 0, b: int = 0, a: int = 255) -> bytes:
    """
    Deterministically generate a valid 1x1 RGBA PNG with correct CRCs.
    """
    def chunk(typ: bytes, data: bytes) -> bytes:
        ln = len(data).to_bytes(4, "big")
        crc = zlib.crc32(typ + data) & 0xFFFFFFFF
        return ln + typ + data + crc.to_bytes(4, "big")

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes([8, 6, 0, 0, 0])
    raw = bytes([0, r & 0xFF, g & 0xFF, b & 0xFF, a & 0xFF])  # filter=0 + RGBA
    comp = zlib.compress(raw)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate deterministic fixture artifacts for research-writer smoke tests.")
    ap.add_argument("--tag", required=True, help="Run tag (e.g., M2-fixture).")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    tag = args.tag.strip()
    run_dir = root / "artifacts" / "runs" / tag
    fig_dir = run_dir / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    fig_path = fig_dir / "demo.png"
    fig_path.write_bytes(_png_1x1_rgba(r=30, g=144, b=255, a=255))  # dodgerblue

    analysis_path = run_dir / "analysis.json"
    manifest_path = run_dir / "manifest.json"

    analysis = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "definitions": {
            "a": "demo scalar a (exact)",
            "b": "demo scalar b (exact)",
            "c": "demo scalar c (exact)",
        },
        "results": {"a": 1, "b": 2, "c": 3},
        "outputs": {"figure_demo": str(fig_path.relative_to(root))},
    }
    analysis_path.write_text(json.dumps(analysis, indent=2) + "\n", encoding="utf-8")

    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "command": f"python3 scripts/make_artifacts.py --tag {tag}",
        "cwd": ".",
        "params": {"tag": tag},
        "outputs": [
            {"path": str(manifest_path.relative_to(root)), "kind": "manifest"},
            {"path": str(analysis_path.relative_to(root)), "kind": "analysis"},
            {"path": str(fig_path.relative_to(root)), "kind": "figure"},
        ],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print("[ok] wrote fixture artifacts")
    print(f"- run dir: {run_dir}")
    print(f"- manifest: {manifest_path}")
    print(f"- analysis: {analysis_path}")
    print(f"- figure: {fig_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
