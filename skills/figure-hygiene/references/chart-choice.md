# Chart Choice by Data Shape

This reference expands the chart-choice section of `figure-hygiene`. It is domain-neutral: the shapes below are statistical shapes (categories, series, distributions, matrices, projections), and any field's data maps onto them. Pick the family from the shape of the data and the number of observations, then apply the axes and layout rules at the end.

## Categorical Versus Numeric

Show the distribution, not just the summary. Chart choice follows the number of observations per category:

- **Small samples:** jittered strip of raw points with a median tick. Readers can count the points; a box would imply more data than exists.
- **Large samples:** box or violin. Add raw points only if they stay legible.
- **When the mean is the message:** bar plus overlaid raw points, or bar plus an interval. A 95 % interval of the mean uses the t-distribution half-width, which stays valid at small sample sizes. Error bars and raw-point overlays are alternatives — showing both is usually redundant.
- **Absent categories are marked, not blank.** A category absent from a group gets an explicit mark ("n.d.", a dash, or a hatched ghost) at its slot; an empty slot reads as zero. A zero-valued bar gets a visible stub or dot at the baseline so it cannot be mistaken for missing.

## Single-Observation Categories

One value per category: a filled dot with a thin neutral stem down to the semantic zero (a lollipop). The stem carries the magnitude; the dot carries the identity. Value labels sit beside the dot, not inside it.

## Continuous Series

- The per-x summary (mean or median per x) is a line with markers; individual runs or replicates are thin translucent lines or points behind it.
- Label each series with direct text at the right end of its line in preference to a legend box.
- A summary glyph (per-bin mean or median) uses a shape that cannot be mistaken for a raw observation, identical across series, drawn below the raw points in z-order.

## Distributions on Shared Support

When two distributions overlap heavily, stack them as small panels with a shared x-axis, or use a ridgeline. Overlay in one panel only when the separation is visually clear. Semi-transparent overlays of three or more distributions are rarely readable.

## Matrices and Heatmaps

- When the matrix is small enough to read (roughly under 200 cells), print the value in every cell. State the print threshold once in the colourbar label.
- A diverging matrix (signed values, ratios around 1, differences around 0) centres its colormap at the semantic zero, never at the data midpoint.
- Order rows and columns by an established external reference or a stated criterion, not silently by the plotted values, unless the ordering is itself the result.

## Low-Dimensional Projections

Projection scatters (for example a learned 2-D embedding or the first two principal components) have axes whose units carry little meaning:

- Drop ticks and tick labels; name the axes with a small corner arrow pair.
- Label clusters by thin leader lines to text placed in surrounding whitespace, never by text on top of the point cloud.
- State the projection method and any parameters that materially change the layout in the caption.

## Paired Prediction and Observation

Stack the predicted and observed tracks as adjacent panels with identical x-range and identical colour binding; let the vertical alignment carry the comparison. Target or reference regions are translucent spans registered in the legend.

## Insets and Extremes

- Connect a detail inset to its source region visibly: a bounding box on the parent panel with connector lines, or a translucent wedge.
- On a scatter of named observations, direct-label at least the maximum, the minimum, and any flagged point with a thin leader line. After rendering, verify every leader endpoint terminates within one marker radius of the row it names.

## Axes and Scales

- **Axis padding.** Axis limits clear the data by at least one marker radius on every side; markers and text never touch a spine. `ax.margins(0.04)` after plotting, or extend the limit past any annotation.
- **Axis breaks over wasted range.** When the data occupy less than about 40 % of an axis, break the axis or start it at the data floor with a clear non-zero tick. Never draw a reference line, threshold, or annotation inside a broken-axis gap — the gap has no coordinate.
- **Log axes get human-readable ticks:** powers of ten typeset as such, or "1 k / 10 k / 100 k" — not raw exponents. Never draw filled bars on a log-scaled value axis; bar length would encode the ratio to an arbitrary floor. Use points with a median tick instead.
- **Shared axes across small multiples.** A row or column of small multiples shows tick labels once (leftmost or bottommost panel); interior panels keep ticks but drop labels. Panels that share a y-axis and differ only in the x-variable become abutting subplots with one row-header title.
- **Fill the box.** A panel's data envelope occupies at least three quarters of its allotted rectangle. If a panel's natural aspect leaves dead bands, reshape the grid; do not pad the panel.
- **Direction of goodness.** When higher-is-better or lower-is-better is not obvious from the axis label, place a small upright cue ("higher = better") in the margin — once per row of panels, never per panel, and never only in the caption. Keep the cue upright even beside rotated text.
- **Physical width.** Render at the venue's column width and target dpi, and check that every label is legible at that size. Adding a legend or annotation must not squeeze the data panels narrower than they were before.

## Layout and Narrative

- **Show what is measured before the result.** A reader should grasp what is being compared before seeing the comparison — via a plain-language title, a labelled key, or panel ordering. Any explanatory sketch uses the same words and colours as the data panels.
- **One figure, one message.** A multi-panel figure has a single sentence it is trying to make true. Every panel states it, supports it, or bounds it; panels that do none of these move to supplementary material.
- **Legends live in whitespace.** Frameless, placed inside the figure's natural whitespace, or replaced by direct labelling. Legend entries are swatch-first, left-aligned, and resolve every visually distinct glyph on the panel.
- **Row-band headers for nested faceting.** When small multiples are grouped, each group gets one spanning header, not repeated per-panel titles.
