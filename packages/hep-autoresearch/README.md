# HEP Autoresearch

HEP-oriented provider package and provider-local internal parser/toolkit residue inside the Autoresearch Lab monorepo.

This package is no longer the generic product front door. Public entrypoints live at the repo root:

- generic lifecycle and bounded computation: `autoresearch`
- high-level literature planning: `autoresearch workflow-plan`
- current mature HEP MCP surface: `@autoresearch/hep-mcp`

This directory remains in the public monorepo because it still contains implementation, tests, and package metadata, but maintainer-only legacy docs, workflow notes, and examples are kept local rather than published as part of the public GitHub surface.

For current user-facing guidance, start from:

- [root README](../../README.md)
- [Quickstart](../../docs/QUICKSTART.md)
- [Testing Guide](../../docs/TESTING_GUIDE.md)

For package consumers, the only stable guidance here is:

- use `autoresearch` as the front door
- do not treat `hep-autoresearch` / `hepar` as the product identity
- do not expect an installable `hepar` / `hep-autoresearch` public shell
- treat `hep-autoresearch-internal` / `python -m hep_autoresearch.orchestrator_cli` as maintainer-only internal residue rather than a normal client entrypoint
- expect the remaining retired provider-local Python internals to continue shrinking rather than expanding
