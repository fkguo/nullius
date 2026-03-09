# Evals（回归评测与可靠性工程）

目标：把“科研智能体”从 demo 变成工程，需要可重复、可对比、可回归的评测集合（eval suite）。

## 1) 评测对象

- Workflow 级：ingest / reproduce / draft / revision / derivation_check 是否稳定产出、是否通过门禁。
- Agent 级：Planner/Runner/Writer/Reviewer 的输出质量与收敛率。
- Tool 级：MCP 工具调用是否满足契约、是否产生正确 artifacts。

## 2) 评测指标（建议最小集合）

- **Pass/fail gates**：硬门禁是否通过（可编译/引用/证据/复现误差）。
- **Human interventions**：每个 workflow 需要多少次人工决策/纠偏。
- **Time-to-result**：从输入到得到可用产物的时间（以及主要瓶颈）。
- **Stability**：升级后在固定任务集上的退化率（回归）。

补充（用于“自我进化”闭环）：
- **Delta evaluation**：每次策略/提示词/工具链更新前后，必须跑同一组 eval cases 并对比指标（通过率/干预/耗时）。
- **Anti-hallucination proxies**：引用完整率、artifact 指针完整率、无证据新增段落比例（用于写作/改稿任务）。

## 3) Eval case 的形式（建议）

每个 eval case 是一个目录（或 YAML/JSON 配置）：
- `case.json`：输入、目标、允许工具、期望产物位置、容差
- `expected/`：可选的“golden”对照（例如已知数值或某些审稿要点）
- `run.sh`：一键运行入口（或由 Orchestrator 统一执行）

## 4) 最小起步（建议）

先做小而硬的 eval：
- E1/E2：ingest（固定论文输入，检查 reading-note 字段/链接/RefKey 完整性）
- E3：Orchestrator CLI presence（先把 `status/pause/resume/approve` 的代码与契约纳入回归集合）
- E4：reproduce toy（确定性 toy 算例，检查 artifacts + 数值容差）
- E5：revision 改稿闭环（固定一个最小 LaTeX 工程，检查能否“审→改→编译” + provenance 产物）
- E6：Orchestrator 行为回归（reproduce/revision 默认门禁：exit code、审批包、产物路径断言）

Schema（建议）：
- Eval case schema: `specs/eval_case.schema.json`
- Example case: `templates/eval_case.example.json`

自我进化门禁（L2/L3）：
- `docs/EVAL_GATE_CONTRACT.md`

## 5) 现阶段如何运行（v0）

当前已提供最小 eval runner（起步支持：`required_paths` + reading-note 字段 + JSON 数值容差检查）：

```bash
python3 scripts/run_evals.py --tag M1-eval-r1
```

JSON 数值容差检查（`acceptance.json_numeric_checks`）示例：

```json
{
  "path": "artifacts/runs/M2-toy-r1/reproduce/analysis.json",
  "pointer": "#/results/headlines/max_abs_err_scipy",
  "max": 1e-8
}
```

JSON 值检查（`acceptance.json_value_checks`；string/bool/exact match）示例：

```json
[
  {
    "path": "references/arxiv/2310.06770/metadata.json",
    "pointer": "#/title",
    "type": "string",
    "contains": "SWE-bench"
  },
  {
    "path": "artifacts/runs/M18-ingest-failall-r1/ingest/arxiv-2310.06770-swe-bench/analysis.json",
    "pointer": "#/results/ok",
    "type": "boolean",
    "equals": false
  }
]
```

只跑某个 case：

```bash
python3 scripts/run_evals.py --tag M1-eval-r1 --case-id E1-ingest-curated-anchor
```
