#!/usr/bin/env python3
"""Run exact inference on a Gaia package and extract the worth posterior.

Pipeline: ``gaia build compile`` -> ``gaia build check`` -> ``gaia run infer``,
then parse the produced artifacts:

- ``.gaia/beliefs.json``: the entry whose ``label`` equals the worth label
  (default ``worth``) supplies the posterior value.
- ``.gaia/ir.json``: the number of observation supports — entries in
  ``knowledges[*].metadata.supported_by[*]`` with ``pattern == "observation"``
  — supplies ``evidence_count`` (one count per observe() statement).
  ``ir_hash`` is embedded into ``gaia_package_ref`` so the reference pins the
  exact compiled graph.

Output (stdout, JSON): {"value": float, "evidence_count": int,
"gaia_package_ref": "project://<project-relative path>#<ir_hash>"}. The
reference is machine-portable on purpose: research projects are synced
across machines, so it names the package RELATIVE to the enclosing project
root (the nearest ancestor directory containing ``.nullius/``, or an
explicit ``--project-root``) instead of embedding this machine's absolute
path. Path segments are percent-encoded; the ``#sha256:`` fragment is the
package's own compiled-graph hash. The idea-engine contract types the field
as format "uri", which this form satisfies. Diagnostics go to stderr.
Standard library only; Gaia is invoked as a subprocess.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

GAIA_PIN = "0.5.0a4"

# The three likelihood grades (Jeffreys scale) and their reversals. Literal
# float comparison is exact: 0.90 parses to the same float as 0.9.
GRADE_PAIRS = {
    (0.75, 0.25), (0.9, 0.09), (0.9, 0.03),
    (0.25, 0.75), (0.09, 0.9), (0.03, 0.9),
}
PIN_INSTALL_HINT = (
    "Install the pinned Gaia toolchain (the pin is deliberate; upgrading is an "
    "explicit, reviewed action):\n"
    "  uv venv .gaia-venv --python 3.12\n"
    f"  uv pip install --python .gaia-venv/bin/python gaia-lang=={GAIA_PIN}\n"
    "then pass --gaia-bin .gaia-venv/bin/gaia or export GAIA_BIN."
)


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


# A rationale/justification must END with an anchor note: "anchor:" followed
# by a non-empty reference, as the last thing in the string.
TRAILING_ANCHOR_RE = re.compile(r"anchor:\s*\S[^\n]*$")

# A raising strong-grade downstream_reach update must carry a domains
# clause listing >= 3 independently anchored phenomenon domains, separated
# by ";" or "|", e.g. "domains: first domain; second domain; third domain".
DOMAINS_CLAUSE_RE = re.compile(r"domains:\s*([^\n]+)")


def has_domains_clause(text: str) -> bool:
    """True when the text carries a domains clause with >= 3 entries.

    The domains clause must sit BEFORE the trailing anchor note, as SKILL.md
    requires. Everything from the first "anchor:" onward is the anchor note
    (a reference, which may itself contain the word "domains"), so it is cut
    away before the clause is located. Consequences: "domains: one; two;
    anchor: ref" counts two entries, not three; and "anchor: ref; domains:
    one; two; three" carries NO valid clause at all, because its "domains:"
    lives inside the anchor note, not before it.
    """
    before_anchor = re.split(r"anchor:", text, maxsplit=1)[0]
    match = DOMAINS_CLAUSE_RE.search(before_anchor)
    if not match:
        return False
    entries = [
        entry.strip()
        for entry in re.split(r"[;|]", match.group(1))
        if entry.strip()
    ]
    return len(entries) >= 3


def scan_discipline(source: str) -> tuple[list[str], list[str]]:
    """Static scan for the grade and anchor discipline.

    Returns (violations, review_flags). The rule is: a statement passes only
    when the scan can PROVE it follows the discipline. Literal probability
    pairs must sit in the three grades; literal rationales/justifications
    must end (last line) with an "anchor: <reference>" note; a raising
    strong-grade update of `downstream_reach` must list three or more
    domains in a "domains:" clause. Anything the scan cannot prove —
    non-literal probabilities or notes, aliased statement names it can
    still resolve but whose arguments it cannot read — is a violation, not
    a pass: the discipline itself requires literal grades and literal
    anchors, so an unprovable statement is a non-compliant statement.
    Review flags carry only what remains for the reviewer's judgment on
    substance (anchors' truth, grade appropriateness, domain independence).

    Statement names are resolved through import aliases
    (`from gaia.engine.lang import infer as i`, `import gaia.engine.lang
    as g; g.infer(...)`), and re-binding a statement outside a direct call
    is itself a violation whether the reference is a bare name (`i = infer`)
    or a module attribute (`i = lang.infer`). A `downstream_reach` update is
    identified by the claim's `title="downstream_reach"`, not merely by the
    variable name, so renaming the variable does not skip the domain gate.
    Wrapper functions that forward arguments are caught by the literality
    rule: the forwarded arguments inside the wrapper are non-literal.

    The scan guards against ordinary authoring and casual workarounds,
    including the near variants above; it is a review aid, not a security
    boundary. Deliberately obfuscated authoring — exec/eval, computed or
    dynamically built attribute names, a wrapper re-bound through a non-Load
    context, runtime dispatch — can defeat any static reader and is out of
    the scan's guarantee by design; those cases belong to the human reviewer
    and version-controlled history. See "Scan boundary" in SKILL.md.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"module does not parse: {exc}"], []
    violations: list[str] = []
    review_flags: list[str] = []

    # Resolve import aliases for the scanned statement names. Attribute
    # calls (`anything.observe(...)`) are matched by name alone — a
    # deliberately conservative over-match: false positives are possible,
    # missed statements are not.
    scanned = {"observe", "infer", "register_prior"}
    name_aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and (
            node.module == "gaia.engine.lang"
            or node.module.startswith("gaia.")
        ):
            for alias in node.names:
                if alias.name in scanned:
                    name_aliases[alias.asname or alias.name] = alias.name

    def resolve_statement(func: ast.expr) -> str | None:
        if isinstance(func, ast.Name):
            return name_aliases.get(func.id) or (
                func.id if func.id in scanned else None
            )
        if isinstance(func, ast.Attribute) and func.attr in scanned:
            return func.attr
        return None

    # Map each plain variable that a claim() call binds to the title it
    # declares, so a downstream_reach identity can be recognised by its
    # claim title (`reach = claim(..., title="downstream_reach")`) and not
    # only by the variable name. Reassignment makes the identity ambiguous;
    # record that so the reach check stays conservative.
    claim_title_by_var: dict[str, str] = {}
    reassigned_vars: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if target.id in claim_title_by_var or target.id in reassigned_vars:
            reassigned_vars.add(target.id)
            claim_title_by_var.pop(target.id, None)
            continue
        value = node.value
        if (
            isinstance(value, ast.Call)
            and (
                (isinstance(value.func, ast.Name) and value.func.id == "claim")
                or (
                    isinstance(value.func, ast.Attribute)
                    and value.func.attr == "claim"
                )
            )
        ):
            title = next(
                (
                    kw.value.value
                    for kw in value.keywords
                    if kw.arg == "title"
                    and isinstance(kw.value, ast.Constant)
                    and isinstance(kw.value.value, str)
                ),
                None,
            )
            if title is not None:
                claim_title_by_var[target.id] = title

    # Any reference to a scanned statement OUTSIDE a direct call —
    # assignment aliasing (`i = infer`, `i = lang.infer`), passing it as an
    # argument, storing it in a container — defeats the line-by-line audit
    # and is a violation in itself. Both the bare-name route (`ast.Name`
    # resolving to a scanned statement) and the module-attribute route
    # (`ast.Attribute` such as `lang.infer`) are closed here: a scanned
    # statement referenced anywhere that is not the function position of a
    # call is flagged. Legitimate calls (`lang.infer(...)`) put that
    # attribute in the call's function position, so they are exempt.
    call_func_nodes = {
        id(call.func)
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
    }
    scanned_or_aliased = scanned | set(name_aliases)
    for node in ast.walk(tree):
        if id(node) in call_func_nodes:
            continue
        flagged_name: str | None = None
        if (
            isinstance(node, ast.Name)
            and isinstance(node.ctx, ast.Load)
            and node.id in scanned_or_aliased
        ):
            flagged_name = node.id
        elif (
            isinstance(node, ast.Attribute)
            and isinstance(node.ctx, ast.Load)
            and node.attr in scanned
        ):
            flagged_name = node.attr
        if flagged_name is not None:
            violations.append(
                f"line {node.lineno}: {flagged_name} is referenced without "
                "being called (aliasing or indirection); call "
                "observe/infer/register_prior directly so every statement "
                "is auditable in place"
            )

    def is_downstream_reach(hyp: ast.Name) -> bool:
        """True when the hypothesis variable IS the downstream_reach claim.

        Identity is the claim's title, not the variable spelling: a claim
        bound as `reach = claim(..., title="downstream_reach")` is the reach
        claim even under a different variable name. The variable name
        `downstream_reach` is also honoured directly, covering the ordinary
        case where the variable and the title coincide.
        """
        return (
            hyp.id == "downstream_reach"
            or claim_title_by_var.get(hyp.id) == "downstream_reach"
        )

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = resolve_statement(node.func)
        if name is None:
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        if name == "infer":
            h = kwargs.get("p_e_given_h")
            nh = kwargs.get("p_e_given_not_h")
            if isinstance(h, ast.Constant) and isinstance(nh, ast.Constant):
                pair = (h.value, nh.value)
                if pair not in GRADE_PAIRS:
                    violations.append(
                        f"line {node.lineno}: infer uses off-grade pair "
                        f"{pair}; allowed grades are 3 (0.75/0.25), "
                        "10 (0.90/0.09), 30 (0.90/0.03), or their reversals"
                    )
                elif pair == (0.9, 0.03):
                    # Raising strong-grade update: if it targets
                    # downstream_reach it must list >= 3 domains; and its
                    # hypothesis must be a plain claim variable so the
                    # target is auditable at all.
                    hyp = kwargs.get("hypothesis")
                    note = kwargs.get("rationale")
                    if not isinstance(hyp, ast.Name):
                        violations.append(
                            f"line {node.lineno}: a raising strong-grade "
                            "infer must name its hypothesis as a plain "
                            "claim variable; anything less is not "
                            "auditable at the strongest grade"
                        )
                    elif is_downstream_reach(hyp):
                        note_text = (
                            note.value
                            if isinstance(note, ast.Constant)
                            and isinstance(note.value, str)
                            else ""
                        )
                        if not has_domains_clause(note_text):
                            violations.append(
                                f"line {node.lineno}: strong-grade "
                                "downstream_reach update without a "
                                "'domains: <one>; <two>; <three>' clause "
                                "naming at least three independently "
                                "anchored phenomenon domains"
                            )
            else:
                violations.append(
                    f"line {node.lineno}: infer probabilities are not "
                    "literal numbers; the discipline requires one of the "
                    "three grades written as literals"
                )
        if name == "register_prior":
            val = kwargs.get("value")
            if val is None and len(node.args) >= 2:
                val = node.args[1]
            if not (
                isinstance(val, ast.Constant)
                and isinstance(val.value, (int, float))
                and not isinstance(val.value, bool)
                and 0.0 <= val.value <= 1.0
            ):
                violations.append(
                    f"line {node.lineno}: register_prior value must be a "
                    "literal probability in [0, 1]; indirection defeats "
                    "the audit"
                )
        note_name = "justification" if name == "register_prior" else "rationale"
        note = kwargs.get(note_name)
        if note is None:
            violations.append(f"line {node.lineno}: {name} has no {note_name}")
        elif isinstance(note, ast.Constant) and isinstance(note.value, str):
            if not TRAILING_ANCHOR_RE.search(note.value.rstrip()):
                violations.append(
                    f"line {node.lineno}: {name} {note_name} does not end "
                    "with an 'anchor: <reference>' note"
                )
        else:
            violations.append(
                f"line {node.lineno}: {name} {note_name} is not a literal "
                "string; the discipline requires a literal note ending "
                "with an anchor"
            )
        if name == "infer":
            hyp = kwargs.get("hypothesis")
            h = kwargs.get("p_e_given_h")
            nh = kwargs.get("p_e_given_not_h")
            is_strong_raise = (
                isinstance(h, ast.Constant)
                and isinstance(nh, ast.Constant)
                and (h.value, nh.value) == (0.9, 0.03)
            )
            if (
                hyp is not None
                and not isinstance(hyp, ast.Name)
                and not is_strong_raise  # strong raise already a violation
            ):
                review_flags.append(
                    f"line {node.lineno}: infer hypothesis is not a plain "
                    "claim variable; reviewer should confirm the update "
                    "target"
                )
    return violations, review_flags


def scan_package_discipline(package_dir: Path) -> tuple[list[str], list[str]]:
    """Run the static discipline scan over every module under src/."""
    violations: list[str] = []
    review_flags: list[str] = []
    src = package_dir / "src"
    if not src.is_dir():
        return violations, review_flags
    for module in sorted(src.rglob("*.py")):
        got_violations, got_flags = scan_discipline(
            module.read_text(encoding="utf-8")
        )
        rel = module.relative_to(package_dir)
        violations.extend(f"{rel}: {v}" for v in got_violations)
        review_flags.extend(f"{rel}: {f}" for f in got_flags)
    return violations, review_flags


def run_stage(gaia_bin: str, stage: list[str], package_dir: Path) -> None:
    """Run one gaia CLI stage; on failure print a readable diagnosis."""
    cmd = [gaia_bin, *stage, str(package_dir)]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600, check=False
        )
    except subprocess.TimeoutExpired as exc:
        sys.stderr.write(
            f"error: `{' '.join(cmd)}` timed out after 600 s. A healthy "
            "package of this kind finishes in seconds; inspect the package "
            "or the Gaia installation before retrying.\n"
        )
        raise SystemExit(2) from exc
    if result.returncode != 0:
        sys.stderr.write(
            f"error: `{' '.join(cmd)}` failed (exit {result.returncode}).\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}\n"
            "Fix the graph before extracting a posterior; a posterior from a "
            "package that fails compile or check is not a result.\n"
        )
        raise SystemExit(2)
    sys.stderr.write(f"ok: {' '.join(stage)}\n")


def render_optional(
    gaia_bin: str,
    stage: list[str],
    package_dir: Path,
    note: str,
    timeout: int = 120,
) -> bool:
    """Run one presentation-render stage; never fatal. Returns True on success.

    Rendering is a viewability nicety, not part of the posterior: a failure
    here (a missing optional dependency such as Graphviz, a renderer defect, a
    hang) is reported to stderr and skipped, never a reason to withhold a sound
    posterior. Contrast `run_stage`, which is fatal because compile/check/infer
    gate the result. The timeout is short by design — a healthy render finishes
    in seconds, and an optional graph must not hold a sound posterior hostage.
    """
    cmd = [gaia_bin, *stage, str(package_dir)]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        sys.stderr.write(f"render skipped ({note}): {exc}\n")
        return False
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        tail = detail[-1] if detail else f"exit {result.returncode}"
        sys.stderr.write(f"render skipped ({note}): {tail}\n")
        return False
    sys.stderr.write(f"ok: render {note}\n")
    return True


def render_to_file(
    gaia_bin: str,
    fmt: str,
    final_path: Path,
    package_dir: Path,
    note: str,
    timeout: int,
) -> None:
    """Render a starmap to `final_path` atomically.

    A stale or half-written render must never survive: the report may link the
    file as "the graph the posterior came from," so a failed render must leave
    NO file rather than an old one. Remove any prior output, render to a temp
    sibling, and move it onto the final path only on success.
    """
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    for stale in (final_path, tmp_path):
        try:
            stale.unlink()
        except FileNotFoundError:
            pass
    ok = render_optional(
        gaia_bin,
        ["inspect", "starmap", "--format", fmt, "--out", str(tmp_path)],
        package_dir,
        note,
        timeout,
    )
    if ok and tmp_path.exists():
        tmp_path.replace(final_path)
    else:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def render_graph(gaia_bin: str, package_dir: Path, timeout: int = 120) -> None:
    """Emit human-viewable renderings of the argument graph after inference.

    Three best-effort outputs, in decreasing portability:
    - `starmap.html`: a single-file interactive graph (no external dependency)
      — the primary viewable artifact; open it in a browser.
    - `starmap.svg`: a paper-ready figure — additionally needs Graphviz on PATH.
    - `docs/`: the detailed-reasoning render enriched with the fresh beliefs.

    None gate the posterior; each prints where it wrote or why it was skipped.
    The two starmap files are written atomically so a failed render never leaves
    a stale graph the report could mislink.
    """
    render_to_file(
        gaia_bin, "html", package_dir / "starmap.html", package_dir,
        "interactive graph -> starmap.html", timeout,
    )
    render_to_file(
        gaia_bin, "svg", package_dir / "starmap.svg", package_dir,
        "figure -> starmap.svg (needs graphviz)", timeout,
    )
    render_optional(
        gaia_bin,
        ["run", "render", "--target", "docs"],
        package_dir,
        "detailed reasoning -> docs/",
        timeout,
    )


def extract_worth_belief(beliefs: dict, worth_label: str) -> float:
    """Pick the belief whose label equals worth_label; list labels on miss."""
    entries = beliefs.get("beliefs", [])
    matches = [e for e in entries if e.get("label") == worth_label]
    if len(matches) != 1:
        labels = sorted({e.get("label") for e in entries if e.get("label")})
        raise ValueError(
            f"expected exactly one belief labelled {worth_label!r}, found "
            f"{len(matches)}. Labels present: {labels!r}. The top-level claim "
            f"must be bound to a module variable named {worth_label!r}."
        )
    value = matches[0].get("belief")
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 0.0 <= float(value) <= 1.0
    ):
        raise ValueError(f"belief for {worth_label!r} is not in [0, 1]: {value!r}")
    return float(value)


def count_observations(ir: dict) -> int:
    """Count observation supports: one per observe() statement in the graph."""
    count = 0
    for knowledge in ir.get("knowledges", []):
        metadata = knowledge.get("metadata") or {}
        for support in metadata.get("supported_by", []) or []:
            if support.get("pattern") == "observation":
                count += 1
    return count


def find_project_root(start: Path) -> Path | None:
    """Nearest ancestor of ``start`` (inclusive) containing ``.nullius/``.

    ``.nullius/`` is the project-root marker written by ``nullius init``;
    it is what makes a ``project://`` reference resolvable on any machine
    the project is synced to.
    """
    for candidate in (start, *start.parents):
        if (candidate / ".nullius").is_dir():
            return candidate
    return None


def package_ref(package_dir: Path, project_root: Path, ir_hash: str) -> str:
    """Build the machine-portable ``project://`` package reference.

    The path is RELATIVE to the project root so the reference survives the
    project being synced to another machine (an absolute path would not);
    the ``#sha256:`` fragment pins the exact compiled graph regardless of
    location. Segments are percent-encoded so the result is a valid URI
    even for paths with spaces (the engine validates format "uri").
    """
    package_resolved = package_dir.resolve()
    root_resolved = project_root.resolve()
    try:
        rel = package_resolved.relative_to(root_resolved)
    except ValueError:
        raise ValueError(
            f"package {package_resolved} is not under the project root "
            f"{root_resolved}; a machine-portable reference requires the "
            "package inside the project (move it, or pass the correct "
            "--project-root)"
        ) from None
    if rel == Path("."):
        raise ValueError(
            "the package directory IS the project root; the package must "
            "be a subdirectory of the project (e.g. argument-graphs/<slug>-gaia)"
        )
    return f"project://{quote(rel.as_posix(), safe='/')}#{ir_hash}"


def extract_posterior(
    package_dir: Path, worth_label: str, project_root: Path
) -> dict:
    """Parse .gaia artifacts into the posterior payload."""
    gaia_dir = package_dir / ".gaia"
    beliefs_path = gaia_dir / "beliefs.json"
    ir_path = gaia_dir / "ir.json"
    for path in (beliefs_path, ir_path):
        if not path.is_file():
            raise FileNotFoundError(
                f"missing {path}; run the inference stages first"
            )
    beliefs = json.loads(beliefs_path.read_text(encoding="utf-8"))
    ir = json.loads(ir_path.read_text(encoding="utf-8"))

    value = extract_worth_belief(beliefs, worth_label)
    evidence_count = count_observations(ir)
    ir_hash = ir.get("ir_hash", "")
    if not ir_hash:
        raise ValueError(f"no ir_hash in {ir_path}; cannot pin the graph state")
    return {
        "value": value,
        "evidence_count": evidence_count,
        "gaia_package_ref": package_ref(package_dir, project_root, ir_hash),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package", required=True, help="path to the Gaia package directory"
    )
    parser.add_argument(
        "--worth-label",
        default="worth",
        help="module variable name of the top-level claim (default: worth)",
    )
    parser.add_argument(
        "--gaia-bin",
        default=None,
        help="path to the gaia executable (default: $GAIA_BIN, then PATH)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="optional file to write the posterior JSON to (stdout always)",
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help="project root the package reference is made relative to "
        "(default: the nearest ancestor of the package containing "
        ".nullius/). The reference must be machine-portable — research "
        "projects sync across machines — so there is no absolute-path "
        "fallback",
    )
    parser.add_argument(
        "--allow-discipline-warnings",
        action="store_true",
        help="downgrade statically certain discipline violations "
        "(off-grade pairs, missing trailing anchor notes) from a refusal "
        "to warnings; an explicit, logged exception for deliberate "
        "exploration only",
    )
    parser.add_argument(
        "--no-render",
        action="store_true",
        help="skip the post-inference graph rendering (starmap HTML/SVG and "
        "the detailed-reasoning docs); the posterior is unaffected",
    )
    parser.add_argument(
        "--render-timeout",
        type=int,
        default=120,
        help="per-render timeout in seconds (default: 120); a healthy render "
        "finishes in seconds and an optional graph must not delay the posterior",
    )
    args = parser.parse_args(argv)

    package_dir = Path(args.package).resolve()
    if not package_dir.is_dir():
        sys.stderr.write(f"error: package directory not found: {package_dir}\n")
        return 2

    if args.project_root:
        project_root = Path(args.project_root).resolve()
        if not project_root.is_dir():
            sys.stderr.write(
                f"error: project root not found: {project_root}\n"
            )
            return 2
    else:
        project_root = find_project_root(package_dir)
        if project_root is None:
            sys.stderr.write(
                "error: no project root found: no ancestor of "
                f"{package_dir} contains .nullius/. The package reference "
                "is project-relative so it stays valid when the project "
                "syncs to another machine; put the package inside a "
                "nullius project, or pass --project-root explicitly.\n"
            )
            return 2

    gaia_bin = resolve_gaia_bin(args.gaia_bin)
    check_gaia_version(gaia_bin)

    violations, review_flags = scan_package_discipline(package_dir)
    for finding in review_flags:
        sys.stderr.write(f"discipline review flag: {finding}\n")
    for finding in violations:
        sys.stderr.write(f"discipline violation: {finding}\n")
    if violations and not args.allow_discipline_warnings:
        sys.stderr.write(
            f"{len(violations)} discipline violation(s): fix the grades "
            "and anchor notes, or re-run with "
            "--allow-discipline-warnings for a deliberate, logged "
            "exception. Refusing to extract a posterior from a graph "
            "that breaks the discipline.\n"
        )
        return 2
    if violations:
        sys.stderr.write(
            f"{len(violations)} discipline violation(s) allowed by "
            "--allow-discipline-warnings; the posterior will be marked "
            "exploration-only and cannot be written to the idea store.\n"
        )

    run_stage(gaia_bin, ["build", "compile"], package_dir)
    run_stage(gaia_bin, ["build", "check"], package_dir)
    run_stage(gaia_bin, ["run", "infer"], package_dir)

    if not args.no_render:
        render_graph(gaia_bin, package_dir, args.render_timeout)

    try:
        posterior = extract_posterior(
            package_dir, args.worth_label, project_root
        )
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2

    if violations:
        # A posterior extracted over allowed violations is exploration
        # material: mark the reference so the writeback contract refuses it.
        posterior["gaia_package_ref"] = (
            "exploration-only:" + posterior["gaia_package_ref"]
        )

    payload = json.dumps(posterior, indent=2, sort_keys=True)
    print(payload)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
