#!/usr/bin/env python3
"""Generate a Gaia argument-graph package skeleton for one research idea.

Runs ``gaia build init <slug>-gaia`` in the destination directory and then
replaces the generated module ``__init__.py`` with a domain-neutral skeleton:
one top-level ``worth`` claim plus five sub-criterion claim placeholders, each
carrying comment guidance on evidence sources, likelihood grades, and anchor
notes.

After init, the freshly generated package is hardened:

- The nested git repository ``gaia build init`` creates is removed. At this
  point it has zero commits, so nothing is lost, and removing it lets the
  research project's own version control track the package. Pre-existing
  packages are never touched (the scaffold refuses to overwrite), so this
  only ever removes the repository the current invocation just created; a
  package with real git history must be absorbed manually, never deleted
  automatically.
- The generated environment pins are retargeted: gaia's own template still
  writes ``gaia-lang>=0.4.4`` / Python ``3.13``, which is a
  silently-broken environment recipe (observed in the field as
  ``ModuleNotFoundError`` from a stale package venv). The package's
  pyproject is pinned to ``gaia-lang==0.5.0a4`` / Python ``>=3.12``, and
  the init-time venv and lockfile are removed so the next gaia run
  re-syncs the environment from the corrected pins. A template that no
  longer matches the expected strings stops the scaffold loudly — pins
  must never silently pass through wrong.

The destination must live inside an external research project root (for
example ``<project_root>/argument-graphs/``), never inside the tool
repository.

Standard library only; Gaia is invoked as a subprocess.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

GAIA_PIN = "0.5.0a4"
PACKAGE_PYTHON = "3.12"
PIN_INSTALL_HINT = (
    "Install the pinned Gaia toolchain (the pin is deliberate; upgrading is an "
    "explicit, reviewed action):\n"
    "  uv venv .gaia-venv --python 3.12\n"
    f"  uv pip install --python .gaia-venv/bin/python gaia-lang=={GAIA_PIN}\n"
    "then pass --gaia-bin .gaia-venv/bin/gaia or export GAIA_BIN."
)

TEMPLATE = '''"""Argument graph for idea: {slug}

Belief layer only. This graph holds the argument structure and posterior for
one research idea. Admission decisions, literature-anchor verification,
tournament execution, and resource allocation all live outside this package.

Authoring rules (see the idea-posterior skill for the full discipline):

- Anchored facts enter as observe(); soft steps enter as infer() with one of
  the three fixed likelihood grades. No free-hand decimals.
- Likelihood grades (Jeffreys evidence scale; see Kass & Raftery 1995):
    weak        ratio  3   p_e_given_h=0.75, p_e_given_not_h=0.25
    substantial ratio 10   p_e_given_h=0.90, p_e_given_not_h=0.09
    strong      ratio 30   p_e_given_h=0.90, p_e_given_not_h=0.03
  To let evidence LOWER a hypothesis, swap the two numbers of the grade.
  Write the grades as literal numbers at the statement (no variables, no
  helpers): the extraction script refuses statements whose grade or note
  it cannot read as a literal. A raising strong-grade update of
  downstream_reach must list its domains in the rationale before the
  anchor note, "domains: <one>; <two>; <three>" (three or more entries).
- Every observe()/infer() rationale ends with an anchor note:
    "anchor: <artifact reference or resolvable URI>"
  Example anchors, deliberately generic: "anchor: literature_survey_v1
  tensions section", "anchor: trial computation artifact runs/<tag>",
  "anchor: a projected/variational method paper, DOI:...".
  A number whose anchor does not survive review is deleted, and the claim
  falls back to MaxEnt. That fallback is the correct failure mode.
- No claim gets register_prior unless a real external prior exists. A
  register_prior justification follows the same anchor discipline as every
  other number: it ends with "anchor: <artifact reference or URI>", and a
  prior whose anchor fails review is deleted (the claim reverts to MaxEnt).
  No prior means MaxEnt, by design.
- Mutual exclusivity among three or more rival hypotheses must be expanded
  into pairwise exclusive() calls: exclusive() takes exactly two claims in
  gaia-lang {gaia_pin}.
- Utility and cost numbers never enter this graph. Only evidence about
  feasibility beliefs does; budget decisions belong to the portfolio
  scheduler outside.
"""

from gaia.engine.lang import claim, infer, observe  # noqa: F401

__all__: list[str] = []

# --------------------------------------------------------------------------
# Top-level hypothesis. Label must stay `worth`: the extraction script keys
# on it. MaxEnt on purpose -- do not register a prior without a cited source.
# --------------------------------------------------------------------------
worth = claim(
    "The idea merits sustained verification effort.",
    title="worth",
)

# --------------------------------------------------------------------------
# Sub-criterion 1: tension_resolution
# Does the idea resolve an anchored open tension? Conceptual and structural
# tensions carry the same weight as numerical ones (incompatible frameworks,
# an approximation used without justification, a missing mechanism).
# Evidence source: the tensions section of a literature survey artifact.
# --------------------------------------------------------------------------
tension_resolution = claim(
    "The idea resolves an anchored open tension.",
    title="tension_resolution",
)

# --------------------------------------------------------------------------
# Sub-criterion 2: downstream_reach
# Length of the downstream impact chain TIMES breadth of generality (how many
# phenomenon domains the idea unifies or applies to). Breadth is a
# first-class dimension: the strong grade (ratio 30) is reserved for reach
# claims with anchored impact chains in at least three independent phenomenon
# domains, each domain anchored separately. Single-domain reach uses the weak
# or substantial grade.
# Evidence source: idea card claims (support_type + evidence_uris).
# --------------------------------------------------------------------------
downstream_reach = claim(
    "The idea's results feed an anchored chain of downstream problems.",
    title="downstream_reach",
)

# --------------------------------------------------------------------------
# Sub-criterion 3: mechanism_insight
# Quality of the new mechanistic understanding: a testable mechanism
# statement, not a restatement of known results.
# Evidence source: idea card claims and the survey artifact.
# --------------------------------------------------------------------------
mechanism_insight = claim(
    "The idea supplies a new, testable mechanistic understanding.",
    title="mechanism_insight",
)

# --------------------------------------------------------------------------
# Sub-criterion 4: testability_timing
# Can the idea be tested, and is the window open now (data, tools, and
# comparison points available on a relevant horizon)?
# Evidence source: idea card claims.
# --------------------------------------------------------------------------
testability_timing = claim(
    "The idea is testable within an open verification window.",
    title="testability_timing",
)

# --------------------------------------------------------------------------
# Sub-criterion 5: verification_cost
# Evidence that a bounded, decisive first check exists raises feasibility
# belief.
# Only that belief-relevant part enters the graph; the budget decision itself
# stays outside.
# Evidence source: idea_card.minimal_compute_plan.
# --------------------------------------------------------------------------
verification_cost = claim(
    "A bounded, decisive first check of the idea exists.",
    title="verification_cost",
)

# --------------------------------------------------------------------------
# Wire evidence below. Recipe per sub-criterion:
#
#   ev_x = observe(
#       "<anchored fact, stated plainly>",
#       rationale="... anchor: <artifact or URI>",
#   )
#   infer(
#       ev_x,
#       hypothesis=<sub_criterion>,
#       p_e_given_h=0.90, p_e_given_not_h=0.09,   # one of the three grades
#       rationale="<why this grade> anchor: <artifact or URI>",
#   )
#   infer(
#       <sub_criterion>,
#       hypothesis=worth,
#       p_e_given_h=0.75, p_e_given_not_h=0.25,   # grade for worth-relevance
#       rationale="<why this sub-criterion moves worth> anchor: <gate record>",
#   )
#
# Tournament results (pairwise_match_v1 artifacts) also enter as observe():
# unanimous verdicts use the substantial grade, split verdicts the weak
# grade, ties do not update; see the skill's tournament section.
# --------------------------------------------------------------------------
'''


def resolve_gaia_bin(cli_value: str | None) -> str:
    """Resolve the gaia executable: --gaia-bin, then $GAIA_BIN, then PATH."""
    import os

    candidate = cli_value or os.environ.get("GAIA_BIN") or shutil.which("gaia")
    if not candidate:
        sys.stderr.write(
            "error: no `gaia` executable found (checked --gaia-bin, $GAIA_BIN, "
            "PATH).\n" + PIN_INSTALL_HINT + "\n"
        )
        raise SystemExit(2)
    return candidate


def check_gaia_version(gaia_bin: str) -> None:
    """Fail unless `gaia --version` reports the pinned version."""
    try:
        out = subprocess.run(
            [gaia_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        sys.stderr.write(
            f"error: could not run `{gaia_bin} --version`: {exc}\n"
            + PIN_INSTALL_HINT
            + "\n"
        )
        raise SystemExit(2) from exc
    first_line = (out.stdout or out.stderr).strip().splitlines()
    banner = first_line[0] if first_line else ""
    # Exact token match: a banner like "gaia-lang 0.5.0a41" must NOT pass
    # a pin of 0.5.0a4, so substring matching is not acceptable.
    if GAIA_PIN not in banner.replace(",", " ").split():
        sys.stderr.write(
            f"error: gaia version mismatch: expected exactly {GAIA_PIN}, got "
            f"{banner!r}. The pin is explicit; do not silently upgrade or "
            "downgrade.\n" + PIN_INSTALL_HINT + "\n"
        )
        raise SystemExit(2)


def render_template(slug: str) -> str:
    """Render the module skeleton for one idea slug."""
    return TEMPLATE.format(slug=slug, gaia_pin=GAIA_PIN)


def find_module_dir(package_dir: Path) -> Path:
    """Locate the single generated module directory under src/."""
    src = package_dir / "src"
    if not src.is_dir():
        raise FileNotFoundError(f"no src/ directory under {package_dir}")
    candidates = [
        child
        for child in sorted(src.iterdir())
        if child.is_dir() and (child / "__init__.py").is_file()
    ]
    if len(candidates) != 1:
        names = [c.name for c in candidates]
        raise RuntimeError(
            f"expected exactly one module directory under {src}, found "
            f"{names!r}; refusing to guess"
        )
    return candidates[0]


def harden_package(package_dir: Path) -> None:
    """Post-init hardening of the freshly generated package (see docstring).

    Only ever called on a package this invocation just created, so the
    nested repository removed here is the zero-commit one from
    ``gaia build init``. Raises RuntimeError on template drift: if gaia's
    generated pyproject no longer contains the expected pin strings, the
    scaffold must stop rather than leave wrong pins in place.
    """
    nested_git = package_dir / ".git"
    if nested_git.is_dir():
        shutil.rmtree(nested_git)

    pyproject = package_dir / "pyproject.toml"
    if not pyproject.is_file():
        raise RuntimeError(
            f"no pyproject.toml under {package_dir}; `gaia build init` "
            "output does not match the expected package template"
        )
    text = pyproject.read_text(encoding="utf-8")
    replacements = (
        ('"gaia-lang>=0.4.4"', f'"gaia-lang=={GAIA_PIN}"'),
        ('requires-python = ">=3.13"', f'requires-python = ">={PACKAGE_PYTHON}"'),
    )
    for old, new in replacements:
        if old not in text:
            raise RuntimeError(
                f"expected {old!r} in {pyproject}; gaia's package template "
                "changed — update the scaffold's pin patching deliberately "
                "instead of letting unknown pins through"
            )
        text = text.replace(old, new, 1)
    pyproject.write_text(text, encoding="utf-8")
    (package_dir / ".python-version").write_text(
        PACKAGE_PYTHON + "\n", encoding="utf-8"
    )

    # Drop the init-time environment so the next gaia run re-syncs it from
    # the corrected pins (verified: gaia recreates .venv/uv.lock on demand).
    venv = package_dir / ".venv"
    if venv.is_dir():
        shutil.rmtree(venv)
    lock = package_dir / "uv.lock"
    if lock.is_file():
        lock.unlink()


def note_when_project_untracked(dest: Path) -> None:
    """One advisory line when the project is not under version control.

    Never blocks and never initializes anything itself: silently creating
    a repository is not the scaffold's call (and git alongside file-level
    cloud sync is a deliberate user decision).
    """
    try:
        probe = subprocess.run(
            ["git", "-C", str(dest), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return
    if probe.returncode != 0:
        sys.stderr.write(
            "note: the destination is not under version control. A "
            "project-level `git init` gives argument graphs and posterior "
            "artifacts a recoverable history; the scaffold never runs it "
            "for you.\n"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", required=True, help="idea slug, e.g. my-idea")
    parser.add_argument(
        "--dest",
        required=True,
        help="parent directory for the package (external project root, e.g. "
        "<project_root>/argument-graphs/); the package lands in "
        "<dest>/<slug>-gaia/",
    )
    parser.add_argument(
        "--gaia-bin",
        default=None,
        help="path to the gaia executable (default: $GAIA_BIN, then PATH)",
    )
    args = parser.parse_args(argv)

    gaia_bin = resolve_gaia_bin(args.gaia_bin)
    check_gaia_version(gaia_bin)

    dest = Path(args.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    package_name = f"{args.slug}-gaia"
    package_dir = dest / package_name
    if package_dir.exists():
        sys.stderr.write(
            f"error: {package_dir} already exists; refusing to overwrite an "
            "existing argument graph. Append evidence to it instead, or "
            "remove it deliberately.\n"
        )
        return 2

    try:
        init = subprocess.run(
            [gaia_bin, "build", "init", package_name],
            cwd=dest,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired:
        sys.stderr.write(
            f"error: `gaia build init {package_name}` timed out after 300 s. "
            "Package creation normally finishes in seconds; inspect the Gaia "
            "installation and remove any partially created directory before "
            "retrying.\n"
        )
        return 2
    if init.returncode != 0:
        sys.stderr.write(
            f"error: `gaia build init {package_name}` failed "
            f"(exit {init.returncode}).\nstdout:\n{init.stdout}\n"
            f"stderr:\n{init.stderr}\n"
        )
        return 2

    try:
        module_dir = find_module_dir(package_dir)
        harden_package(package_dir)
    except (FileNotFoundError, RuntimeError, OSError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2

    (module_dir / "__init__.py").write_text(
        render_template(args.slug), encoding="utf-8"
    )

    note_when_project_untracked(dest)
    sys.stderr.write(
        f"skeleton written: {module_dir / '__init__.py'}\n"
        "Next: wire observe()/infer() evidence into the skeleton, then run "
        "run_infer_and_extract.py on the package.\n"
    )
    print(package_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
