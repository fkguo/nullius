#!/usr/bin/env python3
"""Render-then-verify QA for data/results figures (matplotlib).

Geometric check: no visible text may overlap another text or an axes spine
(a tick label sitting on its own spine is exempt), and every text must lie
inside the figure canvas. Optionally writes one cropped PNG per panel so an
agent or human can run the perceptual pass on each panel in isolation.

CLI (checks every figure the plotting script leaves open; run it from the
directory the script expects as its working directory, and do not close
figures inside the script before QA):

    python3 figure_qa.py --script plot_figure.py [--crops-dir DIR] [--json]

Exit codes: 0 clean, 1 findings, 2 usage error (missing script, no figures).

Library use inside a live session:

    from figure_qa import apply_figure_style, check_figure, panel_crops
    apply_figure_style()          # role-mapped sizes + CVD-safe palette
    ...build the figure...
    findings = check_figure(fig)             # [] when clean
    paths = panel_crops(fig, "crops_dir")    # one PNG per axes, returns paths

Only matplotlib is required. The default palette is Okabe-Ito with the
vermillion slot held out of the series cycle as the reserved alarm hue.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib
from matplotlib import text as mtext
from matplotlib.transforms import Bbox

# Okabe-Ito colour-vision-deficiency-safe palette.
OKABE_ITO = (
    "#0072B2",  # blue
    "#E69F00",  # orange
    "#009E73",  # bluish green
    "#CC79A7",  # reddish purple
    "#56B4E9",  # sky blue
    "#F0E442",  # yellow
    "#000000",  # black
    "#D55E00",  # vermillion (ALARM_HUE)
)
ALARM_HUE = "#D55E00"

# Sub-pixel slack so touching-but-not-overlapping boxes are not findings.
_EPS_PX = 0.25
_SNIPPET_LEN = 40


def apply_figure_style(sizes=(9, 8, 7), palette=None):
    """Set a role-mapped font ladder and a CVD-safe series palette.

    sizes = (base, mid, small): base for titles / axis labels / series
    identity, mid for legend and annotation text, small for tick labels.
    The default palette excludes ALARM_HUE so the alarm colour stays
    reserved for error/anomaly marks. Returns the applied rcParams dict.
    """
    from cycler import cycler

    base, mid, small = sizes
    if palette is None:
        palette = [c for c in OKABE_ITO if c != ALARM_HUE]
    params = {
        "font.size": base,
        "figure.titlesize": base,
        "axes.titlesize": base,
        "axes.labelsize": base,
        "legend.fontsize": mid,
        "xtick.labelsize": small,
        "ytick.labelsize": small,
        "xtick.direction": "out",
        "ytick.direction": "out",
        "legend.frameon": False,
        "savefig.dpi": 300,
        "axes.prop_cycle": cycler(color=list(palette)),
    }
    matplotlib.rcParams.update(params)
    return params


def _renderer(fig):
    fig.canvas.draw()
    get = getattr(fig.canvas, "get_renderer", None)
    if get is not None:
        return get()
    return fig.canvas.renderer


def _extent(artist, renderer):
    try:
        return artist.get_window_extent(renderer=renderer)
    except TypeError:
        return artist.get_window_extent()


def _shrunk(bbox):
    x0, y0, x1, y1 = bbox.extents
    if x1 - x0 <= 2 * _EPS_PX or y1 - y0 <= 2 * _EPS_PX:
        return bbox
    return Bbox.from_extents(x0 + _EPS_PX, y0 + _EPS_PX, x1 - _EPS_PX, y1 - _EPS_PX)


def _snippet(artist):
    raw = artist.get_text().strip().replace("\n", " ")
    if len(raw) > _SNIPPET_LEN:
        raw = raw[: _SNIPPET_LEN - 3] + "..."
    return raw


def _undrawn_tick_labels(fig):
    """Tick label Texts whose tick location lies outside the view interval.

    Locators may propose ticks past the axis limits; those labels exist in
    the artist tree but are skipped at draw time, so they are not findings.
    """
    undrawn = set()
    for ax in fig.axes:
        for axis in (getattr(ax, "xaxis", None), getattr(ax, "yaxis", None)):
            if axis is None:
                continue
            lo, hi = sorted(axis.get_view_interval())
            for tick in list(axis.get_major_ticks()) + list(axis.get_minor_ticks()):
                if lo <= tick.get_loc() <= hi:
                    continue
                undrawn.add(tick.label1)
                undrawn.add(tick.label2)
    return undrawn


def check_figure(fig):
    """Return a list of geometric findings for one matplotlib Figure.

    Finding kinds: text-overlaps-text, text-overlaps-spine,
    text-out-of-bounds. An empty list means the geometric check passed;
    the perceptual pass over panel crops is still required.
    """
    renderer = _renderer(fig)
    findings = []
    undrawn = _undrawn_tick_labels(fig)

    texts = []
    for t in fig.findobj(mtext.Text):
        if t in undrawn or not t.get_visible() or not t.get_text().strip():
            continue
        try:
            bb = _extent(t, renderer)
        except Exception:
            continue
        if bb.width <= 0 or bb.height <= 0:
            continue
        texts.append((t, bb))

    spines = [
        (s, _extent(s, renderer))
        for ax in fig.axes
        for s in ax.spines.values()
        if s.get_visible()
    ]
    own_ticklabels = {
        ax: set(ax.get_xticklabels(which="both") + ax.get_yticklabels(which="both"))
        for ax in fig.axes
    }

    for i, (a, ba) in enumerate(texts):
        for b, bb in texts[i + 1 :]:
            if _shrunk(ba).overlaps(_shrunk(bb)):
                findings.append(
                    {
                        "kind": "text-overlaps-text",
                        "message": f"text {_snippet(a)!r} overlaps text {_snippet(b)!r}",
                    }
                )

    for t, bt in texts:
        for s, bs in spines:
            if t in own_ticklabels.get(s.axes, ()):  # own-spine tick labels exempt
                continue
            if _shrunk(bt).overlaps(_shrunk(bs)):
                findings.append(
                    {
                        "kind": "text-overlaps-spine",
                        "message": f"text {_snippet(t)!r} overlaps an axes spine",
                    }
                )
                break

    canvas_box = Bbox.from_extents(
        fig.bbox.x0 - _EPS_PX, fig.bbox.y0 - _EPS_PX, fig.bbox.x1 + _EPS_PX, fig.bbox.y1 + _EPS_PX
    )
    for t, bt in texts:
        if not canvas_box.contains(bt.x0, bt.y0) or not canvas_box.contains(bt.x1, bt.y1):
            findings.append(
                {
                    "kind": "text-out-of-bounds",
                    "message": f"text {_snippet(t)!r} extends outside the figure canvas",
                }
            )

    return findings


def panel_crops(fig, out_dir, dpi=200, pad_inches=0.06, stem="panel"):
    """Save one cropped PNG per axes of `fig` into `out_dir`.

    Returns the list of written paths. Feed each crop to the perceptual
    check: legibility, contrast, leader lines, colour confusability.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    renderer = _renderer(fig)
    paths = []
    for i, ax in enumerate(fig.axes, start=1):
        bb = ax.get_tightbbox(renderer).transformed(fig.dpi_scale_trans.inverted())
        bb = Bbox.from_extents(
            bb.x0 - pad_inches, bb.y0 - pad_inches, bb.x1 + pad_inches, bb.y1 + pad_inches
        )
        path = out / f"{stem}_{i:02d}.png"
        fig.savefig(path, dpi=dpi, bbox_inches=bb)
        paths.append(path)
    return paths


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--script",
        required=True,
        help="plotting script to execute under the Agg backend; every figure it leaves open is checked",
    )
    parser.add_argument("--crops-dir", help="also write per-panel PNG crops into this directory")
    parser.add_argument("--json", action="store_true", help="emit findings as JSON on stdout")
    args = parser.parse_args(argv)

    script = Path(args.script)
    if not script.is_file():
        print(f"figure_qa: script not found: {script}", file=sys.stderr)
        return 2

    matplotlib.use("Agg", force=True)
    import runpy

    import matplotlib.pyplot as plt

    plt.close("all")
    runpy.run_path(str(script), run_name="__main__")
    fignums = plt.get_fignums()
    if not fignums:
        print(
            "figure_qa: the script left no open figures; keep figures open (skip plt.close) so they can be checked",
            file=sys.stderr,
        )
        return 2

    all_findings = []
    crop_paths = []
    for num in fignums:
        fig = plt.figure(num)
        for finding in check_figure(fig):
            finding["figure"] = num
            all_findings.append(finding)
        if args.crops_dir:
            crop_paths.extend(
                str(p) for p in panel_crops(fig, args.crops_dir, stem=f"fig{num:02d}_panel")
            )

    if args.json:
        print(json.dumps({"findings": all_findings, "crops": crop_paths}, indent=2))
    else:
        for finding in all_findings:
            print(f"[figure {finding['figure']}] {finding['kind']}: {finding['message']}")
        for path in crop_paths:
            print(f"crop: {path}")

    if all_findings:
        print(f"figure_qa: {len(all_findings)} geometric finding(s)", file=sys.stderr)
        return 1
    print(f"figure_qa: geometric check clean on {len(fignums)} figure(s); run the perceptual pass on the crops")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
