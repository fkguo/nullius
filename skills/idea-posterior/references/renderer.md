# Idea posterior: static browser renderer

### Optional static browser renderer

The posterior does not depend on presentation rendering. A browser-readable
`docs/detailed-reasoning.html` additionally uses established generation-time
tools: [Pandoc](https://pandoc.org/) parses Markdown and emits native MathML;
[Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) renders each
Pandoc-identified `mermaid` block to static SVG; pinned
[nh3](https://github.com/messense/nh3) sanitizes the resulting HTML through
the Rust Ammonia library. The renderer carries the exact nh3 dependency in
PEP 723 metadata, and [uv](https://docs.astral.sh/uv/guides/scripts/) creates
that isolated environment automatically. uv is the bootstrapper; Pandoc and
Mermaid CLI are the only host presentation renderers. Install uv, Pandoc, and
`mmdc`, then verify the self-bootstrapping entry point:

```bash
uv run --script scripts/render_detailed_reasoning.py --help
pandoc --version
mmdc --version
```

The page begins with an evidence-to-conclusion view reconstructed from the
compiled IR: concrete recorded evidence, the authored likelihood rationale,
the structural criterion or intermediate claim being updated, and the unique
exported conclusion. Lowering paths appear before supporting paths. Generic
criterion sentences remain legal as structural hypotheses, but the page never
uses them as their own explanation. Any retained Gaia diagram is labelled a
generative probability-model graph: its arrows run from hypothesis to possible
evidence, not in the reader's evidence-flow direction.

The validated toolchain is uv 0.6.3, Pandoc 3.6.4, Mermaid CLI 11.9.0, and
nh3 0.3.6. The renderer records fixed tool names and normalized version tokens
in its manifest, never version-banner text or resolved executable paths. No
hash or tool metadata appears in the reader-facing page. uv, Pandoc, and
Mermaid CLI are optional external subprocesses, not bundled or linked into
nullius; the output page contains no runtime library or CDN dependency. Their
checked licenses are uv
[MIT](https://github.com/astral-sh/uv/blob/0.6.3/LICENSE-MIT) or
[Apache-2.0](https://github.com/astral-sh/uv/blob/0.6.3/LICENSE-APACHE),
[Pandoc GPL-2.0-or-later](https://github.com/jgm/pandoc/blob/3.6.4/COPYING.md),
[Mermaid CLI MIT](https://github.com/mermaid-js/mermaid-cli/blob/11.9.0/LICENSE),
and [nh3 MIT](https://github.com/messense/nh3/blob/v0.3.6/LICENSE). Generated
bytes can vary across browser-render tool versions, so byte identity is
claimed only for the same inputs and recorded toolchain, not across machines
with different versions.

   `run_infer_and_extract.py` performs the browser-render order automatically.
   If `detailed-reasoning.md` is intentionally edited or enriched later, use
   the standalone renderer and preserve this order:

   ```bash
   uv run --script scripts/render_detailed_reasoning.py --package <package>
   python3 scripts/render_argument_graph.py \
     --package <package> --project-root <project_root>
   ```

   In words: edit or sync Markdown, regenerate detailed HTML and its manifest,
   then regenerate the argument graph. An edited Markdown file immediately
   invalidates the old HTML link; callers never hand-write a checksum or
   manifest. Missing uv, Pandoc, or Mermaid CLI, a failed PEP 723 environment,
   or any failed rendering stage removes or withholds the HTML authority, so
   the argument graph remains usable but exposes no broken deep-dive link.
