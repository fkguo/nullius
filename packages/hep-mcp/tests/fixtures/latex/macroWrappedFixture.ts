export const MACRO_WRAPPED_EQUATIONS_LATEX_FIXTURE = String.raw`\documentclass{article}
\newcommand{\be}{\begin{equation}}
\newcommand{\ee}{\end{equation}}
\newcommand{\beas}{\begin{eqnarray*}}
\newcommand{\eeas}{\end{eqnarray*}}
\newcommand{\fk}[1]{\textcolor{red}{[FK: #1]}}
\newcommand{\eq}[1]{Eq.~\eqref{#1}}
\begin{document}

\abstract{We study X and refer to \eq{eq:test}. \fk{TODO: remove this.}}

Intro text.

\be
a = b
\label{eq:test}
\ee

\beas
x &=& y
\eeas

\begin{thebibliography}{99}
\bibitem{A} This bibliography entry is long enough to pass prose filters and must be excluded.
\end{thebibliography}
\end{document}
`;
