"""hep-autoresearch: provider-local internal parser/toolkit residue package.

This package remains in the public monorepo for implementation, tests, and
provider-local internals, but it is not the generic product front door.
The residual ``hep-autoresearch-internal`` / ``python -m
hep_autoresearch.orchestrator_cli`` surfaces are maintainer-only residue, not
normal client entrypoints.
"""

__all__ = ["__version__"]

__version__ = "0.0.1"
