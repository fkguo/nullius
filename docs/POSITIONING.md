# Autoresearch Lab — Positioning

This document states what Autoresearch Lab **is**, **is not**, which **agent
failure modes** the project actively defends against, and **how the
discipline is enforced**. It complements the surface taxonomy in
[`README.md`](../README.md) §1–§3 with the non-surface guarantees.

English | [中文](./POSITIONING_zh.md)

## 1. What Autoresearch Lab is

A domain-neutral, evidence-first research monorepo for **agent-assisted
research workflows**. The control plane (`autoresearch` CLI + `orch_*`
MCP) is the durable lifecycle authority for external project roots;
provider packages and skills are bounded operators that the control
plane composes. HEP is the current most mature use case, not the
domain boundary — see §2.

## 2. What Autoresearch Lab is NOT

- **Not a SaaS.** State and artifacts live inside each external research
  project root, not on a remote service. There is no subscription, no
  shared backend, no metering. See [`README.md`](../README.md) §4 for
  where state actually lives.
- **Not a replacement for the researcher.** Finalizing conclusions is
  gated (A5) and fails closed against an integrity receipt (gates defined
  in [`packages/shared/src/gate-registry.ts`](../packages/shared/src/gate-registry.ts));
  heavy-compute approval (A3) is opt-in, and the remaining checkpoints
  (A1/A2/A4) are advisory. The agent walks the work; the **researcher
  decides whether the result is real**.
- **Not a paper writer from a prompt.** `research-writer` and
  `paper-reviser` operate on prose the researcher already owns, against
  evidence already collected by audited runs. They do not generate
  draft papers from an idea.
- **Not HEP-only.** `@autoresearch/hep-mcp` is the current most mature
  domain pack and strongest end-to-end example. **By its
  [`package.json`](../packages/hep-mcp/package.json) dependencies, it
  explicitly includes cross-domain providers as workspace deps** —
  `@autoresearch/arxiv-mcp` and `@autoresearch/openalex-mcp` are
  domain-neutral atoms covering the wider scholarly literature, and
  `packages/hep-mcp/src/**/*.ts` imports them as runtime collaborators
  (not just type peers). The control plane and the skills are
  domain-neutral. "HEP" reflects the maturity of one use case, not
  the boundary of the system.
- **Not a re-implementation of provider tools.**
  `inspire_*`, `pdg_*`, `hepdata_*`, `arxiv_*`, `openalex_*`,
  `zotero_*` are *evidence sources*. The discipline this project
  enforces is **whether** the evidence was actually consulted before
  durable claims are made, not how the provider works.
- **Not a "borrowed-list" implementer.** If a borrowed concept from an
  external framework solves a *human* failure mode (e.g. reviewer
  bias from seeing author names), and an AI agent does not have that
  failure mode, the concept is not imported. The skill list and the
  CI surface below are all motivated by **agent** failure modes
  observed in this project's actual sessions.

## 3. Agent failure modes the project defends against

### M1–M7: pre-approval discipline

Seven recurring AI research failure modes documented at
[`skills/research-integrity/SKILL.md`](../skills/research-integrity/SKILL.md):

- **M1** implementation_bug_passing_self_review
- **M2** hallucinated_citation
- **M3** hallucinated_measurement_or_result
- **M4** shortcut_reliance
- **M5** bug_as_insight
- **M6** methodology_fabrication
- **M7** frame_lock

The skill is prompt-level discipline. Its receipt is **machine-enforced
at the approval gate**: writing a receipt with
`autoresearch integrity-record --approval-id <id> --modes <Mx,...>` is
a precondition for `autoresearch approve`. Missing the receipt fails
closed with `INTEGRITY_RECEIPT_REQUIRED`. Implementation:
[`packages/shared/src/integrity-receipt.ts`](../packages/shared/src/integrity-receipt.ts),
hooked into the approval gate at
[`packages/orchestrator/src/orch-tools/approval.ts`](../packages/orchestrator/src/orch-tools/approval.ts).

### Long-conversation drift: harness invocation anchor

Long agent sessions evict the `research-harness` skill from context;
project state and the agent's mental model silently desync. For tool
calls that **read or write project-keyed state** (classification per
[each `*-mcp` package's
`state-touch-classification.ts`](../packages)), every `*-mcp`
dispatcher verifies that the anchor marker at
`.autoresearch/HARNESS_INVOCATION` (written by `autoresearch status`)
is at least as fresh as the most recent change to
`.autoresearch/state.json` and `.autoresearch/ledger.jsonl`, was
written for the current project root (identity check), and is not
timestamped in the future (clock-skew guard). Missing / mismatched /
future / stale-vs-state anchor fails closed with
`HARNESS_INVOCATION_REQUIRED`.

The check is **event-driven, not clock-based** (matching the patterns
used by Codex's `config_lock` content-equality validation and Claude
Code's `FileEditTool` mtime check — no clock TTL). Skipped for:

- pure read-only provider queries (per the audit-backed
  `state-touch-classification.ts` in each `*-mcp` package);
- standalone use where `process.cwd()` has no `.autoresearch/`
  directory (no lifecycle context).

Implementation:
[`packages/shared/src/harness-invocation.ts`](../packages/shared/src/harness-invocation.ts);
the [`research-harness` skill](../skills/research-harness/SKILL.md) is
the recommended re-anchor flow.

## 4. How the discipline is enforced — anti-drift CI

A discipline that lives only in `SKILL.md` files erodes silently. Every
guarantee below has a CI script that fails the build if the discipline
slips. The full inventory, all wired into
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

| Anti-drift script | What it locks | What it catches |
| --- | --- | --- |
| [`check-shell-boundary-anti-drift.mjs`](../scripts/check-shell-boundary-anti-drift.mjs) | front-door entrypoint truth, package first-touch framing, shell-boundary wording | accidental drift in the 10 front-door narrative docs scanned per [`scripts/lib/front-door-boundary-authority.mjs`](../scripts/lib/front-door-boundary-authority.mjs) (`README.md`, `docs/QUICKSTART.md`, `docs/README_zh.md`, `docs/PROJECT_STATUS.md`, `docs/ARCHITECTURE.md`, `docs/TOOL_CATEGORIES.md`, `docs/TESTING_GUIDE.md`, `docs/URI_REGISTRY.md`, `meta/protocols/session_protocol_v1.md`, `meta/docs/orchestrator-mcp-tools-spec.md`). AGENTS.md/CLAUDE.md byte-sync is covered by `check-governance-sync.mjs` (next row), not by this one. |
| [`check-atomic-write-anti-drift.mjs`](../scripts/check-atomic-write-anti-drift.mjs) | no bare `fs.writeFileSync` / `renameSync` / `appendFileSync` (or `fs.promises.*` variants) in production code | torn-write data loss on crash mid-write |
| [`check-governance-sync.mjs`](../scripts/check-governance-sync.mjs) | `AGENTS.md` ↔ `CLAUDE.md` governance sections byte-identical | governance drift between mirrored files |
| [`check-harness-invocation-anti-drift.mjs`](../scripts/check-harness-invocation-anti-drift.mjs) | every `*-mcp` dispatcher imports + calls `verifyHarnessInvocationMarker` | long-conversation drift; new MCP added without anchor enforcement |
| [`check-integrity-receipt-anti-drift.mjs`](../scripts/check-integrity-receipt-anti-drift.mjs) | every approval-gate handler imports + calls `verifyIntegrityReceipt` | M1–M7 discipline silently skipped by approving without a receipt |
| [`check-skill-tool-name-anti-drift.mjs`](../scripts/check-skill-tool-name-anti-drift.mjs) | tool names referenced in `SKILL.md` files exist in tool-name registries | provider tool renamed without updating skill prose |
| `pnpm codegen:check` | `packages/shared/src/generated/` and `meta/generated/` match their JSON schemas | hand-edited generated code vs schema drift |

These run on every PR. A failing lint is treated as a feature failure:
the fix restores the discipline, it does not soften the lint.

## 5. Reading the code as an agent

If you are an agent working in this repo or driven by `research-harness`
on an external project root:

- **Read the surface by code, not by name.** A package name (e.g.
  `hep-mcp`) does not determine the package's domain scope. Check
  `package.json` deps and the actual `import` statements before
  asserting what a package does. Likewise for tool names: open the
  handler before deciding what the tool routes.
- **Walk M1–M7 before approval.** Skipping the walk means
  `.autoresearch/integrity_log.jsonl` is missing a matching receipt,
  and the approval gate will fail closed. Recovery is to re-walk and
  re-record; the latest receipt wins.
- **Treat anti-drift CI failures as discipline failures.** Fixing the
  CI means restoring the broken contract, not loosening the check.

## 6. What is intentionally absent

Two concepts were considered, scoped, and dropped during this project's
2026-05-22 audit pass. Recording the rejections here so future agents do
not silently re-propose them:

- **No data-access-level / identity-blinding tiers.** Author identity
  blinding solves a **human** reviewer-bias problem; an AI agent has
  no equivalent bias, and M2 verification *requires* the agent to see
  author identities. The borrowed concept was a wrong fit for an
  agent-assisted system — not a "defer until consumer", a wrong
  framing.
- **No retroactive "remove generic primitives from hep-mcp" migration.**
  `hep-mcp` is composite by design (depends on `arxiv-mcp` and
  `openalex-mcp`, see §2). Primitives such as the external-API cache
  and the budget/warning diagnostics support that composite role and
  do not get moved to `@autoresearch/shared` until a real second
  consumer requests them. Speculative "move it just in case" is not
  done.

These are not "later": they are **closed scope**. If future evidence
shows a real problem that one of these patterns would solve, that work
re-opens under a new motivating consumer and a new design, not under
the rejected framings.
