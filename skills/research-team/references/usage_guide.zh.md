# research-team — 使用手册（中文 / 人类阅读）

本文件是 `research-team` skill 的中文说明（面向人类用户）。英文主文档见：
- `references/usage_guide.md`

说明：
- 本 skill 默认是 **agent-first**：推荐由具备工具调用能力的 agent（Codex/Claude/Gemini）执行脚手架、跑 gates、生成 packet、并落盘产物；人类负责目标与审阅。
- “专给 agent 的提示词/系统 prompt”等资产在发布时保持英文（便于跨语言一致执行）；中文文档仅作为人类阅读说明。

## 快速开始（3 条命令）

下面的命令统一通过 `SKILL_DIR` 解析 skill 安装路径，避免绑死到某个本机目录。

1) 环境检查（可选）：

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude
# 或（A=Claude, B=Gemini）：
# bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude --require-gemini
```

2) 生成项目脚手架：

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed
```

真实研究请使用仓外 project root。现在 public `research-team` scaffold / contract-refresh / team-cycle 会对 project root 和真实运行中间产物做 fail-closed：如果它们回指到 autoresearch-lab 开发仓 checkout，命令会直接报错。repo 内 `skilldev/` 与 `.tmp/` 仅保留给显式 maintainer fixture。

3) 跑一轮 team cycle：

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

## 只跑确定性 preflight（不调用外部 LLM；适合 CI/无网环境）

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

若 gate 失败：先修复最小根因（文档/产物/配置），再用新 tag 重跑（例如 `M0-r2`）。
`--out-dir` 也应留在真实项目侧，不要把真实项目的 `team/` 产物再写回开发仓。

## review_access_mode（packet_only vs full_access）

在 `research_team_config.json` 配置：
- `review_access_mode=packet_only`：审阅者只能使用 team packet（离线可携带；legacy 模式）。
- `review_access_mode=full_access`：审阅者仍无直接工具；通过 leader proxy 申请文件读取 / 命令执行 / 网络抓取，并把所有访问写入 `team/runs/<tag>/member_{a,b}_evidence.json`；最终由确定性 gates 校验。

第三方可离线复核：
- `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/validate_evidence.py" team/runs/<tag>/member_a_evidence.json`

## knowledge_base（三层）

项目知识库约定为 `knowledge_base/` 三层目录：
- `knowledge_base/literature/`：文献/官方文档/代码等外部来源的笔记与摘录
- `knowledge_base/methodology_traces/`：方法选择与可复现痕迹（命令、输出、局限）
- `knowledge_base/priors/`：先验约定（符号、单位、归一化、固定假设）

建议：在笔记顶部写一行 `RefKey: <key>`；并确保第一个 Markdown H1（`# ...`）可读且稳定。

## KB index JSON（确定性 / L1 导出）

用于下游检索与变更检测的 KB 索引导出（确定性/离线）：
- 英文说明：`references/kb_index.md`

## 常见问题与定位入口

- gate 失败诊断与重跑配方：`RUNBOOK.md`
- skill 入口（短）：`SKILL.md`
- 英文主文档：`references/usage_guide.md`
