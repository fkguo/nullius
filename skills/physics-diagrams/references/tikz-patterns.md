# TikZ And Feynhand Patterns

Use these patterns as starting points. Keep coordinates explicit. The highest-quality figures in this
class are usually manually laid out.

## Standalone Wrapper

```tex
\documentclass[tikz,border=3pt]{standalone}
\usepackage{amsmath}
\usepackage{xcolor}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,calc,decorations.pathreplacing,positioning,backgrounds}
\input{../styles/pd_styles.tex}

\begin{document}
\begin{tikzpicture}[line cap=round,line join=round,>=Stealth]
  % figure here
\end{tikzpicture}
\end{document}
```

Use `standalone` as the source of truth when possible. In manuscript text, include the generated PDF:

```tex
\includegraphics[width=0.92\linewidth]{figs/my_diagram.pdf}
```

For inline equation diagrams, keep a standalone wrapper that inputs the same `.tikz` file:

```tex
% figs/src/my_diagram_standalone.tex
\documentclass[tikz,border=3pt]{standalone}
...
\begin{document}
\input{../my_diagram.tikz}
\end{document}
```

## Common Styles

Use the shared style file when possible:

```tex
\input{../styles/pd_styles.tex}
```

For projects that cannot import that file, copy the relevant `pd*` styles from it into the manuscript
preamble.

Legacy local style names such as `sourceLine`, `particle`, or `exchange` should be normalized to
`pdSourceLine`, `pdParticle`, and `pdExchange` when creating new figures.

## Feynhand Wrapper

Use this when the figure benefits from `\propag` and feynhand particle-line vocabulary:

```tex
\documentclass[tikz,border=3pt]{standalone}
\usepackage{amsmath}
\usepackage{xcolor}
\usepackage{tikz}
\usepackage[compat=1.1.0]{tikz-feynman}
\usepackage[compat=1.1.0]{tikz-feynhand}
\usetikzlibrary{arrows.meta,calc,positioning}
\tikzfeynmanset{warn luatex=false}
\input{../styles/pd_styles.tex}

\begin{document}
\begin{tikzpicture}[line cap=round,line join=round]
  \begin{feynman}
    \begin{feynhand}
      \vertex (a) at (0,0) {};
      \vertex (b) at (1.4,0) {};
      \propag[thick] (a) to (b);
    \end{feynhand}
  \end{feynman}
\end{tikzpicture}
\end{document}
```

Keep feynhand vertices explicit. Use separate `pdLabel` nodes instead of automatic edge labels when
labels are near branch points, loops, or arrowheads.

## Style Snippet

```tex
\tikzset{
  pdLabel/.style={
    fill=white,
    fill opacity=0.92,
    text opacity=1,
    inner sep=1pt,
    font=\small
  },
  pdPanel/.style={font=\small, anchor=north west},
  pdBlock/.style={
    draw=black,
    line width=0.45pt,
    rounded corners=1pt,
    minimum width=8mm,
    minimum height=7mm,
    inner sep=2pt,
    align=center
  },
  pdArrow/.style={gray, line width=0.55pt, -{Stealth[length=2.2mm]}},
  pdGuide/.style={gray!65, line width=0.35pt},
  pdHeavyParticle/.style={draw=black,line width=0.64pt},
  pdLightParticle/.style={
    draw=black,dashed,dash pattern=on 2.7pt off 1.9pt,line width=0.58pt
  },
  pdDimerHeavy/.style={pdHeavyParticle,line width=0.48pt,line cap=butt},
  pdDimerLight/.style={pdLightParticle,line width=0.46pt,line cap=butt}
}
\newcommand{\DimerLineH}[5]{%
  \draw[#4] (#1,{#2+0.045}) -- (#3,{#2+0.045});
  \draw[#5] (#1,{#2-0.045}) -- (#3,{#2-0.045});
}
\newcommand{\ParticleLineH}[4]{\draw[#4] (#1,#2) -- (#3,#2);}
\tikzfeynmanset{
  every edge/.append style={line width=0.65pt},
  triple/.style={
    draw,
    preaction={draw,line width=0.5pt,transform canvas={yshift=1.5pt}},
    preaction={draw,line width=0.5pt,transform canvas={yshift=-1.5pt}}
  }
}
```

Use muted fills by default. Start from light gray/blue/rose/green fills, not saturated poster colors.
If a line meets an operator block, draw two line segments ending at the block edge; do not draw one
continuous line through the block unless the crossing is physically meaningful.

For a filled vertex blob, draw all incident lines to the same center coordinate first, then draw the
filled circle last. The circle masks the line pieces inside the vertex, so the visual reads as lines
emerging from one physical vertex without strokes crossing the filled symbol.

## Label Placement

Prefer separate nodes over automatic edge labels:

```tex
\draw[line width=0.65pt,-{Stealth[length=2mm]}] (a) -- (b);
\node[pdLabel,above=1.5mm] at ($(a)!0.55!(b)$) {$D^{*}$};
```

For branch labels, put labels outside the fan:

```tex
\draw[dashed,-{Stealth[length=2mm]}] (v) -- ++(1.2,0.65) coordinate (piplus);
\node[pdLabel,above right=0.5mm and 0mm of piplus] {$\pi^+$};
```

For loop labels, keep them on normal directions:

```tex
\draw[-{Stealth[length=2mm]},line width=0.65pt] (0,0) arc[start angle=205,end angle=-35,radius=8mm];
\draw[-{Stealth[length=2mm]},line width=0.65pt] (0,0) arc[start angle=155,end angle=395,radius=8mm];
\node[pdLabel,above] at (0,0.95) {$D$};
\node[pdLabel,below] at (0,-0.95) {$D^*$};
```

## Equation Schematic Layout

Use outer TikZ nodes to arrange subdiagrams, then draw hierarchy arrows between named boxes:

```tex
\node (lhs) at (0,0) {\begin{tikzpicture} ... \end{tikzpicture}};
\node at (2.0,0) {$=$};
\node (rhs) at (4.2,0) {\begin{tikzpicture} ... \end{tikzpicture}};

\node[draw,fill=cyan!10,inner sep=8pt,anchor=west] (BoxT) at (0,-2.5) {
  \begin{tikzpicture} ... \end{tikzpicture}
  $\;=\;$
  \begin{tikzpicture} ... \end{tikzpicture}
};
\draw[pdArrow] (rhs.south) -- ++(0,-0.35) -| (BoxT.north west);
```

This pattern is better than trying to place the entire recursion equation inside one `feynman`
environment.

For publication schematics, name each panel and make arrows land on panel anchors or explicitly
computed boundary coordinates. Arrow tips should touch the boundary, not hover near it and not enter
the physics content. Keep `+` and `=` operators at fixed coordinates with visible air on both sides.
If the detailed expansion is shown in a lower row, the parent row should usually contain one
representative glyph, not several adjacent mini topologies that can be misread as a product.

Avoid hard-coded panel heights that leave large empty margins. Either use a `fit` node around
content anchors, or compute the frame from the known top/bottom content coordinates plus a small,
consistent padding:

```tex
\coordinate (panelNW) at (0.35,-5.05);
\coordinate (panelSE) at (15.70,-12.60);
\node[pdFrame, fill=pdBlue!12, fit=(panelNW) (panelSE), inner sep=0pt] (InelPanel) {};
\draw[pdArrow] (source.south) -- (InelPanel.north);
```

When a panel is an algebraic container rather than a physics object, the box is only a grouping aid:
do not draw internal topology lines as separate nested pictures if those lines should be physically
continuous across the panel.

## Channel-Dependent Exchange Kernels

When an exchange particle is tied to a channel pair, draw one small topology per channel pair instead
of one generic diagram with a comma-separated exchange label. This prevents the figure from implying
that all exchanges are interchangeable. The exchange vertex must change the external object type:
incoming dimer `->` remaining particle after emitting the exchanged particle, and incoming spectator
particle `->` outgoing dimer after absorbing it.

```tex
% single solid: D or D*; single dashed: K or pi.
% dimer/isobar = two separate constituent lines, not TikZ's closed-ended double stroke.
\newcommand{\ChannelExchange}[8]{%
  \begin{tikzpicture}[baseline=(base.base),line cap=round,line join=round]
    \coordinate (base) at (0,0);
    \coordinate (v1) at (-0.38,0.34);
    \coordinate (v2) at (0.38,-0.34);
    \DimerLineH{-1.18}{0.34}{-0.38}{pdDimerHeavy}{#5}
    \ParticleLineH{-0.38}{0.34}{1.18}{#6}
    \ParticleLineH{-1.18}{-0.34}{0.38}{#7}
    \DimerLineH{0.38}{-0.34}{1.18}{pdDimerHeavy}{#8}
    \draw[#4] (v1) -- (v2);
    \node[draw,fill=pdVertex,circle,minimum size=3mm,inner sep=0pt] at (v1) {};
    \node[draw,fill=pdVertex,circle,minimum size=3mm,inner sep=0pt] at (v2) {};
    \node[pdLabel] at (0.14,0.04) {$#3$};
    \node[pdLabel,left=0.4mm] at (-1.18,0) {$#1$};
    \node[pdLabel,right=0.4mm] at (1.18,0) {$#2$};
  \end{tikzpicture}%
}

\node[pdLabel] at (2.8,0.65) {$1\leftrightarrow2$};
\node at (2.8,0) {
  \ChannelExchange{1}{2}{K}{pdLightParticle}
    {pdDimerLight}{pdHeavyParticle}{pdHeavyParticle}{pdDimerLight}
};
\node[pdLabel] at (6.2,0.65) {$2\leftrightarrow3$};
\node at (6.2,0) {
  \ChannelExchange{2}{3}{D^*}{pdHeavyParticle}
    {pdDimerLight}{pdLightParticle}{pdHeavyParticle}{pdDimerHeavy}
};
\node[pdLabel] at (9.6,0.65) {$3\leftrightarrow1$};
\node at (9.6,0) {
  \ChannelExchange{3}{1}{D}{pdHeavyParticle}
    {pdDimerHeavy}{pdHeavyParticle}{pdLightParticle}{pdDimerLight}
};
```

Keep these topologies open on the page. Do not place each one in its own white rounded rectangle;
use a thin separator line or a small row label if the figure needs visual grouping. Do not repeat the
exchanged particle name in the row title when it is already labeled on the exchange line.

## Dressed Dimer-Spectator Propagators

When a paper/code defines a channel propagator as a dressed dimer--spectator object, do not show it as
an opaque `G` box. Draw the spectator as a straight line and the dimer leg with the self-energy
insertion used by the calculation: the dimer emits its two constituents, they propagate in a bubble,
and recombine while the spectator line passes through. Use channel-specific constituent line styles
when the figure is not explicitly generic.

```tex
% Representative G_i topology: dressed dimer leg above, spectator below.
% Replace pdDimerLight/pdDimerHeavy and pdLightParticle/pdHeavyParticle by
% the actual channel constituents when drawing a channel-specific G_i.
\newcommand{\DressedDimerSpectatorG}{%
  \begin{tikzpicture}[baseline=(base.base), line cap=round, line join=round]
    \coordinate (base) at (0,0);
    \coordinate (a) at (-0.56,0.28);
    \coordinate (c) at (0.56,0.28);
    \DimerLineH{-1.05}{0.28}{-0.56}{pdDimerHeavy}{pdDimerLight}
    \DimerLineH{0.56}{0.28}{1.05}{pdDimerHeavy}{pdDimerLight}
    \ParticleLineH{-1.05}{-0.28}{1.05}{pdHeavyParticle}
    \draw[pdHeavyParticle] (a) to[out=58,in=122,looseness=1.45] (c);
    \draw[pdLightParticle] (a) to[out=-58,in=-122,looseness=1.45] (c);
    \node[pdVertex] at (a) {};
    \node[pdVertex] at (c) {};
    \node[font=\scriptsize] at (0,-0.62) {$G_i$};
  \end{tikzpicture}%
}
```

## Multi-Panel Process Figures

Reserve a fixed panel label position and label lanes in each cell:

```tex
\foreach \x/\y/\lab in {0/0/{(1a)},4.2/0/{(1b)},0/-2.6/{(2a)},4.2/-2.6/{(2b)}} {
  \node[pdPanel] at (\x,\y+1.2) {\lab};
  % draw panel content relative to (\x,\y)
}
```

Keep particle labels outside lines and arrowheads. For dense panels, make the panel larger rather than
shrinking text.

## Line Semantics

Use a small legend in source comments, not necessarily on the figure:

```tex
% plain solid: stable spectator
% dimer/isobar: two nearby constituent lines, e.g. solid+dashed for DK and solid+solid for DD*
% triple: source or simple pole
% dashed single: K, pion, or other light particle when that is the manuscript convention
% wavy: photon/gauge/source line
% filled circle: vertex
```

Maintain the same semantics across every panel in a manuscript.

## Vertex Blob Idiom

Use this for interaction vertices, dressed vertices, small kernels, or source insertions represented by
a compact filled circle:

```tex
\coordinate (v) at (0,0);
\coordinate (a) at (-1.0,0);
\coordinate (b) at (1.0,0.55);
\coordinate (c) at (1.0,-0.55);

\draw[line width=0.65pt] (a) -- (v);
\draw[line width=0.65pt,-{Stealth[length=2mm]}] (v) -- (b);
\draw[dashed,line width=0.6pt,-{Stealth[length=2mm]}] (v) -- (c);
\node[draw,fill=green!12,circle,minimum size=5mm,inner sep=0pt] at (v) {};
```

Do not use this masking trick for large operator blocks such as `T`, `B+C`, kernels, or boxed
recursion equations. For those, terminate and restart lines at the block boundary so alignment and
topology stay explicit.
