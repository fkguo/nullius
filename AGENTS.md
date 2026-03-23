# Autoresearch Ecosystem — Agent Context

> 本文件为 AI agent 提供跨会话持久上下文。修改本文件需经 `meta/` 治理流程。

## 根级入口与本地工具文件

- `AGENTS.md` 是仓库级 agent 规则的唯一 SSOT；这里的人类编写治理规则仍是根级唯一权威来源。
- 根目录 `CLAUDE.md` 仍是兼容旧 prompt / 旧工具发现逻辑的稳定 shim；根级不在其中维护第二套人类编写规则。
- GitNexus generated appendix 允许进入根 `AGENTS.md` 与根 `CLAUDE.md` 的提交面；该 appendix 属于工具生成上下文而非根级治理 SSOT，可随 `npx gitnexus analyze` 漂移并与业务改动一同提交。
- `.serena/project.yml` 是单机 / 单 worktree 的本地 Serena 配置，故意不纳入 Git 跟踪；仓库模板固定为 `.serena/project.example.yml`。
- `.serena/memories/architecture-decisions.md` 是仓库内唯一允许纳入 Git 跟踪的 Serena memory；其余 `.serena/memories/**` 默认视为本地工作笔记，不得作为治理 SSOT。
- 需要跨会话/跨 worktree 保留的 Serena 结论，必须先提炼并写入 `.serena/memories/architecture-decisions.md`（或其他已跟踪 SSOT）后，才可依赖；未提炼的本地 memory 只可作为临时参考。
- 若旧文档要求“读取根 `CLAUDE.md`”，应解释为：先读 `AGENTS.md`，再读根 `CLAUDE.md` shim，最后按作用域读更具体的 `packages/*/CLAUDE.md` / `AGENTS.md`。

## 根工作区附加规则

- **无向后兼容负担**：生态圈尚未正式发布、无外部用户；默认允许直接 breaking change，不需要为旧 API / 旧 schema / 旧数据保留 shim、迁移脚本或兼容矩阵。
- **禁止临时性/阶段性命名**：不要引入 `vNext`、`v2`、`new_`、`legacy_`、`old_` 等过渡性命名；直接使用面向功能的永久命名。
- **禁止不透明历史前缀命名进入新抽象**：`W1/W2/W3/W4/W_*` 这类依赖历史上下文才能理解的阶段号/工作流前缀，不应继续进入新的 root governance、shared contracts、user-facing workflow ids 或长期保留的核心抽象；新命名应直接表达语义（如 `ingest`、`reproduce`、`revision`、`computation`）。
- **Commit 消息不加 AI co-author**：若未来得到人类授权执行 `git commit`，不要在提交消息中写 `Co-Authored-By: Claude ...` 或类似 AI 标注。
- **SOTA 原则**：凡涉及架构选择、LLM 能力判断、retrieval/reranking/evidence 策略或“某功能是否仍有价值”的判断，应优先基于最新论文、benchmark、最佳实践和竞品动态，而不是仅凭过期记忆。
- **真实研究项目必须使用开发仓外部 project root**：面向真实研究工作的 public scaffold/init surface，必须 fail-closed 到仓外绝对路径；`/home/user/Coding/Agents/autoresearch-lab` 及其子目录不得再作为 real-project authority。
- **真实研究中间产物不得回流开发仓**：real-project 的 team runs、planning/intermediate outputs、显式/env provider data dirs 等运行期输出，默认必须落在开发仓外；repo 内 gitignored 目录只能作为显式 maintainer fixture，不得被 public flow 静默复用成 real-project 输出面。
- **repo 内 maintainer fixture 仅限显式 gitignored 工作区**：如 `skills/research-team/skilldev`、`skills/research-team/.tmp/` 这类 maintainer workspaces 只用于自演进/回归/快照，不得注册、文档化或包装成真实研究项目入口。

## 理论研究通用内核约束

- **Core 必须 domain-neutral**：`autoresearch` 的目标是面向理论研究的通用 substrate / control plane，而非任何单一学科、单一子领域或单一工具链的专用自动化器。当前以高能物理（尤其 hep-th）为首个高优先级落地方向，但这不是 scope 上限；后续应可扩展到其他理论物理方向及数学等理论研究方向。
- **HEP-first 不等于 HEP-locked**：HEP 特定的 prompts、heuristics、package/tool mappings、工作流偏好与数据源假设，必须下沉到对应 domain pack / provider；禁止把这些假设固化进 root governance、shared contracts、orchestrator 内核或跨领域共享抽象。
- **领域分类必须准确**：shared/generic 层可使用真实 domain/category 标签（如 `hep-th`、`cond-mat`、`mathematics`）作为示例或 pack 标识，但不得误写其学科归属，也不得把任何单一 domain 表述为 core 的默认推荐值。
- **Compute 按 task/capability-first 建模**：计算/推导/验证运行时应优先表达研究任务类型、能力需求、artifact/evidence/provenance 契约与审批边界；package 名称、后端名称与现有工具链只可作为开放示例或 provider 实现，不得成为封闭枚举、唯一执行路径或 scope 边界。
- **项目定边界，LLM 填内容**：仓库负责 typed contracts、approval/policy、artifact/evidence/provenance 语义、审计与可复现边界；具体问题的 decomposition、方法选择、backend 组合、参数化与 fallback 默认由 runtime LLM / agent 在这些治理边界内决定。
- **只把稳定不变量写入 SSOT**：根级治理文本、长期 schema 与 tracker note 只应固定长期稳定的架构不变量；会随具体课题变化的 planning heuristics、prompt tactics、临时工具清单或局部最优策略，不应上升为根级治理规则。

## 生态圈概览

Autoresearch 是一个 evidence-first 的理论研究 substrate / control plane。根目录承担 ecosystem workbench / governance 入口；运行时、provider、shared contracts 与 domain-pack 相关实现主要位于 `packages/`，checked-in 治理与 closeout 文档主要位于 `meta/`。

## 组件清单

- `packages/orchestrator/` 是长期 control-plane / runtime 收束方向；`packages/hep-autoresearch/`（含 `hepar` / `hep-autoresearch` CLI）是仍可用但计划退役的 Pipeline A Python control-plane / CLI surface。除非后续有明确 repoint 决策，否则 `hep-autoresearch` 与 `hepar` 的 retirement semantics 一起移动，不应一个被视为现役、另一个被视为已退役。
- `packages/orchestrator/` 是 workspace 源码目录，而 `@autoresearch/orchestrator` 是同一包的 workspace package surface；下游 host 必须消费该包导出而不是复制 generic orchestrator authority，本仓对这条边界的主要反漂移手段是 `build + host-path contract`，而不是维持两套实现。
- `packages/shared/`：provider-neutral contracts、types、shared helpers。
- `packages/*-mcp/`、`packages/agent-arxiv/`、`packages/idea-*`：provider、adapter、idea、runtime 相关实现；HEP 是当前优先 domain pack，但不是 core scope 边界。
- `skills/`、`packages/skills-market/`：checked-in skill workflows 与分发面。
- `meta/`：contract、redesign plan、tracker、prompt/docs、review-support artifacts。
- 根级路径以当前工作区实际目录为准；不要把拆仓时期的旧 repo 名、旧目录名或旧 LOC 统计继续当作治理 authority。

## 关键架构决策

- 根级只保留稳定不变量与硬门禁；跨会话可复用的架构结论集中在 `.serena/memories/architecture-decisions.md`。
- 当前仍有效的根级方向是：TS-first control plane 收束、evidence-first I/O、contract-first shared types、fail-closed approval gates、provider-owned concrete authority 下沉到 leaf packages。
- `meta/schemas/` 是 checked-in shared schema authority；具体迁移阶段、item closeout、历史决策脉络以 `meta/remediation_tracker_v1.json`、`meta/REDESIGN_PLAN.md` 与相关 checked-in prompts/docs 为准，不在本文件重述长历史。

## 治理文档 (`meta/`)

- `meta/ECOSYSTEM_DEV_CONTRACT.md`：normative contract / fail-closed 规则 SSOT。
- `meta/REDESIGN_PLAN.md`：phase ordering、batch intent、acceptance checklist source。
- `meta/remediation_tracker_v1.json`：machine-readable item status、closeout evidence、review disposition。
- `meta/docs/**`：checked-in design memos、implementation prompts、closeout support docs。
- `.serena/memories/architecture-decisions.md`：稳定的跨会话架构决策；不承载执行流水和逐轮历史。

## 长期愿景

长期方向仍是面向理论研究的多 agent / 多项目基础设施，但根级治理只固定 sequencing-relevant invariants，不在此处维护长篇愿景叙事。

- `single-user` 指单一治理人类 owner，不等于 `single-agent`。
- `NEW-LOOP-01` 单项目 substrate 必须先于 `EVO-13` 多 agent runtime 稳定；`P5A` 先于 `P5B`。
- 详细愿景与设计 memo 以 `packages/hep-autoresearch/docs/VISION.zh.md`、`meta/docs/2026-03-07-evo13-single-project-multi-agent-runtime-memo.md`、`meta/docs/2026-03-08-evo13-runtime-governance-control-plane-amendment.md` 为准。

## Phase 结构

- Phase 定义、item inventory、batch 依赖与执行顺序以 `meta/REDESIGN_PLAN.md` 和 tracker 为准；AGENTS 不镜像 item 总数、条目清单或逐 phase 叙事。
- 这里仅保留稳定读取规则：早期 phase gate 后期 phase；`NEW-LOOP-01` 先于 `EVO-13`；`P5A` 先于 `P5B`。
- 当前完成度只在 `当前进度` 做摘要，其余 item-level truth 以 `meta/remediation_tracker_v1.json` 为准。

## Contract 规则域

`ERR`、`ID`、`SYNC`、`CFG`、`GATE`、`LOG`、`ART`、`SEC`、`NET`、`RES`、`MIG`、`REL`、`CODE`、`LANG`、`PLUG` 这些 rule-family 简写仍可能出现在 prompt、tests 与 review artifacts 中。

规则正文、fail-open / fail-closed 语义与条目计数只以 `meta/ECOSYSTEM_DEV_CONTRACT.md` 为准；根级 AGENTS 不重复维护第二套 contract 文本。

## 三模型审核流程

自 2026-03-08 起，所有重大文档变更与实现 closeout 默认采用三模型独立审核：`Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(zhipuai-coding-plan/glm-5)`。若其中任一模型本地不可用，必须记录失败原因并由人类明确确认 fallback reviewer；禁止静默降级。审核产物存放在 `meta/.review/`（已 gitignore）。

### 触发条件

- 跨组件架构变更（影响 ≥2 个组件的接口/契约）
- Contract 规则新增或修改
- REDESIGN_PLAN Phase 级别变更（项移动、新增、删除）
- 不可逆操作方案（monorepo 迁移、schema 破坏性变更）

单组件内部修改、bug fix、文档 typo 等**不需要**正式三模型审核。

### 收敛判定规则

1. 三个模型独立审核，输出 strict JSON（含 `verdict`, `blocking_issues`, `amendments`）
2. **CONVERGED**: 三个模型均 0 blocking issues → 方案通过
3. **CONVERGED_WITH_AMENDMENTS**: 0 blocking + 非阻塞修正建议 → 方案通过；凡当前 batch 直接相关、高价值、低风险、可独立验证且不依赖后续 phase / lane 的 amendments，默认必须本轮吸收。仅当 amendment 属于 lane 外工作、依赖后续 phase / lane（或当前 batch 之外的后续工作）、属于 pre-existing unrelated debt、需要人类架构裁决、或修复风险明显大于收益时，才允许 deferred；仅仍有后续价值的 deferred 项必须同步到持久 SSOT（至少 `meta/remediation_tracker_v1.json` 条目或 checked-in 的后续 prompt 文件），临时 chat prompt、review/self-review 输出与 scratch notes 不算 SSOT，禁止只留在这些临时产物中。低价值或已判定不值得跟进的 non-blocking amendments 应记录为 declined/closed，而非 deferred。
   前提：reviewer / self-review 已显式复核该项为何不推翻 packet 前提、shared entrypoint closeout 或 authority completeness judgment；否则不得按 unrelated debt deferred。
4. **NOT_CONVERGED**: 任一模型有 blocking issue → 必须修正后重新提交下一轮 (R+1)
5. **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入决策
6. 每轮 prompt 必须包含：上一轮三模型的完整输出 + 已采纳/未采纳修正及理由
7. **正式 blocking judgment 必须源码级**：正式 reviewer 与 `self-review` 的 blocking / 0-blocking 结论，必须基于实际源码、真实调用链、tests / acceptance 证据与 scope boundary；`diff-only`、packet-only、或只看摘要的审查只能作为补充意见，不能单独充当 closeout gate。

### 审核输出 JSON schema

```json
{
  "verdict": "CONVERGED | CONVERGED_WITH_AMENDMENTS | NOT_CONVERGED",
  "blocking_issues": ["..."],
  "amendments": [{"target": "...", "section": "...", "change": "..."}],
  "positive_findings": ["..."]
}
```

### 执行方式

使用 `claude-cli-runner`、`gemini-cli-runner` 与 `opencode-cli-runner` skills 并行执行。默认 reviewer 固定为 `Opus`、`Gemini-3.1-Pro-Preview` 与 `OpenCode(zhipuai-coding-plan/glm-5)`；prompt 文件存放在 `meta/.review/` 目录。

- reviewer 可以调用其 provider / CLI 内部可用的 agents、sub-agents、search / code-navigation / tool-use 能力来完成审查，但**最终 verdict 仍归属于顶层 reviewer**；不得把“内部 agent 的结论”当作无需复核的黑箱 authority。
- 若 reviewer backend 无法读取本地源码或无法形成 source-grounded judgment，则该 reviewer 只能作为 supplemental reviewer；除非人类明确批准 fallback，否则不得用其单独承担 blocking / 0-blocking gate。
- review packet 只负责提供范围、文件列表、验收命令、GitNexus 证据与上一轮结论；不得把 packet 本身当成权威来源，也不得因为 packet 精简就退化为 `git diff` 摘要审查。
- **正式源码审查默认按受影响包组包**：reviewer 默认至少应看到 `affected package(s)` 的源码，以及形成 source-grounded judgment 所需的相邻 shared / adapter / entrypoint / acceptance-test surface；禁止把输入缩到 only changed files / `git diff`，也不要求默认暴露整个 monorepo。只有当 blast radius 已跨越多数 package，或 reviewer 明确说明需要更大范围源码才能完成 blocking judgment 时，才扩大到更广仓级上下文。
- 审核健康度定义与红线统一见 `meta/docs/review-health-metrics.md`；根级 AGENTS 不重复维护第二套指标说明，但 formal closeout 的持久 SSOT 应按该文档记录最小 review-health telemetry。

## Superpowers 使用约定

- **默认不使用 `superpowers` 通用 skills 作为执行依据**。本仓库的权威执行依据始终是：`AGENTS.md`、batch prompt、`meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md`、GitNexus 证据、`review-swarm` 与 `self-review` 门禁。
- **默认直接在主仓 `main` worktree 工作**；只有当存在并行 lane、需要隔离未收敛实现、或人类明确要求保留独立工作区时，才创建与主仓平行的本地 `worktree`（例如 `/home/user/Coding/Agents/autoresearch-lab-<branch-or-batch>`）；除非人类明确要求，否则不默认使用 `~/.config/superpowers/worktrees/...`。
- **通用 skill 不得覆盖项目级硬门禁**：不得覆盖实现 prompt、GitNexus freshness / post-change evidence、正式 `review-swarm`、正式 `self-review`、tracker / memory / `AGENTS.md` 同步、以及版本控制门禁。
- 若某个通用 skill 与本仓库规则冲突，**一律以本仓库规则为准**；必要时直接忽略该 skill 的默认建议。

## Agent 执行纪律

### 全盘思考要求

执行任何修复项前，agent 必须：

1. **读取 AGENTS.md + tracker JSON** — 了解全局进度和依赖关系
2. **读取目标项在 REDESIGN_PLAN.md 中的完整描述** — 包括修改文件、验收检查点、依赖项
3. **检查 ECOSYSTEM_DEV_CONTRACT.md 中相关规则** — 确保修改不违反 fail-closed 规则
4. **检查是否有下游依赖项会受影响** — 在 tracker 中查看 blocked-by 关系

禁止"只看当前文件就动手改"的行为。

### 深度验证要求

- 每次修改后必须运行该项的验收检查点命令（PLAN 中列出的 pytest/lint/CI 命令）
- 如果验收命令不存在（尚未创建），必须先创建再验证
- 禁止仅凭"看起来对了"就标记完成
- 网络搜索：如果 WebFetch 失败，使用 `curl --proxy` 或直接 `curl` 重试

### 语义/领域清理硬要求

- 删除、降级或上提 `domain heuristics`、`taxonomy`、`classifier`、`lexicon`、`validator` 前，必须先追踪其完整调用链到 registry / schema / public output / tests / eval fixtures / baseline / docs 与 plan 叙事；禁止仅凭命名、局部 grep 或少量代码片段判断其应删/应留。
- 必须区分 `provider-local fail-open prior` 与 `active authority`：前者只能是带 provenance 的 fallback / diagnostic，后者一旦仍在决定 public output、grouping、scoring、gating 或默认 worldview，就必须按 authority 泄漏处理。
- 真正的问题不是出现 HEP/domain 术语本身，而是让不完整的闭合枚举或 keyword buckets 充当 authority；禁止把这类实现仅做改名后继续留在 generic/shared/core，也禁止把它们只改称 `diagnostic` / `fallback` 却仍保留同一 authority call-path。
- 凡涉及质量/架构取舍，必须做 SOTA preflight 并记录 primary-source 依据；禁止因为历史包袱保留已知会限制质量的 heuristic authority。

### Implementation Prompt 硬门禁

> 适用于 `meta/docs/prompts/prompt-*-impl-*.md` 以及任何要求"按之前惯例执行"的实现任务。通用 checklist 见 `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md`。

- **GitNexus 开工前对齐是硬要求**：实现前必须先读 `gitnexus://repo/{name}/context`；若 index stale，先运行 `npx gitnexus analyze`，再继续。若当前 `worktree` 含未提交改动（尤其新增文件 / 新符号 / helper callsites），默认必须改用 `npx gitnexus analyze --force` 刷新当前工作树覆盖，而不能把普通 `analyze` 的 `up to date` 视为当前源码已入图的证据。禁止带 stale index 开工。
- **本仓 GitNexus generated appendix 约束**：当前 GitNexus 版本会无条件向根 `AGENTS.md` / `CLAUDE.md` upsert 动态 marker；本仓接受这些 generated appendix 进入提交面，但应将其视为非 SSOT 的工具生成上下文，不在 marker block 内手写根级治理规则。
- **GitNexus 审核前再对齐是条件性硬要求**：若实现新增/重命名符号、改变关键调用链、或当前 index 已不反映工作树，必须在正式审核前再次刷新；dirty `worktree` 默认使用 `npx gitnexus analyze --force`。刷新后再用 `detect_changes` / `impact` / `context` 形成 post-change 证据。
- **正式 `review-swarm` 为实现收尾必经步骤**：实现 prompt 默认必须在验收命令通过后执行正式三审（`Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(zhipuai-coding-plan/glm-5)`）；审核必须深入代码、调用链、测试、eval fixture、baseline、scope boundary，禁止只看 diff 摘要做表面判断。
- **正式审核必须源码级且可借助内部 agents**：允许 reviewer 调用其内部 agents / sub-agents / tool-use 来读源码、追踪调用链和检查 acceptance，但最终 blocking judgment 必须由顶层 reviewer 基于真实源码与证据作出；若某 reviewer 只能看 packet / diff / 摘要，则其结论只能作为补充，不得单独放行。
- **正式 review packet / snapshot 默认按 affected package scope 准备**：除非 blast radius 已跨越多数 package 或 reviewer 明确要求更广上下文，正式审核输入默认至少覆盖修改所在 package、其直接受影响的相邻 package surface，以及相关 shared contract / schema / entrypoint / acceptance tests；不得退化为 changed-files-only，也不要无差别整仓投喂造成高噪音审查。
- **正式审核必须反审 packet 前提**：review packet / review system 只是审查输入，不是权威来源。reviewer 必须显式检查 packet 中关于“已收口 / 已锁定 / pre-existing unrelated debt / out of scope”的分类是否成立；shared entrypoint 或 canonical acceptance failure 默认先视为 packet assumption breach，而不是自动降级为 lane 外 debt，除非 reviewer 给出基于源码与验收证据的反证。
- **authority migration 必须审完整性，不只审命名**：凡任务涉及 shared/canonical authority 迁移、template sync、contract authority 上提/下沉，review 与 self-review 都必须至少核对 `authority map -> concrete artifact/template`、`artifact/template -> authority map`、`no inline duplicate authority left`、`shared entrypoint acceptance still passes` 四项；禁止只因为常量、命名、局部 tests 已更新就判定 closeout。
- **正式自审 (`self-review`) 也是实现收尾硬门禁**：外部三审收敛后，当前执行 agent 仍必须基于实际代码、调用链 / GitNexus 证据、tests / eval / holdout / baseline、scope boundary 再做一轮自审；blocking issue 必须先修复。自审结论与 adopted / deferred / declined/closed dispositions 必须记录，并明确哪些 amendment 因满足“当前 batch 直接相关 + 高价值 + 低风险 + 可独立验证 + 不依赖后续 phase / lane”而被本轮默认吸收；deferred 项必须给出合法理由，并把仍有后续价值的项同步到持久 SSOT；低价值或已判定不值得跟进的项应标记为 declined/closed，而非 deferred。
- **历史遗留隐患不得潜伏**：若在实现、验收、review-swarm、self-review 或 host-path acceptance 中识别到会影响 shared entrypoint、package surface、build artifact、generated output、authority completeness、anti-drift 可信度或其他可复现验收可信度的历史遗留隐患，必须在本轮二选一处理：要么作为当前 batch 直接相关且低风险/可独立验证的修复顺手解决；要么在 closeout 前把它登记为明确命名的下一批/后续 cleanup slice，并同步到持久 SSOT（至少 tracker 条目或 checked-in prompt）。禁止只在聊天、临时 review 产物或口头总结里提及后继续让其潜伏。
- **完成态门禁**：只有当验收命令通过、`review-swarm` 收敛且三审 `blocking_issues = 0`、`self-review` 通过、tracker / memory / `AGENTS.md` 已同步，并且已显式完成 `meta/remediation_tracker_v1.json` + `meta/REDESIGN_PLAN.md` + 当前代码/测试事实的三方对齐检查后，实施项才可标记 `done`。若任一已有 item / batch / lane 的状态、完成态标题、batch 表、当前现状、验收勾选、closeout 叙事或统计与当前实现/测试事实不一致，必须先修正文档与 tracker，才允许标 `done`。
- **tracker + `REDESIGN_PLAN.md` 对齐代码事实是显式硬门禁**：每次实现收尾都必须把 `meta/remediation_tracker_v1.json` 与 `meta/REDESIGN_PLAN.md` 一并对齐到当前代码/测试/acceptance 事实，而不是只做“文档同步动作”。只要本轮 closeout 会让 tracker 条目状态/notes，或 `meta/REDESIGN_PLAN.md` 中任一已有 item / batch / lane 的进度复选框、batch 分层表、完成态标题、当前现状描述、验收勾选、closeout 叙事或统计变得过时，就必须在同轮修正；不得以“phase 边界没变”“tracker / prompt 已记录”或“代码已经合了”作为跳过理由。只有在已逐段检查相关 tracker/plan 区域并确认其与当前代码事实一致时，才允许写明“已检查，无需更新”。
- **版本控制门禁**：`git commit` / `git push` 仍需人类在当前任务中明确授权；若已授权，也只能在上述完成态门禁满足后执行，并在 push 前确认工作树只包含本批应交付内容。若同批次的 canonical implementation prompt 文件（即应被 checked in 的 prompt）已在当前 `worktree` 存在但尚未入库，默认视为本批交付内容，必须与实现同次 commit 提交，除非人类明确排除或该文件并非本批 canonical prompt（详见 `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md` §6）。`meta/.review/` 审核产物保持 gitignored，不进入提交。
- **收敛后的 merge / worktree cleanup 也是条件化门禁**：若人类在当前任务中明确授权把已收敛 batch 合入 `main` 并清理该 batch `worktree`，默认应在同轮完成，但只有在 completion + commit 门禁满足、目标分支状态已复核、且先完成既有 Serena memory / SOTA preflight 迁移门禁后才允许执行；若 merge conflict、目标分支出现非预期脏改动、或任一清理前门禁未满足，必须停止并记录原因，禁止半清理状态。
- **worktree 清理前 Serena memory 迁移是硬门禁**：删除任何非主 `worktree`（含 `git worktree remove` 或等价目录清理）前，必须先盘点该 `worktree` 下的 `.serena/memories/`；可复用的长期结论迁入并提交 `.serena/memories/architecture-decisions.md`，仅本地保留但对后续开发仍有帮助的记忆复制到保留的目标 `worktree` 的 `.serena/memories/`，只有临时 scratch / cache / 不可复用思路才允许随 `worktree` 删除。未完成迁移前不得清理 `worktree`。
- **worktree 清理前 SOTA preflight 迁档也是硬门禁**：删除任何非主 `worktree` 前，必须盘点该 `worktree` 下本轮实现产出的 SOTA 调查材料（至少包括 `.tmp/*sota-preflight*`、`.tmp/**/*sota-preflight*` 与 prompt 明示要求的 preflight 文件）。有复用价值的原始调查必须迁入稳定本地 archive（默认 `~/.autoresearch-lab-dev/sota-preflight/<YYYY-MM-DD>/<item-id>/`），而不是随 `worktree` 一起删除；archive 至少应包含 `preflight.md`、`summary.md`、`manifest.json`（或等价元数据），记录 prompt 路径、来源 URL / 文献、批次 / item、以及已提炼到哪些 checked-in SSOT。该本地 archive 不是治理 SSOT；真正影响后续实现约束的稳定结论仍必须提炼并写入 `.serena/memories/architecture-decisions.md` 或其他已跟踪 SSOT。未完成迁档前不得清理 `worktree`。

### Tracker 更新协议

- 开始工作前：`status: "in_progress"`, `assignee: "opus-4.6"` (或实际模型)
- 完成并验证后：`status: "done"`, 附 commit hash
- 遇到阻塞：`status: "blocked"`, 附原因
- 每次更新 tracker 后，不仅要同步更新 AGENTS.md 当前进度摘要，还必须基于当前源码 / tests / acceptance 证据复核 tracker 本身是否准确反映实现事实；若 tracker 状态、note、closeout 证据或依赖叙事落后于代码，必须同轮修正。
- 若该条目或其 batch / lane 已在 `meta/REDESIGN_PLAN.md` 中出现进度复选框、batch 表、完成态标题、当前现状、验收勾选或统计，则同轮必须继续核对并更新 `meta/REDESIGN_PLAN.md`，确保其与 tracker 和当前代码事实一致；若无变更，也必须在 closeout 说明里显式写明“已检查，tracker / REDESIGN_PLAN 与代码事实一致，无需进一步更新”。

## 代码质量强制规则

### 模块化强制 (Modular Code Enforcement)

1. **200 LOC 硬限制**: 单文件不得超过 200 行有效代码（不含空行和注释）。超过时必须拆分。
2. **单一职责 (SRP)**: 一个文件 = 一个职责。禁止在同一文件中混合不相关逻辑。
3. **禁止万能文件名**: 以下文件名禁止作为业务逻辑容器：`utils.ts`, `helpers.ts`, `common.ts`, `service.ts`, `misc.ts`, `utils.py`, `helpers.py`, `common.py`。如需工具函数，按功能域命名（如 `string-utils.ts`, `path-helpers.ts`）。
4. **入口文件仅做 re-export**: `index.ts` / `__init__.py` 仅用于 re-export，禁止包含业务逻辑。
5. **新增文件前先检查**: 创建新文件前必须确认没有已存在的文件可以承载该功能。

### 任务管理纪律 (Task Management Discipline)

- 多步骤任务（≥3 步）必须先创建 task list，逐项标记进度
- 禁止"一口气做完再汇报"——每完成一个子步骤立即更新状态
- 遇到阻塞时立即记录原因，不得静默跳过
- **对话切换提醒义务**：若下一步明显更适合在新对话执行（如切换到新的 implementation batch / prompt、需要新的 archive-first SOTA preflight、formal review packet、或当前对话已积累大量与下一步无关的调试/审查上下文），agent 必须主动提醒人类“建议新开对话”，并提供一段可直接复制的启动指令；若继续当前对话不会明显损害质量，则可继续，无需机械切换。

### 规划先行 (Planning-Before-Implementation)

- 非平凡修改（影响 ≥2 文件或 ≥50 行变更）必须先输出修改计划，再动手
- 计划必须包含：影响文件列表、变更摘要、验收条件
- 禁止"边想边改"——计划确认后方可执行

### 硬性禁止 (Hard Blocks)

以下行为绝对禁止，无豁免：

- **类型安全逃逸**: `as any`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore` — 禁止
- **未读即改**: 对未读取的代码进行推测性修改 — 禁止
- **静默吞错**: 空 catch 块 `catch(e) {}` / `except: pass` — 禁止
- **删测试过关**: 删除失败测试以"通过"CI — 禁止
- **破窗离场**: 修改后留下编译错误或测试失败 — 禁止
- **未经请求提交**: 未经人类明确要求执行 `git commit` — 禁止

### Fallback / Authority Discipline

- 默认只保留一条主实现路径；禁止因“也许以后会失败”而预先堆第二条 fallback 路径。
- 只有在以下任一成立时，才允许新增 fallback：现有 checked-in contract / public surface 明确要求兼容；已有可复现失败模式（tests、fixtures、历史 artifacts、provider / host boundary）证明主路径单独不足；或外部边界天然不稳定，且 fallback 只是边界适配而非新的业务 authority。
- 当已存在明确质量最优的主路径，且不存在可复现 blocker、现有 contract 要求或用户明确要求时，禁止在规划、建议、closeout 或执行引导中主动提供次优 fallback / 备用路径；“给用户留余地”不是默认理由。
- fallback 不得成为第二套 authority：shared/core/canonical path 只能有一个决定性语义来源；fallback 只能是带 provenance 的边界降级、diagnostic 或 fail-closed 保护。
- 每个新增 fallback 都必须有对应失败模式的测试/fixture，且行为可观测（error code、log、diagnostic）；禁止静默吞掉错误后猜测性继续执行。
- 若说不清“它防的具体失败是什么、哪条测试覆盖它、为什么不能直接收紧主路径”，就不要加入这条 fallback。

### 反模式检测 (Anti-Patterns)

Agent 在代码审查和自检时必须检测以下反模式：

- **过度工程**: 为假设性未来需求添加抽象层、配置项、feature flag
- **范围蔓延**: 修 bug 时顺手重构周边代码、添加不相关功能
- **兜底蔓延**: 针对未复现失败模式预埋 fallback、兼容分支或第二实现路径；无真实 contract / fixture / 边界依据时，优先收紧主路径而不是追加保底代码
- **元工作蔓延**: 主动新增治理层、模板层、流程层或额外 SSOT，除非其满足至少一项：直接 unblock 当前 batch；现有 SSOT 已被证明不足；已出现重复执行漂移且该补充能以最小成本稳定消除漂移。否则默认沿用现有 SSOT，不新增元工作
- **历史债务不可口头漂移**: 一旦当前实现实际暴露出具体的历史遗留风险，禁止把它只留在“以后再说”的口头结论中；若不当场修复，就必须落到可追踪的 cleanup slice / tracker / checked-in prompt。
- **AI 注释泛滥**: 添加 `// This function does X` 等显而易见的注释
- **不必要的依赖**: 为可用 3 行代码解决的问题引入新库

### 意图分类 (Intent Classification)

| 意图类型 | 特征 | 策略 |
|---|---|---|
| 平凡 | 单文件, <10 行, 明显修复 | 快速确认→直接执行，不需规划 |
| 简单 | 1-2 文件, 明确范围 | 轻量问询→提出方案→执行 |
| 重构 | 改变结构但保持行为 | 安全优先：先映射引用→确认测试覆盖→逐步修改 |
| 新建 | 新功能/模块 | 发现优先：先探索现有模式→匹配约定→再动手 |
| 架构 | 跨组件设计决策 | 战略优先：全局影响评估→三模型审核→方可执行 |

### 代码质量标准

- 严格遵循现有代码库的模式和风格
- 错误处理不需要被要求就应正确实现
- 不产生 "AI slop"（过度工程、不必要抽象、范围蔓延）
- 注释仅在逻辑不自明时添加

## 模型选择规则

- 模型选择由人类手动切换（`/model` 或 settings.json）；agent 可建议切换，但不自动切换。
- 高风险跨组件实现、架构决策、正式 `review-swarm` 与深度 self-review，优先使用最强可用推理模型，并保持跨厂商 reviewer 组合。
- 单组件日常开发、局部文档修订、边界明确的低风险任务，可优先使用更快/更低成本模型。
- 超长上下文分析优先最长上下文模型；代码审查或结构化 diff 审查优先代码专精模型；但都不得覆盖正式 reviewer lineup 规则。
- 默认正式 reviewer trio 为 `Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(zhipuai-coding-plan/glm-5)`；若任一不可用，必须记录失败原因并获得人类明确确认 fallback。
- Benchmark 分数、价格、上下文窗口、厂商成熟度等时效性信息属于 SOTA/preflight 或 review packet 证据，不是 AGENTS-level SSOT。

## 当前进度

> **SSOT**: `meta/remediation_tracker_v1.json`（机器可读 closeout / evidence / review disposition）
> **Stable memory**: `.serena/memories/architecture-decisions.md`（仅记录跨会话、可复用的稳定架构决策）

- 本节只保留 tracker 对齐的摘要；item 级 closeout 叙事、review 轮次、精确验收命令、commit/PR 号、以及工具故障流水一律回到 tracker note 与相关 checked-in prompt/docs。
- 本节唯一允许的状态信息是 phase 级完成度数字与全局 blocker 摘要；禁止新增或保留任何 item-specific bullet、item id、reopened/done/blocked/follow-up 叙事、review/self-review/validation/tool-failure 信息。
- Phase 0: 14/14 完成
- Phase 1: 22/23 完成
- Phase 2: 38/49 完成
- Phase 3: 37/51 完成
- Phase 4: 3/8 完成，blocked by earlier phases
- Phase 5: 4/22 完成，blocked by earlier phases
- 当前已锁定的高层边界与长期决策，应分别查看：
  - 根治理 / 硬门禁：本文件其余章节
  - 稳定架构决策：`.serena/memories/architecture-decisions.md`
  - 详细 closeout / evidence / review history：`meta/remediation_tracker_v1.json` 与关联 `meta/docs/prompts/*` / `meta/docs/*`

## 开发约定

- **审核过程文件 (`meta/.review/`) 为临时产物，禁止 git push**。包括三模型审核的 prompt、输出、中间稿等。已在 `.gitignore` 中排除。
- 新代码必须遵守 ECOSYSTEM_DEV_CONTRACT.md 全部规则
- 存量代码按 REDESIGN_PLAN.md 分阶段对齐
- 豁免: `# CONTRACT-EXEMPT: {规则ID} {原因}`
- 配置键必须在 CFG-01 注册表中注册
- 错误必须使用 AutoresearchError 工厂，禁止裸 throw/raise
- Artifact 命名: `^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl|md)$`（人类可读产物允许 `.md`）
- 所有 artifact 写入必须原子操作 (write .tmp → fsync → rename)，tmp 文件必须与目标在同一文件系统

## CLI 命令参考

- 根级 AGENTS 不维护第二套 CLI 速查表；这里只固定入口与 authority 边界。
- 当前仍可用的 Pipeline A CLI 入口是 `hepar` / `hep-autoresearch`；它们属于过渡中的 Python control-plane surface，而不是长期唯一 authority。具体当前命令面以 `--help`、`packages/hep-autoresearch/README.md`、`packages/hep-autoresearch/docs/BEGINNER_TUTORIAL.md` 与 `packages/hep-autoresearch/docs/WORKFLOWS.md` 为准；长期 retirement / repoint 语义以 `meta/REDESIGN_PLAN.md` 和 tracker 为准。

## 运行时产出目录结构

- 本节只固定稳定语义与边界，不在 AGENTS 镜像完整目录树、脚手架文件清单或引用契约细节。
- 全局 home 与项目本地 SoR 的分层长期保留：`~/.autoresearch/` 继续承载 XDG 语义上的 `data/`、`cache/`、`state/`，项目目录继续承载人类可读产物与执行记录。
- 项目本地的稳定可见语义保持为：`paper/` 源码与构建产物分离，`runs/` 是原始执行记录，`evidence/` 是策展证据层，`.autoresearch/tmp/` 负责同文件系统原子写入前提。
- exact root/project surface 由 checked-in scaffold templates 与相关测试锁定；AGENTS 只保留边界语义，不重复维护 snapshot。
- 跨项目引用、ArtifactRef 与其他 machine contract 以 `meta/schemas/` 和对应实现/测试为准，不在根级 AGENTS 维护第二套资料性说明。

## GitNexus MCP

- 本节只保留 GitNexus 的根级硬门禁；自动更新的 marker / stats / quick reference 留在下方 generated appendix。
- 任何涉及代码理解、调试、影响分析或重构的任务，先读 `gitnexus://repo/{name}/context`；若 freshness 告警则先运行 `npx gitnexus analyze`，dirty worktree 默认用 `npx gitnexus analyze --force`。
- 再按任务读取对应 skill：架构理解看 `.claude/skills/gitnexus/exploring/SKILL.md`，blast radius 看 `.claude/skills/gitnexus/impact-analysis/SKILL.md`，debug 看 `.claude/skills/gitnexus/debugging/SKILL.md`，rename/extract/split/refactor 看 `.claude/skills/gitnexus/refactoring/SKILL.md`。
- 若实现新增/重命名符号或改变关键调用链，正式审核前必须再次刷新 index，并用 `detect_changes` / `impact` / `context` 形成 post-change 证据。
- 将下方 generated appendix 视为导航辅助上下文，而不是根级治理 SSOT。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **autoresearch-lab** (12030 symbols, 26680 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/autoresearch-lab/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/autoresearch-lab/context` | Codebase overview, check index freshness |
| `gitnexus://repo/autoresearch-lab/clusters` | All functional areas |
| `gitnexus://repo/autoresearch-lab/processes` | All execution flows |
| `gitnexus://repo/autoresearch-lab/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
