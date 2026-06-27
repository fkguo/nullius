#!/usr/bin/env python3
"""Minimal vector geometry example for the physics-diagrams skill."""

from __future__ import annotations

import math
import argparse
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import Arc, Polygon


mpl.rcParams.update({
    "font.size": 9,
    "mathtext.fontset": "cm",
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})


def arrow(ax, start, end, label, offset=(0.04, 0.04)):
    ax.annotate(
        "",
        xy=end,
        xytext=start,
        arrowprops={"arrowstyle": "-|>", "lw": 1.4, "color": "black"},
        zorder=4,
    )
    ax.text(
        end[0] + offset[0],
        end[1] + offset[1],
        label,
        ha="left",
        va="bottom",
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.9, "pad": 0.4},
        zorder=5,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the physics-diagrams Matplotlib geometry example."
    )
    parser.add_argument(
        "--out",
        default="/tmp/physics-diagrams-matplotlib-example/geometry.pdf",
        help="Output PDF path. The PNG preview is written next to it.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(3.4, 2.2), constrained_layout=True)
    ax.set_aspect("equal")
    ax.axis("off")

    plane = Polygon(
        [(-1.3, -0.45), (0.95, -0.25), (1.25, 0.65), (-0.85, 0.85)],
        closed=True,
        facecolor="#9fd3ef",
        edgecolor="#4d7890",
        linewidth=0.6,
        alpha=0.62,
        zorder=1,
    )
    ax.add_patch(plane)

    origin = (0.0, 0.0)
    arrow(ax, origin, (0.85, 0.55), r"$\vec p_1$")
    arrow(ax, origin, (-0.9, -0.25), r"$\vec p_3$", offset=(-0.25, -0.18))
    arrow(ax, origin, (0.1, -0.85), r"$\vec p_2$", offset=(0.04, -0.05))

    ax.annotate("", xy=(1.35, 0.0), xytext=origin, arrowprops={"arrowstyle": "->", "lw": 0.7})
    ax.annotate("", xy=(0.0, 1.05), xytext=origin, arrowprops={"arrowstyle": "->", "lw": 0.7})
    ax.text(1.38, 0.0, r"$x$", va="center")
    ax.text(0.0, 1.08, r"$y$", ha="center")

    ax.add_patch(Arc(origin, 0.75, 0.75, theta1=-78, theta2=-18, lw=0.7, color="black"))
    ax.text(
        0.43,
        -0.33,
        r"$\theta_{23}$",
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.88, "pad": 0.4},
    )

    ax.plot([-0.8, 0.8], [-0.35, 0.35], ":", color="black", lw=0.7, zorder=2)
    ax.text(-1.25, 0.95, "geometry route", fontsize=9)
    ax.set_xlim(-1.55, 1.55)
    ax.set_ylim(-1.05, 1.18)
    fig.savefig(out, format="pdf", bbox_inches="tight", pad_inches=0.02)
    fig.savefig(out.with_suffix(".png"), dpi=600, bbox_inches="tight", pad_inches=0.02)


if __name__ == "__main__":
    main()
