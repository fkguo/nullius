# Artifact Contract (Generic)

This is a minimal, reusable contract for theory-heavy projects that also produce computation artifacts.

## 1) Run Manifest (manifest.json)

Goal: make every run reproducible and auditable.

Recommended minimal fields:
- `created_at`: ISO timestamp
- `command`: full command line (string)
- `cwd`: working directory
- `git`: `{ "repo": "...", "commit": "...", "dirty": true/false }` (if available)
- `params`: key parameters (JSON object)
- `versions`: `{ "python": "...", "julia": "...", "packages": {...} }` (best effort)
- `outputs`: list/dict of produced files (paths)
- (Optional) `output_hashes`: `{ "path": "sha256:..." }` to detect post-hoc changes
- `logs`: `{ "stdout": "...", "stderr": "..." }` (optional)

## 2) Summary (summary.json / summary.csv)

Goal: record definition-hardened computed statistics used downstream.

Recommended minimal fields:
- `inputs`: pointers to raw artifacts (paths)
- `definitions`: exact operational definitions (strings)
- `windowing`: time/spatial windows, filters
- `stats`: computed numbers (with units if applicable)
- `outputs`: produced plots/tables (paths)

## 3) Analysis (analysis.json)

Goal: record headline quantities and explicit self-consistency checks.

Recommended minimal fields:
- `inputs`: pointers to the summary/manifest files used
- `definitions`: any derived definitions used for headline quantities
- `results`: headline numbers
- `uncertainty`: how error bars were computed/propagated
- `checks`: re-evaluation of key identities (computed vs reported)
- `outputs`: generated plots/tables (paths)
