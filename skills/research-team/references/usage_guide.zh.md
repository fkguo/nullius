# research-team — 使用手册（中文 / 人类阅读）

本文件是 `research-team` skill 的中文说明（面向人类用户）。英文主文档见：
- [英文使用手册](usage_guide.md)

说明：
- 本 skill 默认是 **agent-first**：推荐由具备工具调用能力的 agent（Codex/Claude/Gemini）执行脚手架、跑 gates、生成 packet、并落盘产物；人类负责目标与审阅。
- “专给 agent 的提示词/系统 prompt”等资产在发布时保持英文（便于跨语言一致执行）；中文文档仅作为人类阅读说明。

## 准备已选定的正式 A/B 周期

主 agent 负责当前研究问题、核心分析、证据整合与交付。普通研究及有范围的原生
subagent 协作使用 [research-harness](../../research-harness/SKILL.md) 主流程；一次委派
本身不要求 full scaffold、preflight 或 A/B 收敛周期。只有项目采用正式独立成员与
收敛验收时，才执行以下准备；已有资产和契约应直接复用。

下面的命令统一通过 `SKILL_DIR` 解析 skill 安装路径，避免绑死到某个本机目录。

1) 检查确定性前置条件；preflight 不要求模型 CLI：

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/check_environment.sh"
```

2) 生成项目脚手架：

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed \
  --full
```

真实研究请使用仓外 project root。现在 public `research-team` scaffold / contract-refresh / team-cycle 会对 project root 和真实运行中间产物做 fail-closed：如果它们回指到 nullius 开发仓 checkout，命令会直接报错。

`--full` 提供本正式流程所需的 member prompts 与 runner assets；默认项目仍保持精简。
先填写真实研究目标、里程碑范围与契约，再执行 preflight；未填写的模板不是就绪候选。

3) 跑确定性 preflight：

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

preflight 执行已配置的确定性检查、创建父 run 与本轮 packet，然后在 member 执行前返回；
默认 `host_native` 配置也支持此准备步骤。成功只说明准备完成，不授予 reviewer 判词或结果接受。

`--auto-tag` 将 base tag 解析为 `<base>-rN`，同一个值就是父 run 的
`run_id`。新 team/draft cycle 的 packet、日志、检查点与工作区位于
`artifacts/runs/<tag>/research_team/`，来源记录盖章在父 run 上。
`--out-dir` 必须指向项目的 `artifacts` 目录。执行 receipt 与导航指针不授予科学验收。
不要把裸 UUID 或 `run_<uuid>` 当作给人看的研究 tag。

## 执行已选定的正式周期

shell 无法调用宿主原生 subagent API。目前正式 `full_access` 路线需要显式选择受支持的
CLI runners，并提供真实运行观测和可用的 source assessor；可执行示例见
[英文执行说明](usage_guide.md#execute-a-selected-cycle)。脚本不会自动更换 provider。
原生 Markdown 报告或事后手写 evidence JSON 不能替代执行观测，也不能通过把已有
`full_access` 要求改成 `packet_only` 来满足原验收条件。

对本来就适用且配置为 `packet_only` 的周期，原生 A/B 可按既有 prompts 与 packet
进行包内审阅。它只建立报告一致性，独立执行确认数为零。结果采用仍须遵循
[收敛与登记要求](convergence-registration.md)及[完整 notebook 验收](notebook-content-acceptance.md)。
必要执行能力不可用时，保存已完成工作并标明待完成的正式验收；普通原生协作和
preflight 成功都不能宣称整个里程碑已通过。

## 只跑确定性 preflight（不调用外部 LLM；适合 CI/无网环境）

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

若确定性 gate 失败：先修复最小根因（文档/产物/配置），在同一 run 内用 `--preflight-only` 反复重跑直到确定性 gate 通过——这属于开发迭代，不是评审周期。只有携带新候选重新进入评审收敛周期时，才铸造新 tag（例如 `20260502T023000Z-m0-topic-r2`）；见 SKILL.md 的重试双轨与验证粒度契约。
`--out-dir` 也应留在真实项目侧，不要把真实项目的 `team/` 产物再写回开发仓。

## review_access_mode（packet_only vs full_access）

在 `research_team_config.json` 配置：
- `review_access_mode=packet_only`：审阅者只能使用 team packet；只提供报告一致性检查，不建立独立执行确认。
- `review_access_mode=full_access`：审阅者通过 leader proxy 申请文件读取 / 命令执行 / 网络抓取，访问记录在 `artifacts/runs/<tag>/research_team/member_{a,b}_evidence.json`；正式接受还要求原始执行观测、新鲜来源评估及适用的收敛检查。

第三方可离线复核：
- `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/validate_evidence.py" artifacts/runs/<tag>/research_team/member_a_evidence.json`

这个离线检查不能补造运行观测，也不单独授予科学结果接受。

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
