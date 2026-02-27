# 双模型收敛审核协议 — 经验记录

## [2026-02-24] Phase 0 R1→R3 收敛审核（C-01 + NEW-05a + NEW-R15-spec）

**上下文**: 3 项跨组件架构变更的双模型收敛审核
**关联项**: CLAUDE.md §多模型收敛检查

### 模型配置

正确配置（CLAUDE.md 规定）：
- **Codex CLI**: `codex exec -` (stdin pipe), config.toml 默认 gpt-5.3-codex + xhigh
- **Gemini CLI**: `gemini -m gemini-3.1-pro-preview` (stdin pipe)
- **Claude (self)**: 仅做协调和修复，不参与独立审核

错误配置（R1 犯的错）：
- ❌ Claude 自审 + Gemini = 不合规（Claude 既是开发者又是审核者，违反独立性）
- ❌ `gemini -m gemini-2.5-pro` = 模型名不对（应不指定或使用 gemini-3.1-pro-preview）

### 调用方式

**统一入口**: `run_multi_task.py`（已删除 `run_dual_task.py`）

```bash
# 标准双模型审核 — 从 meta/review-swarm.json 自动加载模型/fallback/contract 配置
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir <output_dir> \
  --system <system_prompt.md> \
  --prompt <review_packet.md>
```

不需要手动指定 `--models`、`--fallback-mode` 等，配置文件已包含。
CLI 参数始终覆盖配置文件值。

### 审核包准备要点

1. **必须包含 untracked 新文件**: `git diff HEAD` 不捕获 untracked 文件，需要 `cat` 新文件内容拼入审核包
2. **必须包含 Python SSOT 参考**: 跨语言审核时，把 Python 源码（default_state、append_ledger_event、approval_history writes）作为参考材料一并提供
3. **审核包应自包含**: 审核模型无法访问文件系统，所有需要审核的代码必须在 prompt 中完整呈现
4. **明确要求 JSON 输出**: 结构化输出便于机器比较和收敛判定

### 发现的跨语言对齐陷阱

以下是 TS 对齐 Python SSOT 时的高频错误模式：

| 陷阱 | 说明 |
|------|------|
| **字段命名漂移** | Python `ts` → TS `timestamp`; Python `details` → TS `data`; Python `note` → TS 遗漏 |
| **枚举值漂移** | Python `timeout_rejected` → TS `timed_out`; Python `awaiting_approval` → TS 缺失 |
| **嵌套路径不一致** | Python `policy.budgets.max_approvals` → TS `policy.max_approvals`（丢失一层嵌套） |
| **类型不一致** | Python `current_step` 是 dict → TS 写成 `string`; Python `gate_satisfied` 存 string → TS 写成 boolean |
| **JSON.stringify replacer 陷阱** | `JSON.stringify(obj, keyArray)` 的 keyArray 是**全局白名单**，嵌套对象中不在白名单的 key 被静默丢弃 → 数据丢失 |
| **JSON 序列化分隔符** | Python `json.dumps()` 默认 `(', ', ': ')` 有空格; JS `JSON.stringify()` 无空格 `(',', ':')` → SHA-256 不一致 |
| **json.dumps sort_keys** | Python `sort_keys=True` 递归排序所有层级; JS `JSON.stringify(obj, keysArray)` 仅影响顶层 |

### 审核模型工具访问策略（read-only）

所有审核后端统一为**只读工具访问**——审核者可以检查代码库但不能修改文件。

| Backend | 机制 | 工具访问范围 |
|---------|------|-------------|
| Codex | `--sandbox read-only --full-auto` | Shell（只读文件系统），文件读取 |
| Claude | `--tools 'Read,Glob,Grep,Bash'` | Read, Glob, Grep, Bash（无 Edit/Write） |
| Gemini | `--approval-mode plan` | 只读 agentic 模式 |

配置位于各 runner 脚本：
- `~/.codex/skills/codex-cli-runner/scripts/run_codex.sh`
- `~/.codex/skills/claude-cli-runner/scripts/run_claude.sh`（`TOOLS` 变量）
- `~/.codex/skills/gemini-cli-runner/scripts/run_gemini.sh`（`APPROVAL_MODE` 变量）

技能文档：`skills/review-swarm/SKILL.md` §Tool access policy

**变更日期**: 2026-02-24
**原因**: 审核者需要能读取代码（例如检查跨文件一致性），但绝不能修改被审代码。

### 项目级配置文件 (review-swarm)

`run_multi_task.py` 支持自动发现项目级配置文件，优先级：
1. `--config /path/to/file.json`（CLI 显式指定，最高优先）
2. `{git_root}/meta/review-swarm.json`（开发项目配置）
3. `{git_root}/.autoresearch/review-swarm.json`（autoresearch 管理的研究项目配置）

CLI 参数始终覆盖配置文件值。
设置 `REVIEW_SWARM_NO_AUTO_CONFIG=1` 可禁用自动发现（测试中使用）。

本项目配置文件: `meta/review-swarm.json`
当前配置: `check_review_contract: false`, models: `codex/gpt-5.3-codex,gemini/gemini-3.1-pro-preview`

**变更日期**: 2026-02-25

### 合约检查策略 (contract_fail = informational only)

**决策日期**: 2026-02-25

`--check-review-contract` 验证输出格式（Markdown VERDICT 或 JSON blocking_issues），但结果仅供记录：
- **contract_fail 不触发 fallback** — 避免丢失独立审核（Gemini 的 prose 输出和 Codex 的 JSON 输出都有效）
- **contract_fail 不影响 exit code** — 内容 > 格式
- meta.json 中 `contract_ok`/`contract_errors` 字段仍然记录，供下游消费者参考
- 如需特定格式，在 system/user prompt 中说明

**原因**: 多次出现 Gemini 返回有效 prose 审核却因格式不符被 fallback 到 Codex，丢失独立性。

### 沙盒验证不属于审核职责

- 双模型审核 = **静态代码审查**（读代码 → 推理 → 判断）
- 测试执行 = **本地环境 / CI** 的职责
- Codex sandbox EPERM 是沙盒限制，不是代码问题，不应标为 blocking
- Gemini 无沙盒执行能力，纯文本审查
- 测试通过由 Claude（协调者）在本地环境验证即可

### 绝不截断审核模型（血的教训）

**事件**: NEW-05a Stage 2 R2 审核，Codex 运行 10+ 分钟后被 Claude（协调者）用 TaskStop 强制终止，并基于中间思维痕迹宣布收敛。

**后果**:
1. **漏检 2 个真实 blocking issue**: B6（resumeRun 绕过 pending_approval gate）和 B7（pauseRun 搁置 pending_approval）—— 这两个问题只有 Codex 的 xhigh 深度分析才发现，Gemini R2 未检出
2. **计算完全浪费**: `codex exec -` 是无状态的，终止后无法 resume，10+ 分钟的分析全部丢失
3. **被迫重跑**: 从零开始重新运行 Codex R2，又花了同样的时间

**用户明确批评**: "为何手动停止了 codex 而宣布收敛? 它做 extremely thorough analysis 不是更好吗？"

**规则（硬性）**:
- ❌ **绝不** 用 TaskStop 终止正在运行的审核模型
- ❌ **绝不** 从中间思维痕迹推断结论（intermediate thinking ≠ independent verdict）
- ❌ **绝不** 给审核模型加超时限制（用户原话："要让它跑完，不要加限时"）
- ✅ 等待每个模型独立完成并输出最终 JSON verdict
- ✅ 如果等待时间长，用 `TaskOutput block=false` 检查进度，但不中断
- ✅ Codex xhigh 模式通常需要 10-20 分钟，这是正常的

**根因**: 协调者（Claude）的耐心不足，走了捷径。双模型协议的价值恰恰在于让外部模型做不受开发者盲区影响的独立深度审查。截断审查等于自废武功。

### 完整性要求（硬性规则，2026-02-26 追加）

**每个模型必须至少完成一次对完整实现的审核**，才能计入收敛判定。

**事件**: Batch 3 R1-R4 审核中，Codex 在 R1（完整 packet）超时，R3/R4 仅审核了 delta fix packet 并 PASS。协调者误将 delta-only PASS 视为全面通过，宣布收敛。但 Codex 实际从未审核过完整实现。

**规则**:
- ❌ 如果某模型在完整 packet 轮次（通常是 R1）超时或返回无效输出，后续仅审核 delta fix 的 PASS **不能**计入收敛
- ✅ 必须为该模型重新提交包含**完整源码**的 review packet（所有新文件 + 所有修改文件的关键段落）
- ✅ 只有所有模型都对完整实现返回 0 BLOCKING 后，才能标记为 CONVERGED
- ✅ 完整 packet 应包含：新文件全文 + 修改文件的关键变更 + 设计决策说明 + 测试结果

**与截断规则的关系**: 截断规则（绝不 TaskStop）防止主动终止；完整性规则防止被动遗漏。两者共同保证每个模型都做了完整的独立审查。

### 必须处理所有模型的所有 BLOCKING（硬性规则，2026-02-26 追加）

**事件**: Batch 3 R1 中 Codex 发现了死锁 BLOCKING (nested lock)，Gemini 发现了 TOCTOU BLOCKING。协调者只处理了 Gemini 的 findings，完全忽略了 Codex 的死锁。R2 delta packet 不包含死锁相关代码，Codex R2 没有重新检查死锁 → 返回 PASS。死锁问题一直存留到后续补审才修复。

**规则**:
- ❌ 不能只看某一个模型的 findings 而忽略其他模型
- ✅ 收到 Rn 结果后，先汇总**所有模型**的**所有 BLOCKING**，再统一修复
- ✅ R(n+1) packet 必须同时包含所有 BLOCKING 的修复
- ✅ 建议做法: 收到审核结果后，列一个 BLOCKING 清单表（模型 | 文件 | 问题），确认全部修复后再提交 R(n+1)

**四大规则汇总**:
1. **不截断** — 等待所有模型独立完成
2. **不忽略** — 处理所有模型的所有 BLOCKING findings
3. **不漏审** — 每个模型至少完成一次完整实现审核
4. **不用 delta 收敛** — 最终收敛轮必须使用完整 packet（中间轮可用 delta 加速迭代）

### 收敛效率

#### Phase 0 首批审核 (C-01 + NEW-05a Stage 2 + NEW-R15-spec)

| 轮次 | 模型 | 发现 | 动作 |
|------|------|------|------|
| R1（不合规）| Claude+Gemini | 3 blocking (字段漂移) | 修复 |
| R2 | Codex+Gemini | 7 blocking (深层对齐) | 修复 |
| R3 | Codex+Gemini | Gemini: 0 blocking; Codex: 2 residual nits | 接受 |

#### NEW-05a Stage 3c 审核 (plan validation + plan.md + sync helpers)

| 轮次 | 模型 | 发现 | 动作 |
|------|------|------|------|
| R3 | Codex+Gemini | Codex: 3 blocking (schemaResolveRef, renderPlanMd numbering, ?? vs \|\| falsy); Gemini: APPROVED | 修复 |
| R4 | Codex+Gemini | Codex: 2 blocking (parseInt partial, missed ?? in active_branch_id); Gemini: APPROVED | 修复 |
| R5 | Codex+Gemini | Codex: PASS (0 blocking, 3 non-blocking nits); Gemini: APPROVED | CONVERGED |

**教训**:
- R1 用 Claude 自审只发现了表层问题，正确的 Codex+Gemini 挖出更深层问题。独立外部模型审核的价值在于它们不受开发者盲区影响。
- Codex xhigh 在 JS/Python 语义差异（`??` vs `||`、`parseInt` partial parsing、JSON Pointer unescaping）上的检出率显著高于 Gemini。
- Gemini 倾向于整体判断正确性（快速 APPROVED），Codex 逐行对比发现具体偏差——两者互补。

### 跨会话 prompt 传递约定

新对话的启动 prompt 写为 `meta/docs/prompts/prompt-<task-id>.md`，命名示例：
- `prompt-phase0-remaining.md`
- `prompt-new05a-stage3a.md`
- `prompt-track-b.md`

内容结构：
1. **头部元信息**: 工作目录、Serena 项目名、启动前必读记忆
2. **上下文**: 前序工作完成状态（commit hash、test count、收敛轮次）
3. **本阶段范围**: 具体实现条目（对齐 Python SSOT 的哪些函数）
4. **约束**: 双模型收敛、测试要求、Python SSOT 原则
5. **验收标准**: checklist（tsc、vitest、收敛、tracker、memory、commit）
6. **参考文件表**: 路径 + 用途
7. **不在范围**: 明确列出下一个对话的工作，避免越界

写好后 git commit 一并提交（或单独提交），新对话开头粘贴该文件内容即可。

### 审核 prompt 结构模板

```
system_prompt.md:
  - 角色定义（senior architect）
  - 审核范围（scope-limited, 列出具体文件和关注点）
  - 输出格式（JSON with blocking/non_blocking/verdict）

review_packet.md:
  - Python SSOT 参考代码（完整函数体）
  - 变更内容（diff + 新文件全文）
  - 构建/测试状态
```
