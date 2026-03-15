#!/usr/bin/env python3
"""
Generate a deterministic demo milestone inside a scaffolded project.

This is intended for NEW users to "cold start" quickly:
- Creates a tiny demo artifact generator under <root>/scripts/
- Generates <root>/artifacts/<tag>_analysis.json and <tag>_manifest.json
- Replaces the Reproducibility Capsule in <root>/<notes> with a complete, passing example
  (including a minimal Knowledge base references section to satisfy knowledge-layers gate).

Exit codes:
  0  ok
  1  runtime failure (I/O, marker missing, etc.)
  2  input error (bad args, missing files, etc.)
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path


CAPSULE_START = "<!-- REPRO_CAPSULE_START -->"
CAPSULE_END = "<!-- REPRO_CAPSULE_END -->"
AUDIT_START = "<!-- AUDIT_SLICES_START -->"
AUDIT_END = "<!-- AUDIT_SLICES_END -->"
EXCERPT_START = "<!-- REVIEW_EXCERPT_START -->"
EXCERPT_END = "<!-- REVIEW_EXCERPT_END -->"


@dataclass(frozen=True)
class DemoPlan:
    tag: str
    kind: str
    date_s: str
    notes_path: Path
    artifact_script_rel: str
    analysis_rel: str
    manifest_rel: str


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _safe_tag(tag: str) -> str | None:
    t = tag.strip()
    if not t:
        return None
    # Keep filenames safe: no whitespace or path separators.
    if any(ch.isspace() for ch in t):
        return None
    if "/" in t or "\\" in t:
        return None
    if len(t) > 64:
        return None
    return t


def _numpy_version() -> str:
    try:
        import numpy as np  # type: ignore

        return str(np.__version__)
    except Exception:
        return "n/a"


def _write_artifact_generator(root: Path) -> Path:
    scripts_dir = root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    path = scripts_dir / "make_demo_artifacts.py"
    content = """#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Write demo artifacts for research-team capsule gate.")
    ap.add_argument("--tag", required=True, help="Milestone/tag (used in output filenames).")
    args = ap.parse_args()

    tag = args.tag.strip()
    if not tag:
        raise SystemExit("ERROR: empty --tag")

    root = Path(__file__).resolve().parent.parent
    out_dir = root / "artifacts"
    out_dir.mkdir(parents=True, exist_ok=True)

    analysis = out_dir / f"{tag}_analysis.json"
    manifest = out_dir / f"{tag}_manifest.json"

    a = 1.0
    b = 2.0
    c = 3.0

    analysis_obj = {
        "diagnostics": {"a_plus_b_minus_c": a + b - c},
        "results": {"a": a, "b": b, "c": c},
    }
    analysis.write_text(json.dumps(analysis_obj, indent=2, sort_keys=True) + "\\n", encoding="utf-8")

    manifest_obj = {
        "tag": tag,
        "outputs": [str(manifest.relative_to(root)), str(analysis.relative_to(root))],
        "note": "demo artifact manifest (deterministic)",
    }
    manifest.write_text(json.dumps(manifest_obj, indent=2, sort_keys=True) + "\\n", encoding="utf-8")

    print("wrote:", manifest)
    print("wrote:", analysis)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
"""
    path.write_text(content, encoding="utf-8")
    return path


def _build_capsule(
    plan: DemoPlan,
    python_ver: str,
    numpy_ver: str,
    artifact_sha256: str,
    *,
    kb_literature: str,
    kb_methodology: str,
    kb_priors: str,
) -> str:
    # Keep this capsule minimal but fully passing under check_reproducibility_capsule.py.
    return f"""## Reproducibility Capsule (MANDATORY, per milestone/tag)

- Milestone/tag: {plan.tag}
- Milestone kind: {plan.kind}
- Date: {plan.date_s}

### A) Model, normalization, units, and truncation

- Starting equations / model variant: demo (replace with your model)
- Normalization / units (explicit): n/a
- Retained terms (LO/NLO etc.; write what is kept): n/a
- Dropped terms / truncation (write what is discarded and why): n/a

### B) Exact inputs (numbers + scheme/scale)

| Name | Value | Units/Normalization | Notes (scheme/scale) |
|---|---:|---|---|
| demo_param | 1.0 | n/a | demo |

### G) Sweep semantics / parameter dependence (MANDATORY)

- Scanned variables: none
- Dependent recomputations: none
- Held-fixed constants: n/a

### H) Branch Semantics / Multi-root Contract (MANDATORY)

- Multi-root quantities: none
- Bands shown: no
- Branches: none

### I) Knowledge base references (MANDATORY when enabled)

Literature:
- {kb_literature}

Methodology traces:
- {kb_methodology}

Priors:
- {kb_priors}

### C) One-command reproduction (exact CLI)

```bash
python3 {plan.artifact_script_rel} --tag {plan.tag}
```

### D) Expected outputs (paths) + provenance

- {plan.manifest_rel}
- {plan.analysis_rel}

### E) Headline numbers (at least 3; copied from artifacts, not “see file”)

- Min nontrivial headlines: 1
- H1: [T1] a = 1.0 (from {plan.analysis_rel}:results.a)
- H2: [T2] a_plus_b_minus_c = 0.0 (from {plan.analysis_rel}:diagnostics.a_plus_b_minus_c)
- H3: [T1] c = 3.0 (from {plan.analysis_rel}:results.c)

### F) Environment versions + key source pointers (paths; include hash/commit if possible)

- Environment:
  - python: {python_ver}
  - numpy: {numpy_ver}
- Source pointers (include hash/commit if possible):
  - {plan.artifact_script_rel} (sha256={artifact_sha256})
""".strip()


def _replace_capsule(notes_text: str, new_capsule: str) -> str:
    if CAPSULE_START not in notes_text or CAPSULE_END not in notes_text:
        raise ValueError(f"Missing capsule markers {CAPSULE_START} ... {CAPSULE_END}")
    a = notes_text.index(CAPSULE_START) + len(CAPSULE_START)
    b = notes_text.index(CAPSULE_END)
    return notes_text[:a] + "\n\n" + new_capsule.strip() + "\n\n" + notes_text[b:]


def _replace_block(notes_text: str, start_marker: str, end_marker: str, replacement: str) -> str:
    if start_marker not in notes_text or end_marker not in notes_text:
        raise ValueError(f"Missing markers {start_marker} ... {end_marker}")
    a = notes_text.index(start_marker) + len(start_marker)
    b = notes_text.index(end_marker)
    if b < a:
        raise ValueError(f"Bad marker order for {start_marker} ... {end_marker}")
    return notes_text[:a] + "\n" + replacement.strip() + "\n" + notes_text[b:]


def _capsule_looks_filled(notes_text: str) -> bool:
    if CAPSULE_START not in notes_text or CAPSULE_END not in notes_text:
        return False
    a = notes_text.index(CAPSULE_START) + len(CAPSULE_START)
    b = notes_text.index(CAPSULE_END)
    capsule = notes_text[a:b]
    # Conservative: if it still has obvious template placeholders, treat as "not filled".
    placeholders = ("<FULL COMMAND LINE>", "<path/to/", "<quantity>", "<value>", "<YYYY-MM-DD>")
    lower = capsule.lower()
    return not any(ph.lower() in lower for ph in placeholders)


def _write_if_missing(path: Path, content: str) -> None:
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip() + "\n", encoding="utf-8")


def _ensure_mapping_row(notes_text: str, row: str) -> str:
    """
    Ensure research_contract.md Section 6 mapping table has at least one filled row so the
    packet completeness gate can pass on cold start.
    """
    # Prefer replacing the template Q1 row if present.
    updated, n = re.subn(r"^\|\s*Q1\s*\|.*\|\s*$", row, notes_text, count=1, flags=re.MULTILINE)
    if n:
        return updated

    # Fallback: insert after the mapping table header.
    lines = notes_text.splitlines(True)
    for i, ln in enumerate(lines):
        if not ln.lstrip().startswith("|"):
            continue
        if "Quantity" in ln and "Code pointer" in ln and "Artifact pointer" in ln:
            # Insert after the separator line if it exists, else right after header.
            insert_at = i + 1
            if insert_at < len(lines) and lines[insert_at].lstrip().startswith("|"):
                insert_at += 1
            lines.insert(insert_at, row.rstrip() + "\n")
            return "".join(lines)
    return notes_text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, required=True, help="Project root (must already be scaffolded).")
    ap.add_argument("--tag", type=str, required=True, help="Milestone/tag (used in outputs and capsule).")
    ap.add_argument("--notes", type=str, default="research_contract.md", help="Notebook filename under --root (default: research_contract.md).")
    ap.add_argument("--force", action="store_true", help="Overwrite an already-filled capsule.")
    ap.add_argument(
        "--kind",
        choices=["theory"],
        default="theory",
        help="Demo milestone kind (currently only 'theory' is supported).",
    )
    args = ap.parse_args()

    root = args.root.expanduser().resolve()
    if not root.is_dir():
        print(f"ERROR: project root not found: {root}", file=sys.stderr)
        return 2

    tag = _safe_tag(args.tag)
    if tag is None:
        print(f"ERROR: invalid --tag: {args.tag!r} (no spaces/slashes; <=64 chars)", file=sys.stderr)
        return 2

    notes_path = (root / args.notes).resolve()
    if not notes_path.is_file():
        print(f"ERROR: notes not found: {notes_path}", file=sys.stderr)
        print("Hint: run scaffold first: scaffold_research_workflow.sh --root <dir> --project ...", file=sys.stderr)
        return 2

    # Ensure knowledge base directory structure exists (some modes may enable the gate by default).
    (root / "knowledge_base" / "literature").mkdir(parents=True, exist_ok=True)
    (root / "knowledge_base" / "methodology_traces").mkdir(parents=True, exist_ok=True)
    (root / "knowledge_base" / "priors").mkdir(parents=True, exist_ok=True)

    try:
        notes_text = notes_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        print(f"ERROR: failed to read notes: {notes_path}: {e}", file=sys.stderr)
        return 1

    if _capsule_looks_filled(notes_text) and not args.force:
        print("ERROR: capsule already looks filled; refusing to overwrite without --force", file=sys.stderr)
        return 2

    artifact_script = _write_artifact_generator(root)
    artifact_sha256 = _sha256_file(artifact_script)

    # Create minimal knowledge-base notes so knowledge_layers + references gates can pass on cold start.
    kb_lit_rel = "knowledge_base/literature/bezanson2017_julia.md"
    kb_meth_rel = "knowledge_base/methodology_traces/demo_trace.md"
    kb_pri_rel = "knowledge_base/priors/demo_priors.md"

    _write_if_missing(
        root / kb_lit_rel,
        """# Bezanson et al. 2017 — Julia: A Fresh Approach to Numerical Computing

RefKey: Bezanson2017
Authors: J. Bezanson et al.
Publication: SIAM Rev. 59 (2017) 65
Links:
- DOI: https://doi.org/10.1137/141000671

Why we cite it (demo):
- Reproducibility and performance considerations for numerical research workflows.
""",
    )
    _write_if_missing(
        root / kb_meth_rel,
        """# Demo methodology trace — how to verify the demo artifacts

Goal:
- Provide a tiny, auditable methodology trace that can be reused as a pattern.

Procedure:
1) Run the reproduction command in Capsule C).
2) Inspect `artifacts/<tag>_analysis.json` and confirm `results.a/b/c` equal 1/2/3.
3) Confirm the manifest lists the output paths.
""",
    )
    _write_if_missing(
        root / kb_pri_rel,
        """# Demo priors — minimal example

Priors / assumptions:
- None (demo).
""",
    )

    # Create demo artifacts by running the generator once.
    try:
        subprocess.check_call([sys.executable, str(artifact_script), "--tag", tag], cwd=str(root))
    except subprocess.CalledProcessError as e:
        print(f"ERROR: artifact generator failed: {e}", file=sys.stderr)
        return 1

    plan = DemoPlan(
        tag=tag,
        kind=args.kind,
        date_s=date.today().isoformat(),
        notes_path=notes_path,
        artifact_script_rel="scripts/make_demo_artifacts.py",
        analysis_rel=f"artifacts/{tag}_analysis.json",
        manifest_rel=f"artifacts/{tag}_manifest.json",
    )

    py_ver = sys.version.split()[0]
    np_ver = _numpy_version()
    capsule = _build_capsule(
        plan,
        python_ver=py_ver,
        numpy_ver=np_ver,
        artifact_sha256=artifact_sha256,
        kb_literature=kb_lit_rel,
        kb_methodology=kb_meth_rel,
        kb_priors=kb_pri_rel,
    )

    review_excerpt = f"""Demo review excerpt (auto-generated).

Claimed headline numbers (from `{plan.analysis_rel}`):

$$
a = 1, \\quad b = 2, \\quad c = 3.
$$

Minimal consistency check:

$$
a + b = 3.
$$
"""

    audit_slices = f"""- Key algorithm steps to cross-check:
  - Run `python3 {plan.artifact_script_rel} --tag {plan.tag}` and confirm both output JSON files exist.
  - Open `{plan.analysis_rel}` and verify `results.a/b/c`.
- Proxy headline numbers (audit quantities; fast to verify by hand/estimate):
  - H1: a = 1.0
  - H2: b = 2.0
  - H3: c = 3.0
- Boundary or consistency checks (limits/symmetry/conservation):
  - Check `a + b = 3` (sanity check).
- Trivial operations not rechecked (standard library, IO, plotting):
  - JSON parsing and file IO are treated as standard-library operations.
- Audit slice artifacts (logs/tables):
  - `{plan.manifest_rel}`, `{plan.analysis_rel}`
"""

    try:
        updated = _replace_capsule(notes_text, capsule)
        updated = _replace_block(updated, EXCERPT_START, EXCERPT_END, review_excerpt)
        updated = _replace_block(updated, AUDIT_START, AUDIT_END, audit_slices)
        mapping_row = (
            f"| a (H1) | Demo scalar 'a' stored in analysis artifact | {plan.artifact_script_rel} | "
            f"{plan.analysis_rel}:results.a | exact (demo) |"
        )
        updated = _ensure_mapping_row(updated, mapping_row)
        notes_path.write_text(updated, encoding="utf-8")
    except Exception as e:
        print(f"ERROR: failed to update capsule in notes: {notes_path}: {e}", file=sys.stderr)
        return 1

    print("[ok] demo milestone generated")
    print(f"- root: {root}")
    print(f"- tag: {tag}")
    print(f"- notes: {notes_path}")
    print(f"- artifact script: {artifact_script}")
    print(f"- outputs: {plan.manifest_rel}, {plan.analysis_rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
