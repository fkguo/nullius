# research-team — 使用手册（中文 / 人类阅读）

本文件是 `research-team` skill 的中文说明（面向人类用户）。英文主文档见：
- `references/usage_guide.md`

说明：
- 本 skill 默认是 **agent-first**：推荐由具备工具调用能力的 agent（Codex/Claude/Gemini）执行脚手架、跑 gates、生成 packet、并落盘产物；人类负责目标与审阅。
- “专给 agent 的提示词/系统 prompt”等资产在发布时保持英文（便于跨语言一致执行）；中文文档仅作为人类阅读说明。

## 快速开始（3 条命令）

1) 环境检查（可选）：

```bash
bash ~/.codex/skills/research-team/scripts/bin/check_environment.sh --require-claude
# 或（A=Claude, B=Gemini）：
# bash ~/.codex/skills/research-team/scripts/bin/check_environment.sh --require-claude --require-gemini
```

2) 生成项目脚手架：

```bash
bash ~/.codex/skills/research-team/scripts/bin/scaffold_research_workflow.sh \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed
```

3) 跑一轮 team cycle：

```bash
cd /path/to/project

bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

## 只跑确定性 preflight（不调用外部 LLM；适合 CI/无网环境）

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

若 gate 失败：先修复最小根因（文档/产物/配置），再用新 tag 重跑（例如 `M0-r2`）。

## review_access_mode（packet_only vs full_access）

在 `research_team_config.json` 配置：
- `review_access_mode=packet_only`：审阅者只能使用 team packet（离线可携带；legacy 模式）。
- `review_access_mode=full_access`：审阅者仍无直接工具；通过 leader proxy 申请文件读取 / 命令执行 / 网络抓取，并把所有访问写入 `team/runs/<tag>/member_{a,b}_evidence.json`；最终由确定性 gates 校验。

第三方可离线复核：
- `python3 ~/.codex/skills/research-team/scripts/bin/validate_evidence.py team/runs/<tag>/member_a_evidence.json`

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
