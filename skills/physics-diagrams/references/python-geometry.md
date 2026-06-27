# Python Geometry And Plot Figures

Use this route for coordinate frames, angle diagrams, projected planes, and schematic geometry figures.
It may also style precomputed data into vector PDF figures. It does not compute the external numerical
physics results behind curves, contours, fits, or histograms.

## Matplotlib Defaults

Start with vector PDF output and manuscript-scale fonts:

```python
import matplotlib as mpl
import matplotlib.pyplot as plt

mpl.rcParams.update({
    "font.size": 9,
    "mathtext.fontset": "cm",
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    # Use this only when the local TeX install is reliable for the project:
    # "text.usetex": True,
})

fig, ax = plt.subplots(figsize=(3.4, 2.4), constrained_layout=True)
ax.set_aspect("equal")
ax.axis("off")

# draw arrows, shaded regions, labels

fig.savefig("figure.pdf", format="pdf", bbox_inches="tight", pad_inches=0.02)
fig.savefig("figure.png", dpi=600, bbox_inches="tight", pad_inches=0.02)
```

Then run the shared PDF QA gate:

```bash
python3 skills/physics-diagrams/scripts/build_diagram.py \
  --qa-only figure.pdf \
  --out-dir /tmp/physics-diagrams/geometry-figure
```

In sandboxed or CI environments, set Matplotlib's cache outside the repo:

```bash
MPLCONFIGDIR=/tmp/mplconfig XDG_CACHE_HOME=/tmp/xdg-cache python3 make_geometry_figure.py
```

Use `text.usetex=True` only when the TeX preamble is stable and the same command can run in CI or on a
collaborator machine. Otherwise use mathtext and match the manuscript visually.

## Geometry Pattern

- Treat every physical vector as data: origin, endpoint, label anchor, label offset.
- Draw planes as `Polygon` patches with low alpha and thin boundaries.
- Draw axes with narrow arrows and label them away from vector labels.
- Draw angles with `Arc` patches or sampled curves.
- Use z-order deliberately: translucent planes behind vectors, labels above all strokes.
- Export PDF, then run `build_diagram.py --qa-only` and inspect at the final manuscript width.

## Label Collision Rules

Matplotlib can accidentally hide collisions because it renders text late. Use a manual QA pass:

- avoid labels at arrow tips unless offset beyond the tip;
- use a white `bbox` for labels near axes or dotted guides;
- keep angle labels outside arcs when the arc is small;
- check the figure after `bbox_inches="tight"` because tight cropping can clip labels.

Example label backing:

```python
ax.text(x, y, r"$\vec p_1$", ha="left", va="bottom",
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.88, "pad": 0.4})
```

## Existing Data Boundary

If a user asks for a numerical curve, pole trajectory, fit, histogram, or contour, first locate the
project's data-generation script or artifact. Do not invent or recompute physics data under this skill.
Use this skill only to:

- load already generated arrays/tables;
- style axes, labels, legends, annotations, and panels;
- export vector PDF/PNG previews;
- run the same publication QA gate as other figures with `build_diagram.py --qa-only`.

## Vector Integrity

Matplotlib PDF output can remain vector for lines, patches, and text. It can become rasterized when
using image artists, some transparency-heavy collections, or explicit `rasterized=True`. For a schematic
or geometry figure, `pdfimages -list figure.pdf` should normally show no image XObjects.

For true density plots or images, raster content is acceptable but must be intentional and high enough
resolution for the journal.

## When To Prefer Asymptote

Use Asymptote instead of Matplotlib when exact geometric construction and TeX labels matter more than
Python data integration, especially for clean 3D-ish vector geometry with no numerical data pipeline.
