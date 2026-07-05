# Compatibility Matrix

`ecosystem-manifest.json` is the machine-readable compatibility SSOT.
`ecosystem-manifest.schema.json` defines the baseline machine-validation contract.

The manifest has two layers:

- **Ecosystem metadata** (`manifest_version`, `updated_at`, `org`, `channels`,
  `platforms`) is hand-maintained here.
- **`components`** is a *generated projection* of the skills-market catalog
  (`packages/skills-market/packages/*.json`), which is the single source of truth
  for each component's `repo` / `type` / `channel` / `version` / `source_path` /
  `depends_on`. Do not hand-edit the `components` block; edit the package files and
  regenerate:

  ```bash
  cd packages/skills-market
  python3 scripts/generate_manifest_components.py --write   # rewrite from catalog
  python3 scripts/generate_manifest_components.py --check    # CI: fail on drift
  ```

  The market validator (`validate_market.py`) also fails closed if `components`
  drifts from the catalog, so a skill edit no longer needs a second hand-sync here.

Rules:
- Any cross-repo version coupling must be declared in the source package file.
- Channel changes (`dev/beta/stable`) live in the package file and flow in via the
  generator in the same PR.
- Runtime dependencies should use explicit ranges when available.

Do not rely on verbal compatibility assumptions.
