% SciPost LaTeX Template (version 2021-08)
% [https://scipost.org/SciPostPhys/authoring]
% [https://git.scipost.org/scipost/SciPost_LaTeX_Templates_Submission]
% slightly adapted/customized by Lorenz Vogel (version 2022-01)
% Plehn Group, Institute for Theoretical Physics, Heidelberg University
% [compiler: pdfLaTeX]


\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{SciPost}

\LoadClass[11pt, a4paper]{article}

% page layout
\RequirePackage[a4paper, top=12mm, bottom=12mm, left=30mm, right=30mm, head=12mm, includeheadfoot]{geometry}
\bigskipamount 6mm

% for table of contents: remove trailing dots
\RequirePackage{tocloft}
\renewcommand{\cftdot}{}

% add References to TOC
\RequirePackage[nottoc, notlot, notlof]{tocbibind}

% spacings between (sub-)sections
\RequirePackage{titlesec}
\titlespacing*{\section}{0pt}{1.80\baselineskip}{\baselineskip}

% unicode characters
\RequirePackage[utf8]{inputenc}

% DOI links in references
\RequirePackage{doi}

% math formulas and symbols
%\RequirePackage{amsmath, amssymb} % redundant (clashes with mathdesign)
\RequirePackage{amsmath}

% hyperrefs
\RequirePackage{hyperref}

% include line numbers in submissions
\RequirePackage{lineno}

% SciPost BibTeX style
% note: load BibTeX style in the LaTeX document
%\bibliographystyle{SciPost-bibstyle}

% SciPost header and footer
\RequirePackage{fancyhdr}
\pagestyle{fancy}

\makeatletter
	\let\ps@plain\ps@fancy
\makeatother

\RequirePackage{xcolor}
\definecolor{scipostdeepblue}{HTML}{002B49}
\definecolor{scipostphys}{HTML}{0019A2}
\definecolor{scipostastro}{HTML}{946E13}
\definecolor{scipostbio}{HTML}{2B7E13}
\definecolor{scipostchem}{HTML}{605AAF}
\definecolor{scipostcompsci}{HTML}{0AADAB}
\definecolor{scipostmath}{HTML}{A10800}

\RequirePackage{graphicx}
\RequirePackage{cite}
\RequirePackage[width=0.90\textwidth]{caption}

% patch lineno when used with amsmath
\newcommand*\patchAmsMathEnvironmentForLineno[1]{%
	\expandafter\let\csname old#1\expandafter\endcsname\csname #1\endcsname%
	\expandafter\let\csname oldend#1\expandafter\endcsname\csname end#1\endcsname%
	\renewenvironment{#1}%
	{\linenomath\csname old#1\endcsname}%
	{\csname oldend#1\endcsname\endlinenomath}}
\newcommand*\patchBothAmsMathEnvironmentsForLineno[1]{%
	\patchAmsMathEnvironmentForLineno{#1}%
	\patchAmsMathEnvironmentForLineno{#1*}}
\AtBeginDocument{%
	\patchBothAmsMathEnvironmentsForLineno{equation}%
	\patchBothAmsMathEnvironmentsForLineno{align}%
	\patchBothAmsMathEnvironmentsForLineno{flalign}%
	\patchBothAmsMathEnvironmentsForLineno{alignat}%
	\patchBothAmsMathEnvironmentsForLineno{gather}%
	\patchBothAmsMathEnvironmentsForLineno{multline}}
% end patch lineno

\DeclareOption{submission}{\rhead{{\bf\color{scipostdeepblue}~Submission~~}}}

% physics
\DeclareOption{Phys}{\lhead{\colorbox{scipostphys}{\bf\color{white}~SciPost Physics~}}}
\DeclareOption{PhysCore}{\lhead{\colorbox{scipostphys}{\bf\color{white}~SciPost Physics Core~}}}
\DeclareOption{PhysLectNotes}{\lhead{\colorbox{scipostphys}{\strut\bf\color{white}~SciPost Physics Lecture Notes~}}}
\DeclareOption{PhysProc}{\lhead{\colorbox{scipostphys}{\strut\bf\color{white}~SciPost Physics Proceedings~}}}
\DeclareOption{PhysCodeb}{\lhead{\colorbox{scipostphys}{\strut\bf\color{white}~SciPost Physics Codebases~}}}

% astronomy, biology, chemistry, computer science, and mathematics
\DeclareOption{Astro}{\lhead{\colorbox{scipostastro}{\strut\bf\color{white}~SciPost Astronomy~}}}
\DeclareOption{Bio}{\lhead{\colorbox{scipostbio}{\strut\bf\color{white}~SciPost Biology~}}}
\DeclareOption{Chem}{\lhead{\colorbox{scipostchem}{\strut\bf\color{white}~SciPost Chemistry~}}}
\DeclareOption{CompSci}{\lhead{\colorbox{scipostcompsci}{\strut\bf\color{white}~SciPost Computer Science~}}}
\DeclareOption{Math}{\lhead{\colorbox{scipostmath}{\strut\bf\color{white}~SciPost Mathematics~}}}

\ProcessOptions\relax