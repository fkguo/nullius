# knowledge_graph/（Claim DAG + Evidence；ZH）

Project: <PROJECT_NAME>  

本目录用于把“我们认为成立的陈述”结构化为 Claim DAG，并把可复现产物登记为 Evidence（证据清单）。

最小文件集（MVP）：

- `claims.jsonl`：每行一个 claim（JSON 对象）
- `edges.jsonl`：每行一条边（claim↔claim 的依赖/支持/竞争/矛盾关系）
- `evidence_manifest.jsonl`：每行一个 evidence（JSON 对象；指向产物路径/文献锚点等）

与团队执行层（Trajectory）的关系：

- `team/trajectory_index.json` 记录每轮 tag 的产物路径与 gate 状态
- `claims.jsonl.linked_trajectories` 用 tag 把 claim 与执行轮次关联

## 推荐工作流（最小可运行）

1. 先用 `mechanisms/00_pre_task_clarifier.md` 明确 profile 与 DoD
2. 在 `claims.jsonl` 添加 1–3 个核心 claims（状态 `draft` 或 `active`）
3. 将本轮产物（推导/图/表/代码运行输出/文献摘录）登记到 `evidence_manifest.jsonl`
4. 用 `edges.jsonl` 写清依赖与竞争关系（支持 Fork，而不是强行口头收敛）
5. （可选 gate）启用 Claim DAG 校验：在 `research_team_config.json` 打开 `features.claim_graph_gate=true` 等

## 可视化（可选）

- 收敛后会生成 `knowledge_graph/claim_graph.dot`。
- 若安装 Graphviz，还会生成 `claim_graph.png` 或 `claim_graph.svg`。
- 开关：`claim_graph_render.enabled`；格式：`claim_graph_render.format = png/svg/both/dot`。
- 可读性：`claim_graph_render.max_label` 控制节点文本截断（`0` 代表不截断）；`claim_graph_render.wrap_width` 控制自动换行。
- 约定：`edges.jsonl` 里的 `type:"requires"` / `type:"supersedes"` 语义分别是“source 依赖 target（target 是前置条件）” / “source supersedes target（source 替换 target）”。为更符合 workflow-forward 的阅读方向，渲染时会把这两类边显示为 `target -> source`，并分别标注为 `enables` / `superseded by`。其它边类型按原方向渲染。

## 建模建议（让图真正表达“问题节点→解决路径”）

- 不要只写“里程碑式结果”。建议把关键 **问题/风险/决策点** 也写成 claim（例如：数值不稳定、PV 处理方案选择、tail 模型竞争解释）。
- 用 `edges.jsonl` 的 `fork/competitor/contradicts/supersedes` 表达分叉、替代方案与否证，而不是把所有信息塞进一个大 claim 文本里。

## Gate（可选，确定性）

当启用后，以下脚本会在 `run_team_cycle.sh` 的 preflight 阶段运行：

- `check_claim_graph.py`：检查 `claims.jsonl` 与 `edges.jsonl` 的 schema 与一致性
- `check_evidence_manifest.py`：检查 `evidence_manifest.jsonl` 的 schema（可选检查路径存在）
- `check_claim_trajectory_link.py`：检查 claim 中 `linked_trajectories` 是否能在 `team/trajectory_index.json` 中找到对应 tag

所有 gate 都是 deterministic：清晰 CLI、明确输入输出、明确 exit code，并给出可修复错误信息。
