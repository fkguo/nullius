# Autoresearch Lab — 立场（POSITIONING）

本文档说明 Autoresearch Lab **是什么**、**不是什么**、它**主动防御哪些 agent
失败模式**，以及**这些纪律如何被机器强制**。它补充
[`docs/README_zh.md`](./README_zh.md) §1–§3 的 surface taxonomy，覆盖非
surface 层面的保证。

[English](./POSITIONING.md) | 中文

## 1. Autoresearch Lab 是什么

一个 domain-neutral、evidence-first 的研究 monorepo，面向 **agent-assisted
research workflow**。control plane（`autoresearch` CLI + `orch_*` MCP）是
外部 project root 的长期 lifecycle 权威；provider 包与 skill 是受限算子，
由 control plane 组合。HEP 是当前最成熟的使用场景，**不是**域边界 — 见 §2。

## 2. Autoresearch Lab 不是什么

- **不是 SaaS**。状态与 artifact 留在每个外部 research project root 内，
  不放在任何远程服务上。没有订阅、没有共享后端、没有计费。state 落点见
  [`docs/README_zh.md`](./README_zh.md) §4。
- **不是研究者的替代品**。最终结论需经 A5 审批门，并对 integrity receipt
  fail-closed（gate 定义见
  [`packages/shared/src/gate-registry.ts`](../packages/shared/src/gate-registry.ts)）；
  重计算审批（A3）为 opt-in，其余检查点（A1/A2/A4）仅为 advisory。
  agent 走流程；**研究者本人判断结果是否真实**。
- **不是从一句 prompt 写出论文的工具**。`research-writer` 与 `paper-reviser`
  作用于研究者本人已有的 prose，对已 audit 的 run 收集的 evidence 操作；
  不从一个想法生成草稿。
- **不是 HEP-only**。`@autoresearch/hep-mcp` 是当前最成熟的 domain pack
  与最强的端到端示例。**按
  [`package.json`](../packages/hep-mcp/package.json) 实际依赖，它是一个
  composite**，工作区依赖中**显式包含** `@autoresearch/arxiv-mcp` 与
  `@autoresearch/openalex-mcp` —— 这两个是覆盖更广学术文献的
  domain-neutral atom。control plane 与 skill 层均 domain-neutral。"HEP"
  反映**一个使用场景的成熟度**，不是系统的域边界。
- **不是 provider 工具的再实现**。`inspire_*`、`pdg_*`、`hepdata_*`、
  `arxiv_*`、`openalex_*`、`zotero_*` 是 **evidence source**。本项目强制的
  纪律是 evidence **是否真的被查询过**，而不是 provider 本身怎么工作。
- **不是借鉴清单的盲目实现者**。若某个外部框架借鉴概念解决的是 **人类**
  失败模式（例如 reviewer 看到作者名产生 bias），而 AI agent 不具备该
  失败模式，则该概念不被 import。下面列出的 skill 与 anti-drift CI 全部
  由本项目实际 session 中观察到的 **agent** 失败模式驱动。

## 3. 项目主动防御的 agent 失败模式

### M1–M7：pre-approval 纪律

7 个反复出现的 AI 研究失败模式，记录在
[`skills/research-integrity/SKILL.md`](../skills/research-integrity/SKILL.md)：

- **M1** implementation_bug_passing_self_review
- **M2** hallucinated_citation
- **M3** hallucinated_measurement_or_result
- **M4** shortcut_reliance
- **M5** bug_as_insight
- **M6** methodology_fabrication
- **M7** frame_lock

该 skill 是 prompt-level 纪律。它的 receipt 在审批门做 **机器强制**：
`autoresearch approve` 之前必须先用
`autoresearch integrity-record --approval-id <id> --modes <Mx,...>` 写
receipt；缺少 receipt 时审批 fail-closed，返回
`INTEGRITY_RECEIPT_REQUIRED`。实现见
[`packages/shared/src/integrity-receipt.ts`](../packages/shared/src/integrity-receipt.ts)，
审批门接入点在
[`packages/orchestrator/src/orch-tools/approval.ts`](../packages/orchestrator/src/orch-tools/approval.ts)。

### 长对话漂移：harness invocation 锚点

长 session 会把 `research-harness` skill 挤出 context；项目状态与 agent
的 mental model 静默 desync。对**读或写 project-keyed state** 的工具调用
（分类按每个 `*-mcp` 包的 `state-touch-classification.ts`），每个 `*-mcp`
dispatcher 都校验 `autoresearch status` 写入的
`.autoresearch/HARNESS_INVOCATION` anchor：(a) 比
`.autoresearch/state.json` / `.autoresearch/ledger.jsonl` 的最后修改时间
新；(b) 写入时的 project_root 跟当前 cwd 一致（identity check）；(c) anchor
时间戳不是未来（clock-skew guard）。anchor 缺失/错配/未来/比 state 旧 →
fail-closed，返回 `HARNESS_INVOCATION_REQUIRED`。

校验是**事件驱动，不是时钟驱动**（与 Codex 的 `config_lock` content-equality
校验、Claude Code 的 `FileEditTool` mtime 校验同款 — 无 clock TTL）。
跳过的情形：

- 纯只读 provider query（按每个 `*-mcp` 包的 audit-backed
  `state-touch-classification.ts` 分类）；
- standalone 使用，`process.cwd()` 无 `.autoresearch/` 目录（无 lifecycle
  context）。

实现见
[`packages/shared/src/harness-invocation.ts`](../packages/shared/src/harness-invocation.ts)；
推荐的重锚流程是
[`research-harness` skill](../skills/research-harness/SKILL.md)。

## 4. 纪律如何被强制 — anti-drift CI

只活在 `SKILL.md` 里的纪律会静默腐烂。下面每条保证都有一个 CI 脚本，
discipline 一旦松动构建就失败。完整清单，全部接入
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)：

| Anti-drift 脚本 | 锁住的契约 | 捕获的漂移 |
| --- | --- | --- |
| [`check-shell-boundary-anti-drift.mjs`](../scripts/check-shell-boundary-anti-drift.mjs) | front-door 入口真理、包级 first-touch framing、shell 边界用词 | [`scripts/lib/front-door-boundary-authority.mjs`](../scripts/lib/front-door-boundary-authority.mjs) 列出的 10 个 front-door 叙述文档（`README.md`、`docs/QUICKSTART.md`、`docs/README_zh.md`、`docs/PROJECT_STATUS.md`、`docs/ARCHITECTURE.md`、`docs/TOOL_CATEGORIES.md`、`docs/TESTING_GUIDE.md`、`docs/URI_REGISTRY.md`、`meta/protocols/session_protocol_v1.md`、`meta/docs/orchestrator-mcp-tools-spec.md`）的边界叙述漂移。AGENTS.md/CLAUDE.md 的 byte-sync 由下一行的 `check-governance-sync.mjs` 负责，**不**由本行负责。 |
| [`check-atomic-write-anti-drift.mjs`](../scripts/check-atomic-write-anti-drift.mjs) | 生产代码无裸 `fs.writeFileSync` / `renameSync` / `appendFileSync`（含 `fs.promises.*`） | 写到一半 crash 导致的 torn write 数据损失 |
| [`check-governance-sync.mjs`](../scripts/check-governance-sync.mjs) | `AGENTS.md` ↔ `CLAUDE.md` governance 段 byte-identical | 双镜像文件治理段漂移 |
| [`check-harness-invocation-anti-drift.mjs`](../scripts/check-harness-invocation-anti-drift.mjs) | 每个 `*-mcp` dispatcher 都 import + 调用 `verifyHarnessInvocationMarker` | 长对话漂移；新 MCP 加进来但没接 anchor enforcement |
| [`check-integrity-receipt-anti-drift.mjs`](../scripts/check-integrity-receipt-anti-drift.mjs) | 每个审批门 handler 都 import + 调用 `verifyIntegrityReceipt` | M1–M7 纪律静默跳过；approve 时没 receipt |
| [`check-skill-tool-name-anti-drift.mjs`](../scripts/check-skill-tool-name-anti-drift.mjs) | `SKILL.md` 中出现的工具名都对得上 tool-name 注册表 | provider 工具改名而 skill prose 未跟随 |
| `pnpm codegen:check` | `packages/shared/src/generated/` 与 `meta/generated/` 与 JSON schemas 一致 | 手改生成代码 vs schema 漂移 |

这些在每个 PR 上都跑。lint 失败被当作 feature 失败处理：修复方式是恢复
纪律，不是把检查放宽。

## 5. 以 agent 身份阅读本仓库

如果你是在本仓库工作的 agent，或被 `research-harness` 驱动到外部 project
root 上：

- **按代码读 surface，不按名字读**。包名（例如 `hep-mcp`）**不**决定其域
  范围。在断言一个包做什么之前，先检查 `package.json` 的 deps 与实际
  `import` 关系。工具名同样 — 先打开 handler 再判断它干什么。
- **审批前走 M1–M7**。漏掉这一步意味着
  `.autoresearch/integrity_log.jsonl` 中没有对应 receipt，审批门
  fail-closed。恢复方式是重新走一遍 M1–M7 + 重写 receipt，latest 胜。
- **anti-drift CI 失败 = 纪律失败**。修复方式是恢复被破坏的契约，**不是**
  放宽 lint。

## 6. 故意不在 backlog 里的设计

两个借鉴概念在 2026-05-22 的 audit pass 中被考虑、scope 后明确丢弃。
记录于此防止未来 agent 静默重提：

- **没有 data-access-level / identity-blinding tier**。author identity
  blinding 解决的是 **人类** reviewer bias 问题；AI agent 没有同款 bias，
  且 M2 验证恰恰**要求** agent 看到作者身份。借鉴概念在 agent-assisted
  系统里是错的框架 — 不是 "defer 等 consumer"，是**框架本身不适用**。
- **没有"把 hep-mcp 里的 generic primitive 回溯迁移到 shared"**。
  `hep-mcp` 在设计上就是 composite（依赖 `arxiv-mcp` 与 `openalex-mcp`，
  见 §2）。external-API cache 与 budget/warning diagnostics 等 primitive
  支撑这一 composite 角色，**不**预先迁移到 `@autoresearch/shared`。
  只有真实第二消费者请求时才迁。投机性的 "先搬过去 just in case" 不做。

这两条不是 "稍后做"，是 **closed scope**。若未来证据显示有真实问题恰好
是其中一种模式能解决，那项工作以**新的 motivating consumer + 新的设计**
重新立项，**不**沿用被驳回的框架。
