# Research: Agent Framework Landscape Assessment (2025-2026)

> **Date**: 2026-02-25
> **Context**: Phase 1 implementation ongoing; assess whether to adopt external agent framework or continue self-built approach
> **Conclusion**: Continue self-built; align with 3 open standards (MCP, A2A, OpenTelemetry); track PydanticAI for Phase 5
> **2026-04 public-surface note**: Phase numbering and `REDESIGN_PLAN` references below are historical planning context only; they do not point to a live public tracker file.

---

## 1. Frameworks Surveyed

| Framework | Language | Stars | Core Model | MCP | A2A | Durable Execution |
|-----------|----------|-------|------------|-----|-----|--------------------|
| Claude Agent SDK | Python | — | Wraps Claude Code CLI, in-process MCP servers, hooks | Native | No | No |
| OpenAI Agents SDK | Python | 19.1k | Agent + Runner loop, handoffs between agents | No | No | No |
| Google ADK | Python/Java/Go | — | sub_agents hierarchy, code-first | Native | **Yes** (open standard) | No |
| PydanticAI | Python | — | Pydantic-first, type-safe, model-agnostic | Native | **Yes** | **Yes** |
| Strands Agents (AWS) | Python | — | Model-driven, minimal boilerplate | Native MCP | No | No |
| LangGraph | Python/JS | — | Graph state machine + durable checkpoints | No | No | **Yes** |
| AG2 (AutoGen) | Python | — | ConversableAgent, swarm/group/nested chat | No | No | No |
| CrewAI | Python | — | Crew (autonomy) + Flow (control), role-based | No | No | No (Flow state only) |
| Mastra | **TypeScript** | — | TS-native, graph workflow, suspend/resume | Native MCP server authoring | No | **Yes** (storage-backed) |
| Crush (ex-OpenCode) | Go | — | Terminal AI assistant, multi-model, LSP | stdio/http/sse | No | No (SQLite sessions) |

## 2. Key Observations

### 2.1 Three open standards are converging

- **MCP** (Model Context Protocol): Tool/resource interface. Already adopted by Claude SDK, Google ADK, PydanticAI, Strands, Mastra. We already use it.
- **A2A** (Agent-to-Agent): Google-originated protocol for cross-process agent communication. Adopted by Google ADK and PydanticAI. Our NEW-07 should align with this.
- **OpenTelemetry**: Tracing standard. PydanticAI (via Logfire), LangGraph (via LangSmith), OpenAI SDK all support it. Our H-02 (observability) should align.

### 2.2 Durable execution is the differentiating capability

Only PydanticAI, LangGraph, and Mastra offer true durable execution (survive API failures, resume from checkpoint). This is critical for our Phase 5 long-running multi-agent research runs. Our RunManifest + atomic write + ledger pattern is a proto-version of this.

### 2.3 No framework matches our evidence-first contract

All surveyed frameworks assume tools return ephemeral results (text/JSON). None have:
- Content-addressed artifacts (SHA-256)
- Artifact URI as first-class return value
- Ledger-based audit trail per tool call
- Risk classification with confirmation enforcement

### 2.4 TypeScript agent frameworks are immature

Mastra is the only TS-native option. It's YC W25, very young, API unstable. LangGraph has a JS port but it's secondary. Our TS orchestrator will need to be self-built regardless.

## 3. Assessment: Our System vs Frameworks

### What we have that frameworks don't

| Capability | Our Implementation |
|---|---|
| Evidence-first I/O | All tool outputs → artifact + hep:// URI |
| Content-addressed artifacts | ArtifactRef V1 with SHA-256 |
| Domain state machine | RunManifest lifecycle + approval gates |
| Ledger audit | Every tool call → jsonl event |
| Risk classification | 3-level (read/write/destructive) + _confirm |
| Multi-model review | review-swarm across Claude/Gemini/Codex |

### What frameworks have that we lack

| Capability | Best Implementation | Our Gap |
|---|---|---|
| Explicit agent loop | OpenAI Runner.run(), PydanticAI Agent.run() | No agent loop abstraction (LLM provider handles it implicitly) |
| Durable execution | PydanticAI, LangGraph | RunManifest is proto-version; no cross-failure resume |
| Agent handoff/routing | OpenAI Handoffs, Google sub_agents | No inter-agent control transfer |
| Structured tracing | PydanticAI + Logfire (OpenTelemetry) | Ledger only, no span-based tracing |
| Eval framework | PydanticAI evals, Google ADK eval | No systematic agent evaluation |
| Session management | OpenAI Sessions, LangGraph checkpoints | RunManifest serves this role but not generalized |

## 4. Decision

### Do not adopt any external agent framework

**Reasons:**
1. Evidence-first contract is non-negotiable; no framework supports it
2. TS+Python monorepo makes SDK lock-in expensive
3. Model-agnostic requirement (Claude/Gemini/Codex) conflicts with Claude SDK and partially with OpenAI SDK
4. Domain-specific workflow assumptions (e.g. a fixed `ingest → reproduce → revision → computation` chain) don't fit generic patterns
5. Approval gates + human-in-the-loop need custom state machine beyond framework capabilities

### Align with three open standards

1. **MCP**: Already using ✅
2. **A2A (Google Agent-to-Agent)**: Adopt for NEW-07 Phase 4 instead of designing private protocol
3. **OpenTelemetry**: Adopt for H-02 Phase 2 observability (span data model only, not full SDK)

### SDK usage strategy: "SDK manages model interaction, self-built manages domain state"

> Updated 2026-02-25 after scope audit (`meta/docs/scope-audit-phase1-2.md`)

| Layer | Responsibility | Implementation |
|-------|---------------|----------------|
| Model interaction | Message construction, token management, tool call parsing | Anthropic SDK (`@anthropic-ai/sdk`), Google Gen AI SDK |
| Agent loop | Tool dispatch, error handling, max_turns, retry | Self-built thin AgentRunner (~200 LOC TS) based on Anthropic SDK `messages.create()` |
| Domain state | Artifact management, ledger, approval gates, checkpoint | Self-built: RunManifest + StateManager + ApprovalGate |

**TS Agent Loop**: Based on Anthropic SDK. Not Mastra (too young, YC W25, unstable API).

**Python Agent Loop**: Not implementing. Python orchestrator (hep-autoresearch) is a retirement target. CLI runners (claude/gemini/codex) provide sufficient tool use loops.

### Track PydanticAI for Phase 3 evaluation (moved from Phase 5)

> Updated 2026-02-25: Moved from Phase 5 to Phase 3 to evaluate sooner.

PydanticAI's durable execution + A2A support makes it the strongest candidate if Python-side components remain active (e.g., if idea-engine TS migration is delayed). Time-boxed evaluation: spike 1 writing run on PydanticAI.

## 5. Historical Plan Impact

> Updated 2026-02-25 after scope audit. See `meta/docs/scope-audit-phase1-2.md` for full analysis.

| Phase | Item | Description |
|-------|------|-------------|
| Phase 1 | **H-19 promoted** | Retry/backoff decoupled from H-01, implemented directly on McpStdioClient. Most urgent runtime gap. |
| Phase 1 | **H-01 simplified** | Add `retryable` + `retry_after_ms` to existing McpError instead of new error envelope. |
| Phase 1 | **H-04 simplified** | Plain enum `['A1'..'A5']` + validate function. No GateSpec type (deferred to Phase 3). |
| Phase 2 | **NEW-RT-01** | Thin AgentRunner (~200 LOC TS) based on Anthropic SDK `messages.create()` + tool dispatch loop |
| Phase 2 | **NEW-RT-02** | MCP StdioClient reconnect: detect disconnect + auto-restart + recover pending calls |
| Phase 2 | **NEW-RT-03** | OTel-aligned Span tracing: span data model + JSONL writer + dispatcher integration |
| Phase 2 | **NEW-RT-04** | Durable execution: RunManifest `last_completed_step` + `resume_from` completion |
| Phase 2 (H-02) | Align structured tracing with OpenTelemetry span format (data model only, no OTel SDK) |
| Phase 3 | **NEW-RT-05** | Eval framework: agent-level end-to-end evaluation infrastructure |
| Phase 3 | PydanticAI time-boxed evaluation (moved from Phase 5) |
| Phase 4 (NEW-07) | Adopt Google A2A protocol (open standard) instead of designing private agent communication protocol |

## 6. Sources

- Claude Agent SDK: `github.com/anthropics/claude-code-sdk-python` (wraps Claude Code CLI)
- OpenAI Agents SDK: `github.com/openai/openai-agents-python` (19.1k stars, MIT)
- Google ADK: `github.com/google/adk-python` (Apache 2.0, A2A integration)
- PydanticAI: `github.com/pydantic/pydantic-ai` (by Pydantic team, durable execution + A2A + MCP)
- Strands Agents: `github.com/strands-agents/sdk-python` (AWS, model-driven, MCP native)
- LangGraph: `github.com/langchain-ai/langgraph` (graph state machine, durable checkpoints)
- AG2: `github.com/ag2ai/ag2` (ex-AutoGen, conversable agents)
- CrewAI: `github.com/crewAIInc/crewAI` (role-based crews + event-driven flows)
- Mastra: `github.com/mastra-ai/mastra` (TS-native, YC W25, graph workflow + suspend/resume)
- Crush: `github.com/charmbracelet/crush` (ex-OpenCode, Go terminal assistant, archived→Charm)
