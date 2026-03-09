# Draft writing（草稿写作：从 Draft_Derivation/KB 到可编译草稿）

定位：在进入 `revision`（审稿→改稿→再审）之前，先把“从已有推导/知识库出发的可编译草稿”做成可复现、可审计的 workflow。

默认输入：**已有** `Draft_Derivation.md` + `knowledge_base/`（以及可选的 `artifacts/`）。

## 输入（Inputs）

必需：
- `Draft_Derivation.md`：定义、推导、符号约定、关键结论的来源。
- `knowledge_base/`：阅读笔记与方法学 trace（至少包含目标引用的 RefKey 笔记）。

强烈建议：
- `artifacts/`：若草稿需要“结果段落/图表/数值”，必须有 manifest/summary/analysis 指针。

## 产物（Artifacts）

最小产物（MVP）：
- `artifacts/runs/<TAG>/draft/manifest.json`
- `artifacts/runs/<TAG>/draft/summary.json`
- `artifacts/runs/<TAG>/draft/analysis.json`
- `artifacts/runs/<TAG>/draft/paper/`（草稿 LaTeX 工程；或 paper bundle zip）
- `team/runs/<TAG>/...`（Reviewer 报告 + 裁决；如启用双审阅/收敛）

## 门禁（Gates）

默认（safe）：
- A4（paper edits）：**开始生成/修改 LaTeX 工程前必须征得人类同意**（草稿也算“改论文/改稿”范畴）。
- 可编译门禁：草稿必须能编译（至少 `latexmk`/pdflatex 一遍）。
- 引用/链接门禁：引用必须可追溯（RefKey/稳定链接），禁止“无证据新增关键论断”。
- Reviewer 信息隔离：Reviewer 只看 `review_packet.md`（见 `docs/REVIEWER_ISOLATION.md`）。

## 角色分工（默认）

- Planner：确定目标期刊风格/章节结构/验收标准（可编译、引用完整、哪些结果必须出现）。
- Writer/Editor：生成草稿（先在 draft 输出目录；避免直接污染主 paper）。
- Executor：运行工具链（MCP/脚本/编译），落盘产物。
- Reviewer：独立审阅草稿与证据指针，给出 NOT_READY/READY。

## 步骤（MVP）

1) **Scope freeze（冻结范围）**
   - 论文主题/贡献点的最小集合（先 1–2 个主结论）
   - 目标读者与风格（PRL/JHEP/notes）
   - 需要引用的最小论文集合（RefKeys）

2) **A4 approval gate**
   - 输出“草稿写作审批包”（章节计划、将写入的路径、预算、风险、回滚方式）
   - 人类 `approve` 后继续

3) **Draft scaffold（骨架生成）**
   两条可选路径（先选一条做稳定）：
   - **推荐（默认）**：先走 Skill 路径，用 `research-writer` 从 [Draft_Derivation.md](../Draft_Derivation.md) + [knowledge_base/](../knowledge_base/)（+可选 [artifacts/](../artifacts/)）生成可编译 `paper/` scaffold（或 `paper/drafts/<run_id>/`）。
     - 理由：输入契约与本 workflow 完全对齐；并且更利于“先有可编译草稿→再做编排增强”。
     - 最小命令（从项目根目录运行）：
       ```bash
       bash ~/.codex/skills/research-writer/scripts/bin/research_writer_scaffold.sh \
         --project-root "$PWD" \
         --tag <TAG> \
         --out paper/
       (cd paper && latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex)
       ```
   - 中期增强：再委托 MCP 写作编排工具（`hep_export_paper_scaffold` / `hep_run_writing_*`）做 token budget / evidence packet / refinement state machine。
     - 注意：委托前必须具备明确的 delegation protocol（避免状态冲突；见 [MCP delegation protocol](../docs/MCP_DELEGATION_PROTOCOL.md)）。

4) **Section drafting（分节写作）**
   - 约束：每节必须附带“证据指针”（指向 notebook/KB/artifacts），不允许凭空补物理结论。
   - 建议：先写 Introduction + Method + 1 个 Results（最小闭环）。

5) **Integrate + compile gate**
   - 生成可编译版本
   - 记录编译日志与依赖

6) **Reviewer pass**
   - Reviewer 基于 `review_packet.md`（含 diff/编译结果/证据指针）给 verdict
   - NOT_READY → 返回步骤 3/4 修复；READY → 进入下一阶段（可选：`revision`）

## 扩展路线（v1/v2）

v1（更稳、更自动）：
- 与 `hep-research-mcp` 写作编排工具委托整合（Meta-Orchestrator → MCP orchestrator；见 `docs/MCP_DELEGATION_PROTOCOL.md`）
- token budget / evidence gate / allowed citations 自动化（用 `hep_run_writing_token_gate_v1` 等）

v2（更接近“论文产品化”）：
- 多模型/多 reviewer 收敛（`research-team`/`review-swarm`）
- “结论段落/新意声明”强制 A5 gate + 引用链审计
