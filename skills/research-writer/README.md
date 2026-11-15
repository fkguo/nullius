# research-writer

Use the active host agent to read the research notebook, sources and run results,
write the actual manuscript, obtain scientific review, and deliver checked files.
The skill supplies mechanical support: blank RevTeX scaffolding, bibliography and
cross-reference checks, result traceability, external paper-manifest consumption,
and portable packaging. It does not prescribe a model pair or a fixed narrative.

The research notebook remains the complete human scientific record. Create a
paper only when the research task calls for one. Read [SKILL.md](SKILL.md) for the
writing/review/handoff workflow and [RUNBOOK.md](RUNBOOK.md) for commands.
[中文说明](README.zh.md) is also available.

## Initialize a new paper workspace

From this skill directory (or use the installed script's absolute path):

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-project \
  --tag M1-r1 --out /path/to/research-project/paper
```

Python 3 and Bash are required. The command creates a blank RevTeX 4.2 template,
empty bibliography, figure directory and initialization/export metadata. It does
not import notebook text, select results or claim that a paper is ready. Existing
output paths are refused. `--run-card <path>` optionally copies opaque JSON;
`--title` and `--authors` accept plain text.

Write `main.tex` or included sections using the actual research. Ground claims
with the existing `claim-grounding` procedure, review the reasoning and results,
run applicable mechanical/display checks, then compile and inspect the PDF when
that is the requested output. TeX with RevTeX and `latexmk` is required to build.

## Use an external manuscript contract

If another producer supplies `paper_manifest.json`, keep that contract and run:

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json --compile
```

The consumer records its current checks and build in `build_trace.jsonl` and
`export_manifest.json`. Requested compilation fails when the toolchain is absent
or the build fails; an old PDF is not current build evidence. Scientific review
remains an explicit agent step.

## Deliver the result

Read the current export manifest and use the existing `research-team` export
workflow to include its referenced files, the readable manuscript and required
source/evidence dependencies. Inspect the exported files and give the user direct
links with material limitations. The scaffold manifest describes initialization;
add a subsequently built PDF and other dependencies explicitly when needed.
