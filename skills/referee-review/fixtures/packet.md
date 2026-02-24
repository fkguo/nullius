# Minimal referee-review packet (generic)

This is a tiny, self-contained packet for exercising the output contract (Markdown + JSON + schema).

## Paper diff

```diff
diff --git a/paper.tex b/paper.tex
index 0000000..1111111 100644
--- a/paper.tex
+++ b/paper.tex
@@ -1,6 +1,8 @@
 \section{Introduction}
-We prove Theorem 1.
+We prove Theorem 1 under Assumption A (smoothness) and provide a numerical sanity check.
+\cite{Smith2020}

 \section{Method}
 ...
```

## References

- Smith (2020), arXiv:2001.00001 — Baseline method and closest related work (as claimed by the authors).

## Artifact pointers

- hep://runs/EXAMPLE/artifacts/paper_bundle.zip
- hep://runs/EXAMPLE/artifacts/references.bib
- hep://runs/EXAMPLE/artifacts/build_log.txt
