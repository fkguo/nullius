# Ecosystem bundle (v0)

Goal: ship a **core container bundle** for the `hep-autoresearch` ecosystem that is:
- version-pinned (component commits recorded),
- offline-friendly for inspection (sources are bundled; installs may still require package managers),
- safe by default (no secrets embedded; bootstrap fails on secrets-like files),
- auditable (evidence artifacts under `artifacts/runs/<tag>/...`).

This is a **release artifact** concept (not a research run bundle). It packages:
- this repo (`hep-autoresearch`)
- `hep-research-mcp` (package snapshot + lockfiles)
- a curated set of general-purpose Codex skills

## What is included

Core bundle includes:
- `hep-autoresearch` source snapshot (allowlisted tracked files)
- `hep-research-mcp` snapshot:
  - `packages/hep-research-mcp/` (tracked files)
  - root lockfiles: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`
- skills snapshot (tracked files only), default set:
  - `review-swarm`
  - `claude-cli-runner`
  - `gemini-cli-runner`
  - `hepar`
  - `research-team`
  - `research-writer`
  - `referee-review`
  - `md-toc-latex-unescape`

All pins live in `bundle_manifest.json` inside the bundle zip.

## What is excluded (add-ons)

We intentionally keep some skills out of the core bundle v0:
- large/heavy external deps (e.g. `hep-calc`)
- specialized experiment scaffolds (e.g. `deep-learning-lab`)
- deprecated/removed skills (e.g. `research-team-audit`)
- repo-maintenance utilities (e.g. `hep-mcp-*`)

These can be shipped as separate add-ons later.

## How to build (maintainers)

Build the bundle into evidence artifacts:

```bash
python3 scripts/run_ecosystem_bundle.py --tag Mxx-t37-r1
```

Outputs:
- `artifacts/runs/<tag>/ecosystem_bundle/core_bundle.zip`
- `artifacts/runs/<tag>/ecosystem_bundle/bundle_manifest.json`
- `artifacts/runs/<tag>/ecosystem_bundle/{manifest,summary,analysis}.json`

## How to bootstrap (users)

Extract the bundle zip and run the bootstrap check:

```bash
python3 bootstrap.py --check
```

This performs a **secrets-like file scan** and fails-fast if anything suspicious is present.

## Install on a new machine (alpha testers)

Prereqs:
- Python 3.11+ (with `venv`)
- Node.js (to run the bundled `hep-research-mcp` `dist/` entrypoint)
- (Optional) Codex CLI (if you want to use the bundled skills)

Steps:

1) Extract + bootstrap (from the bundle root):

```bash
unzip core_bundle.zip
cd hep-autoresearch-ecosystem-bundle-v0
python3 bootstrap.py --check
```

2) Set env vars pointing to bundled components (from the bundle root):

```bash
export HEP_MCP_PACKAGE_DIR="$PWD/components/hep-research-mcp/packages/hep-research-mcp"
# Optional: make the bundled skills discoverable via $CODEX_HOME/skills.
export CODEX_HOME="$PWD/components"
```

3) Install `hep-autoresearch` (editable) and run a smoke check:

```bash
cd components/hep-autoresearch
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -U pip
python3 -m pip install -e .
python3 -c "import hep_autoresearch; print('import ok')"
# Optional (stronger smoke): rebuild the ecosystem bundle from the extracted bundle sources.
python3 scripts/run_ecosystem_bundle.py --tag ALPHA-smoke-bundle-r1
```

Notes:
- Provide API keys at runtime via environment variables. Do **not** drop secrets into the bundle directory tree (bootstrap will fail-fast).
- Most scripts in this repo assume `cwd` is the repo root (`components/hep-autoresearch` in the bundle).
- `scripts/run_evals.py` is designed for the full dev repo; the core bundle v0 intentionally does not ship `knowledge_base/`, `references/`, or historical `artifacts/runs/*`, so the full eval suite will fail in a minimal bundle checkout.

## Secrets policy (hard requirement)

- Secrets must **never** be embedded in the bundle.
- Bootstrap refuses to proceed if it detects secrets-like files (private keys, API key assignments, suspicious filenames/extensions).
- Provide secrets at runtime only (environment variables / mounted volumes), and keep them out of git and out of release bundles.

## Notes on licensing

This repo does not currently vendor license texts for every external component.
The bundle manifest records component remotes/commits to support downstream license verification.
