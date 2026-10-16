# Idea posterior: argument-graph reader surface

   The interactive graph has one visible-probability formatter: three decimal
   places on the initial canvas and in every JavaScript-created tooltip or
   detail panel. The page embeds
   `argument_graph_reader_surface_contract_v1`, which names the initial canvas,
   edge tooltip, node detail panel, and expanded legend as covered reader
   states. The contract also inventories the current button, form-control, and
   expandable IDs, including surfaces created after an interaction. Browser
   acceptance accumulates both live inventories after every exercised state
   and rejects anonymous controls or expandables. The current renderer has no
   filter control, so adding a control requires the contract and event-driven
   coverage to name every filtered state before the new control is accepted.
   The same rule applies to any future expandable reader text.

   Static source or initial-DOM inspection is only a quick drift check. It
   cannot support a claim that all visible values comply, because click,
   pointer, filter, and expansion handlers can create new text after load.
   Acceptance therefore executes the generated page in a browser, triggers a
   node click, edge tooltip, and legend expansion, and checks the resulting
   visible text against the embedded formatter contract. A different renderer
   is outside this renderer's evidence: its validator must provide equivalent
   interaction-state evidence or fail closed rather than inheriting this
   page's result.
