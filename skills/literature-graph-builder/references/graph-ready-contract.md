# Graph-Ready Literature Artifact Contract

This reference defines the portable graph artifact expected by `literature-graph-builder`. It is domain-neutral: projects provide their own physics, biology, history, or engineering content through notes and source locators.

## Minimal JSON Shape

```json
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "stable-paper-id",
      "label": "Short display label",
      "kind": "paper",
      "note_path": "notes/papers/stable-paper-id.md",
      "source_uris": ["https://example.org/source"],
      "topics": ["topic-a"]
    }
  ],
  "edges": [
    {
      "source": "stable-paper-id",
      "target": "method-node-id",
      "relation": "uses-method",
      "evidence": "One-line source-backed reason for the edge.",
      "note_path": "notes/papers/stable-paper-id.md",
      "locator": "Section 2"
    }
  ],
  "figures": [
    {
      "node_id": "stable-paper-id",
      "path": "figures/stable-paper-id/result.png",
      "caption": "What this figure shows.",
      "source_path": "sources/stable-paper-id/figure1.pdf",
      "locator": "Figure 1",
      "note_path": "notes/papers/stable-paper-id.md"
    }
  ]
}
```

## Nodes

Required fields:

- `id`: stable ASCII identifier, unique within the graph.
- `label`: concise display label for the graph.
- `kind`: semantic class, such as `paper`, `method`, `topic`, `dataset`, `result`, or `synthesis`.
- `note_path`: relative path to a Markdown note with substantive reading content.

Recommended fields:

- `source_uris`: resolvable URLs, DOIs, arXiv ids, local source manifests, or repository-specific evidence URIs.
- `topics`: clustering labels used by the renderer.
- `summary`: one or two sentences for hover text or the sidebar.

Every paper node should have its own deep-read note. Method, topic, and synthesis nodes should also have notes when they carry interpretive content rather than merely acting as visual separators.

Paper and method nodes must come from the reconciled upstream ledgers. A reference
found in a core-source bibliography is not silently omitted: it is either promoted
to a paper node/candidate with a canonical DOI/URL/provider identity and
metadata provenance, or retained upstream with an explicit disposition and
coverage-debt status. Every reconciled candidate also has a source-located
method-screening disposition grounded in source text before method nodes are emitted;
title/year metadata cannot justify either a positive or negative method-bearing
decision. Method nodes and `uses-method` /
`method-lineage` edges use the audited method taxonomy plus source-local method
descriptions with `evidence_basis: source_text` and at least one `method_features`
entry; title/year similarity is not sufficient evidence for a method edge.

## Edges

Required fields:

- `source`: node id.
- `target`: node id.
- `relation`: typed relation label.

Recommended relation names:

- `cites`
- `extends`
- `uses-method`
- `same-work`
- `contrast`
- `method-lineage`
- `application`
- `source-support`
- `topic`
- `synthesis`

Every nontrivial edge should include at least one of:

- `evidence`: short statement explaining why the edge exists.
- `note_path`: note containing the source support.
- `locator`: section, page, equation, table, figure, appendix, or source artifact locator.
- `source_uri`: source that supports the connection.

Do not encode visual proximity as an edge unless the relation is explicitly stated. A graph is evidence infrastructure, not a decoration.

## Figures

Figure entries describe renderable assets that can be embedded in notes, sidebars, or slides.

Required fields:

- `node_id`: node that owns or motivates the figure.
- `path`: relative path to a renderable asset.
- `caption`: content description.

Recommended fields:

- `source_path`: relative path to the original or converted source artifact.
- `locator`: page, figure number, table number, equation, or source file name.
- `note_path`: relative path to the note discussing the figure.
- `rights_note`: short usage note when reuse rights are not obvious.

Displayed figure paths must point to actual images or PDFs. EPS/PS files should be converted to PNG/PDF and the graph should link the converted artifact. A paper title page is not an acceptable figure unless the title page itself is the evidence being discussed.

## Portability

All paths are relative to the graph JSON file or an explicitly supplied project root. Do not write absolute user home paths, temporary paths, `file://` URLs, or paths that escape the project root with `..`.

Generated HTML should be movable as a directory. If the graph embeds notes as JSON, store the raw relative note path as metadata as well so the user can reach the source note.

## Rendering Expectations

An acceptable interactive graph has:

- first-click node opening;
- draggable nodes or otherwise controllable layout;
- collision handling for nodes and labels;
- clickable connected-literature entries;
- rendered Markdown notes with MathJax/KaTeX or an equivalent math renderer;
- visible figure assets with failed-image checks;
- source locator links that resolve to notes, source artifacts, or converted figure files;
- no raw Markdown path strings where links are expected.

## Review Checklist

Use this checklist before promoting the graph:

- Does every important node have a note?
- Are edge endpoints valid and relation labels meaningful?
- Are edge reasons traceable to source notes or source locators?
- Are important figures embedded as images/PDFs rather than listed as filenames?
- Are EPS/PS files converted before display?
- Do local links work after moving the artifact directory?
- Does browser QA cover first click, drag/collision, note rendering, math rendering, and image loading?
- Did an independent reviewer inspect the current artifact after the latest fixes?
- Does the upstream survey avoid `saturated` while any core bibliography,
  candidate disposition, or method-family audit remains open?
