# Beginner tutorial（小白教程）

English quickstart: `docs/BEGINNER_TUTORIAL.md` (short). 本文件为中文详版。

本教程面向第一次接触 agent / 智能体工作流的用户，目标是让你能在 30 分钟内理解并跑通一个“安全的最小闭环”。

> 当前项目已完成可执行骨架：W1 ingestion + eval runner + Orchestrator CLI v0.4（可执行 W1/W2(toy)/W_compute/W3_revision(v0)/W3_literature_survey_polish/ADAPTER_shell_smoke，支持 approve/pause/resume/logs/export；并按 `approval_policy.json` 自动触发默认同意点）。
> 当前已跑通 run_card v2 + W_compute 的最小闭环（示例：`examples/schrodinger_ho`），并把关键门禁/回归评测/双评审纳入默认流程（见 `RESEARCH_PLAN.md` 与 `artifacts/LATEST.md`）。

## 0) 你需要知道的 4 个概念

1) **Agent 不等于模型**：模型负责“计划/写作/策略”，可信度来自工具调用、产物契约、门禁与独立复核。
2) **Workflow 是入口**：用户不需要理解内部多个角色；只需要选择你在做 W1/W2/W3/W4 哪类任务。
3) **Artifacts 是证据**：任何关键输出都要落到 `manifest/summary/analysis` 三件套（见 `docs/ARTIFACT_CONTRACT.zh.md`）。
   - 同时会生成 `report.md`（由 JSON 确定性渲染的人类可读摘要；JSON 仍是 SSOT）。
4) **Context pack 是护栏**：每个 run 会生成 `artifacts/runs/<run_id>/context/context.md` + `context.json`，把工作锚定到 `PROJECT_CHARTER.md` / `RESEARCH_PLAN.md` / approval gates / artifact contract，防止“只盯眼前问题”的局部优化漂移。

## 1) 项目目录怎么读（先看导航）

从 `PROJECT_MAP.md` 开始：
- 总览：`README.md`
- 规划：`docs/VISION.md`、`docs/ROADMAP.md`
- 工作流：`workflows/`
- 产物契约：`docs/ARTIFACT_CONTRACT.zh.md`、`specs/`
- 默认同意点：`docs/APPROVAL_GATES.zh.md`

## 2) 安装/前置（最小）

最低要求（能跑 preflight + 生成 planning artifacts）：
- `bash`
- `python3`（当前环境已验证：3.9.6）

可选（安装“可全局调用”的 CLI；推荐 pipx；也可用 pip -e 做开发安装）：

```bash
# （推荐）创建一个专用 venv（一次即可）
python3 -m venv ~/.venvs/hep-autoresearch
source ~/.venvs/hep-autoresearch/bin/activate
python -m pip install -U pip

# 在项目根目录安装（开发安装）
python -m pip install -e .
hep-autoresearch --help
# 简写别名（可选）
hepar --help

# 退出 venv
deactivate
```

可选：如果你使用 [uv](https://github.com/astral-sh/uv)（更快的安装器），也可以：

```bash
uv venv ~/.venvs/hep-autoresearch
source ~/.venvs/hep-autoresearch/bin/activate
uv pip install -e .
hep-autoresearch --help
```

可选（跑“全团队复核/双模型”时才需要）：
- `claude` CLI
- `gemini` CLI
  - 备注：本机常用可用模型别名是 `gemini-3-pro-preview`；如果指定模型报“未开放”，可以先不指定 `-m` 用默认模型跑通流程。

可选（离线/CI 可复现运行；推荐读完再用）：
- `HEPAR_HTTP_MODE=record|replay|fail_all`（见 [HTTP reproducibility](HTTP_REPRODUCIBILITY.md)）

## 3) 5 分钟跑通：M0（不调用外部 LLM）

在项目根目录运行：

```bash
cd hep-autoresearch
python3 scripts/gen_m0_planning_artifacts.py --tag M0-r1
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

你会得到：
- `artifacts/runs/M0-r1/planning/` 下的 `manifest/summary/analysis`
- `team/runs/M0-r1/team_packet_M0-r1.txt`（给“评审 agent”的评审包；当前仅生成，不跑外部模型）

> 注意：`PROJECT_CHARTER.md` 必须经人类审阅后设置为 `Status: APPROVED/ACTIVE` 才建议进入更高自治（本 repo 当前已为 `APPROVED`）。

## 4) （可选）跑一次“真正的双成员复核”

如果你本机已装好 `claude`/`gemini`，可以去掉 `--preflight-only` 跑完整 team cycle（会调用外部 LLM CLIs）：

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

产物会落到 `team/runs/M0-r1/`，包括 member A/B 报告与 adjudication（如果收敛）。

## 5) 你要做“想法→文献→新意→推进”，应该怎么开始？

从“安全模式（默认）”开始：

1) 把你的想法写进 `INITIAL_INSTRUCTION.md`（一句话 + 关键词 + 你认为的新意点）
2) 在 `PREWORK.md` 更新 coverage matrix（至少列出你认为必须覆盖的方向）
3) 新建一个 trace：`knowledge_base/methodology_traces/YYYY-MM-DD_idea_triage_<slug>.md`
4) 找一个你认为最相关的 paper（先 1 篇就行），写成 KB note 放到 `knowledge_base/literature/`
5) 运行 preflight-only，确保链接/引用/门禁都能过

然后让你的“工具型智能体”（Codex/Claude Code/自建 agent）按 `workflows/W1_ingest.zh.md` 去批量补齐文献入口，再按 `workflows/W2_reproduce.zh.md` 做最小验证。

如果你已经有 `Draft_Derivation.md` + `knowledge_base/`，并希望先产出一份**可编译草稿**，走：
- `workflows/W3_draft.zh.md`（草稿写作）→ 之后再进入 `workflows/W3_revision.zh.md`（审稿→改稿闭环）

最小命令（草稿骨架 + 编译门禁）：

```bash
bash ~/.codex/skills/research-writer/scripts/bin/research_writer_scaffold.sh \
  --project-root "$PWD" \
  --tag M2-w2-toy-devcheck-r1 \
  --out paper/
(cd paper && latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex)
```

### （可选）直接运行 W1 ingestion v0（不依赖外部 LLM）

```bash
python3 scripts/run_w1_ingest.py --inspire-recid 3112995 --refkey recid-3112995-madagants --tag M1-r1 --download none
```

### （可选）体验 Orchestrator CLI v0.4（run/status/pause/resume/approve/logs/export）

初始化（在你的研究项目根目录运行；会写入 `.autopilot/`，并补齐 `docs/` + `knowledge_base/` + `specs/` 的最小骨架）：

```bash
# 在你的研究项目目录执行
hep-autoresearch init
hep-autoresearch status
```

如果你是在本仓库根目录开发（存在 `scripts/` 目录），也可以：

```bash
python3 scripts/orchestrator.py init
```

之后你可以在任意子目录运行命令；CLI 会向上寻找 `.autopilot/` 作为 project root。

启动并执行一个最小 workflow（W1 ingestion）：

```bash
hep-autoresearch run --run-id M1-orch-r1 --workflow-id W1_ingest --inspire-recid 3112995 --refkey recid-3112995-madagants --download none
hep-autoresearch status
hep-autoresearch context   # 查看/刷新 context pack（可选）
hep-autoresearch logs --tail 20

# 或（不安装 CLI 的情况下）
python3 scripts/orchestrator.py run --run-id M1-orch-r1 --workflow-id W1_ingest --inspire-recid 3112995 --refkey recid-3112995-madagants --download none
python3 scripts/orchestrator.py status
python3 scripts/orchestrator.py context   # 查看/刷新 context pack（可选）
python3 scripts/orchestrator.py logs --tail 20
```

模拟一个同意点（先 gate，再执行）：

```bash
hep-autoresearch run --run-id M1-orch-r2 --workflow-id W1_ingest --gate A1 --arxiv-id 2210.03629 --refkey arxiv-2210.03629-react --download none
hep-autoresearch status   # 查看 pending_approval.approval_id
hep-autoresearch approve <approval_id>
hep-autoresearch run --run-id M1-orch-r2 --workflow-id W1_ingest --gate A1 --arxiv-id 2210.03629 --refkey arxiv-2210.03629-react --download none

# 或（不安装 CLI 的情况下）
python3 scripts/orchestrator.py run --run-id M1-orch-r2 --workflow-id W1_ingest --gate A1 --arxiv-id 2210.03629 --refkey arxiv-2210.03629-react --download none
python3 scripts/orchestrator.py status   # 查看 pending_approval.approval_id
python3 scripts/orchestrator.py approve <approval_id>
python3 scripts/orchestrator.py run --run-id M1-orch-r2 --workflow-id W1_ingest --gate A1 --arxiv-id 2210.03629 --refkey arxiv-2210.03629-react --download none
```

### （可选）运行 W2 toy reproduction（确定性回归锚点）

```bash
python3 scripts/run_w2_reproduce.py --tag M2-toy-r1 --case toy
python3 scripts/run_evals.py --tag M2-eval-r1 --case-id E4-w2-toy-reproduce
```

或用 Orchestrator 统一入口：

```bash
hep-autoresearch run --run-id M2-orch-w2-toy-r1 --workflow-id W2_reproduce --case toy --ns 0,1,2,5,10
hep-autoresearch status   # 查看 pending_approval（默认 A3）
hep-autoresearch approve <approval_id>
hep-autoresearch run --run-id M2-orch-w2-toy-r1 --workflow-id W2_reproduce --case toy --ns 0,1,2,5,10

# 或（不安装 CLI 的情况下）
python3 scripts/orchestrator.py run --run-id M2-orch-w2-toy-r1 --workflow-id W2_reproduce --case toy --ns 0,1,2,5,10
python3 scripts/orchestrator.py status   # 查看 pending_approval（默认 A3）
python3 scripts/orchestrator.py approve <approval_id>
python3 scripts/orchestrator.py run --run-id M2-orch-w2-toy-r1 --workflow-id W2_reproduce --case toy --ns 0,1,2,5,10
```

### （可选）运行 W_compute（run_card v2 多阶段 DAG 示例：schrodinger_ho）

```bash
hep-autoresearch run --run-id M0-wcompute-demo-r1 --workflow-id W_compute --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json --trust-project
hep-autoresearch status   # 查看 pending_approval（默认 A3）
hep-autoresearch approve <approval_id>
hep-autoresearch run --run-id M0-wcompute-demo-r1 --workflow-id W_compute --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json --trust-project
```

W_compute 文档入口：
- [docs/W_COMPUTE.zh.md](W_COMPUTE.zh.md)
- [docs/EXAMPLES.zh.md](EXAMPLES.zh.md)

### （可选）EVOLUTION v0：从失败 run 生成“改进提案”

当你遇到失败（例如 ingestion 网络/SSL 报错、eval suite FAIL、数值不稳等），先不要“拍脑袋改代码”，而是生成一份**可审计的提案清单**：

```bash
# 例：从历史 run 中提取失败证据，生成下一步提案（不会自动改代码）
hep-autoresearch propose --tag M17-t23-evolution-r1 --source-run-tag M15-agentlit-src-r1
```

你会得到：
- `artifacts/runs/M17-t23-evolution-r1/evolution_proposal/proposal.md`（人类可读提案）
- `artifacts/runs/M17-t23-evolution-r1/evolution_proposal/analysis.json`（证据与可机读结构）

并且任何 `code_change`/`eval` 类建议都会明确标注需要 `A2` 才能落地。

> 备注：默认会写入一条 KB trace 到 `knowledge_base/methodology_traces/`（便于审计与复盘）。如果你想保持工作区干净可用 `--no-kb-trace`。

## 6) 默认同意点（强烈建议）

除非你明确要求“全自动”，否则建议默认在以下步骤前询问人类同意：
- 大规模检索前
- 写/改代码前
- 跑算力/长任务前
- 改论文前
- 准备写结论/宣称新意前

见：`docs/APPROVAL_GATES.zh.md`（已在 Orchestrator v0.4 对 W2(toy)/W_compute 默认 A3 门禁、对 W3 默认 A4 门禁部分落地；其余 workflow 会逐步补齐）。

## 7) （可选）W3 revision v0：编译门禁 + provenance 表（不依赖外部 LLM）

直接运行 runner（会修改 `paper/main.tex`，需显式批准）：

```bash
python3 scripts/run_w3_revision.py --tag M2-w3-rev-devcheck-r1 --paper-root paper --tex-main main.tex --i-approve-paper-edits
```

或用 Orchestrator（默认会触发 A4）：

```bash
hep-autoresearch run --run-id M2-orch-w3-r1 --workflow-id W3_revision
hep-autoresearch status   # 查看 pending_approval（默认 A4）
hep-autoresearch approve <approval_id>
hep-autoresearch run --run-id M2-orch-w3-r1 --workflow-id W3_revision

# 或（不安装 CLI 的情况下）
python3 scripts/orchestrator.py run --run-id M2-orch-w3-r1 --workflow-id W3_revision
python3 scripts/orchestrator.py status   # 查看 pending_approval（默认 A4）
python3 scripts/orchestrator.py approve <approval_id>
python3 scripts/orchestrator.py run --run-id M2-orch-w3-r1 --workflow-id W3_revision
```

## 8) （可选）Web 入口 v0（FastAPI + 内置最小 UI）

```bash
python3 -m pip install -e \".[web]\"
python3 -m uvicorn hep_autoresearch.web.app:app --reload --port 8000
```

然后打开：
- http://127.0.0.1:8000/ （UI）
- http://127.0.0.1:8000/status （JSON）
