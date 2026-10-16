# Idea posterior: link rules for posterior reports

**Every anchor in the report is rendered as a link, not bare text.** An anchor
earns its place only if a reader can reach it in one click:

- A resolvable URI (a literature record, preprint, DOI, or dataset record) is
  written as a Markdown link to that URI — carried through verbatim from the
  grounding report's `evidence_uris`, never downgraded to a plain identifier
  string.
- Repo-local artifact links are written as Markdown targets that resolve from
  the report file's own directory, never as absolute local paths or local-file
  URLs. Do not hand-write project-root-looking targets such as
  `ideas/gaia/<slug>-gaia/argument-graph.html` inside a report stored under
  `artifacts/<campaign>/`: standard Markdown will resolve that as
  `artifacts/<campaign>/ideas/...`. Let the normalizer compute the correct
  report-relative target, such as
  `../../ideas/gaia/<slug>-gaia/argument-graph.html`
  from `artifacts/<campaign>/posterior_report_v1.md`, or `posterior.json` for
  a sibling artifact in the same directory. The posterior's `gaia_package_ref`
  keeps its `project://...#sha256:` pin intact in machine artifacts — the pin
  is what ties the reference to the exact compiled graph — while the human
  Markdown link is just the click target.
- Bare or backticked local file paths and literature identifiers in reports are
  not allowed as plain text. File mentions must be Markdown links; arXiv, DOI,
  and INSPIRE recid mentions must link to their source records. Use fenced code
  blocks only for commands or literal snippets, not as a way to present a report
  artifact/source path.
- Before committing or sharing a Codex-readable report, normalize the
  human-facing posterior display and repo-local links with:

  ```bash
  python3 skills/idea-posterior/scripts/normalize_report_posteriors.py \
    <report.md>
  python3 skills/idea-posterior/scripts/normalize_report_links.py \
    --project-root <project_root> <report.md>
  ```
  Use the same command with `--check` in gates or writeback preflight; it fails
  if a local Markdown link is still unnormalized, broken, absolute-local, or
  otherwise not clickable from the report file's location.
- The `anchor: <...>` notes echoed into the report follow the same rule: a
  resolvable reference inside an anchor note is a link.

A report that names a source or artifact without a link has failed its one job
— the reachability question below cannot then be answered without the very
re-search the report existed to save.
