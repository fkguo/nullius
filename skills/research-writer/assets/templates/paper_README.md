# Paper workspace

This is a blank format template. It contains no selected results, derivations,
figures, source-supported claims, or scientific review.

Read the project's `research_notebook.md`, `research_contract.md`, relevant
literature passages and run artifacts. Write the manuscript in `main.tex` or
section files actually included by it. Select the structure and evidence for the
research question. Keep the notebook as the complete, readable research record;
a paper is a purposeful synthesis of that record.

Before delivery, review the actual manuscript against the sources and results,
resolve substantive findings, run the applicable cross-reference, result
traceability and figure display checks, and read their reports. Refer to the
installed research-writer skill for the commands and report contracts.

Build with a configured TeX toolchain, then inspect the PDF:

```bash
latexmk -pdf main.tex
```

`export_manifest.json` initially records `blank_scaffold` and `not_run`; those
values are not scientific acceptance or compilation success. The external
`paper_manifest.json` workflow is available when another producer supplies that
contract. At handoff, explicitly include the current PDF and any additional
source dependencies in the project export, inspect the copied deliverables, and
link the readable result to the user. A manifest alone is not delivery.
