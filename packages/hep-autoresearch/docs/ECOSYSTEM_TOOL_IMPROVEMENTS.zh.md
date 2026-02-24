# Ecosystem improvement notes（跨仓库/skills 的改进建议备忘）

本文件用于记录：在推进 `hep-autoresearch` 的过程中，我们发现的 **其他工具/skills/MCP** 的可改进点。

原则：
- 这里只做“建议备忘”，不直接修改 `~/.codex/skills/*` 或 `hep-research-mcp`（你可以在对应对话中实施）。
- 每条建议尽量指向“为什么重要（可靠性/可复现/可用性）”与“最小改动方案”。

---

## 1) review-swarm / claude-cli-runner / gemini-cli-runner

### 1.1 问题：大 prompt 触发 `Argument list too long`

现象：当评审 packet 很大（例如包含大量 TeX 快照/二进制路径的 diff）时，runner 把文件内容读进 shell 变量再作为命令行参数传递，会触发：
- `claude: Argument list too long`
- `gemini: Argument list too long`

已在本仓库绕过：`scripts/run_dual_review.py` 改为 “compact diff summary + high-signal patch excerpts”，避免把大文件 patch 送进评审包。

建议在 skills 侧做根治（更通用、更不依赖上层剪裁）：
- **claude-cli-runner**：改为使用 stdin（`--input-format text/stream-json`）喂入用户 prompt，而不是把整段 prompt 作为 CLI 参数。
- **gemini-cli-runner**：利用 gemini CLI “stdin + --prompt append”的语义，把大 prompt 从 stdin 输入，避免超长参数。
- 给 `review-swarm` 增加一个通用的 `--max-prompt-chars`（超出则 fail-fast 或写入 truncation note），让上层显式处理。

### 1.2 建议：统一“结构化评审输出”与 schema 校验

现状：我们对 dual review 采用严格 contract（VERDICT/Blockers/...），很好。

建议：
- 为 review 输出也提供 JSON schema（和本仓库 specs 一致思路），以便：
  - Orchestrator 自动提取 blockers/action items；
  - L3 自我进化把“评审结论→改进提案→新增 eval”串起来。

---

## 2) research-team / research-team-audit

### 2.1 建议：把“Plan/Plan-Updater（T29）”抽象为可复用模块

原因：T29 会成为 long-horizon/自我进化的骨架。若做成 `research-team` 的可选模块（或共享库），可在：
- 研究型项目（research-team）与 工具型项目（hep-autoresearch）之间复用；
- 并统一“任务拆分→状态→证据→回滚/消融”的语义。

### 2.2 建议：更显式的“KB index（Library/Methodology/Priors）索引导出”

原因：PhysMaster 的 LANDAU 分层语义在我们生态圈中天然存在，但需要一个统一命名的、可复用的 deterministic 导出（本项目称 KB index）。

建议：
- 给 `research-team` 增加一个 deterministic exporter：把 KB 三层的 RefKey、links、evidence pointers 导出为 JSON（供 Orchestrator / reviewer packet 自动引用）。

---

## 3) research-writer

### 3.1 建议：把“精修开关默认 ON”与 A4 gate 深度绑定（已在本仓库策略化）

原因：科研写作中，“精修”往往会改动结论表达与引文结构，必须进入 A4（paper edits）同意点。

建议：
- 在 `research-writer` 的 section drafting path 中，把 “run-card + approval token” 当成可选输入；
- 让其产物天然携带 `run.json`（已有）并对接 Orchestrator ledger（未来 adapter）。

### 3.2 建议：对外提供一个“小而稳定”的导出接口（可选 upstream）

我们在 T30 的设计里倾向：no-LLM 导出逻辑放在 `hep-autoresearch`（便于 CLI/Web 复用）。

但如果未来要 upstream 到 `research-writer`：
- 建议把它做成一个独立 deterministic subcommand（不依赖 LLM），输入为 “KB notes 列表 + citekey mapping + bibtex”，输出为 `review.tex` / `review.md`。

---

## 4) hep-calc

### 4.1 建议：与 artifacts 三件套对齐

原因：hep-calc 的计算结果如果能落到 `manifest/summary/analysis`，就能：
- 直接进入 eval suite 做回归；
- 被 W3 写作自动拉取 provenance；
- 进入 L3 evolution 做“失败→改进提案→新增测试”闭环。

最小方案：
- hep-calc 输出目录内新增 `manifest.json/summary.json/analysis.json`（哪怕是薄包装）。

### 4.2 建议：run-card 统一（输入契约）

把 hep-calc 的 job 配置与 Orchestrator run-card 对齐（字段名、版本记录、seed、外部依赖版本），减少跨工具 glue 代码。

---

## 5) deep-learning-lab

### 5.1 建议：明确“数据/模型/代码版本”的 provenance hook

原因：DL 实验最怕“跑通但不可复现”。deep-learning-lab 的结构很适合做 SSOT，但需要：
- 与 Orchestrator ledger 对齐（run-id/tag、参数、artifact pointers）。
- 支持把关键指标导出为 `summary.json`（可回归）。

---

## 6) prl-referee-review（或同类审稿工具）

### 6.1 建议：作为 W3 的外部 reviewer adapter

原因：PRL 风格审稿报告非常适合作为 W3 的 “review pass”，但应满足：
- 输出 contract（READY/NOT_READY + major/minor + required actions）。
- 落盘到 artifacts（便于后续 revision plan 与对照）。

---

## 7) hep-research-mcp

### 7.1 建议：提供“citekey resolver”稳定入口（INSPIRE recid → citekey/BibTeX）

原因：T30 要求 INSPIRE 论文必须用 INSPIRE 标准 citekey；我们在本仓库通过 W1 快照实现。

若要更强/更通用：
- MCP 可提供一个“recid → (citekey, bibtex, canonical links)”的工具接口；
- Orchestrator 优先用本地快照（离线可跑），必要时再调用 MCP 做补齐（受 A1 gate 控制）。

### 7.2 建议：把写作编排产物与 artifacts 三件套对齐

原因：MCP 的写作编排非常强，但用户最终仍需要：
- 可审计 provenance（引用/证据指针）
- 可回归（同一输入不会漂移到不可比）

建议：MCP 的写作输出同时落：
- 机器可读（JSON：outline/allowed citations/section manifests）
- 人类可读（LaTeX/MD）
并提供 “导入到 hep-autoresearch artifacts” 的最小桥接格式（或我们在本仓库做 importer）。
