# Compatibility Matrix

`ecosystem-manifest.json` is the machine-readable compatibility SSOT.
`ecosystem-manifest.schema.json` defines the baseline machine-validation contract.

Rules:
- Any cross-repo version coupling must be declared here.
- Channel changes (`dev/beta/stable`) must be reflected here in the same PR.
- Runtime dependencies should use explicit ranges when available.

Do not rely on verbal compatibility assumptions.
