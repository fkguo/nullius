# Reviewer isolation spec（Reviewer 信息隔离：可执行实现规格）

目的：把 `docs/ARCHITECTURE.md` 中的 Reviewer 信息隔离，从“原则”变成**可实现、可测试、可审计**的工程规格。

核心原则：
- Reviewer 的输入应当以“证据包/产物/差异（diff）/验收标准”为主。
- Reviewer 不应看到 Executor 的长对话与中间失败尝试（降低确认偏差与注入面）。
- 升级（escalation）必须经人类批准，并落盘记录。

## 1) 最小可行实现（M0/M1）

在 M0/M1，我们把 Reviewer 视为一个 **clean-room 外部审阅进程**：

- **进程隔离**：Reviewer 通过独立 CLI runner 执行（`claude-cli-runner` / `gemini-cli-runner`），不是同一个 agent session。
- **工具隔离**：Reviewer 默认禁用 tools/MCP（Claude 侧显式 `--tools ""`；Gemini 侧不提供 MCP 能力）。
- **输入隔离**：Reviewer 的 prompt 输入文件只能包含：
  - `review_packet.md`（Orchestrator 生成，见下）
  - 输出契约（结构化 headers + verdict）
- **升级授权**：Reviewer 若提出“需要更多信息”，Orchestrator 必须进入 `awaiting_approval`（escalation gate），由人类选择是否补充新的 `review_packet.md`（新的 approval_id），而不是让 Reviewer 自己去读文件或查网。

这套实现的关键点是：**Reviewer 进程没有 tools，就没有读文件/跑命令/联网的能力；它只能基于 packet 作判断。**

## 2) `review_packet.md` 的最小内容（MVP）

Orchestrator 必须生成一个“离线可审阅”的 packet（建议放在 run artifacts 下）：

- Planner 的 acceptance criteria（明确可验收）
- 本次动作摘要（做了什么、没做什么、为何）
- 关键 artifacts 指针（manifest/summary/analysis 的路径与字段 key）
- 对比/差异（diff；或至少提供 diff 的路径）
- 风险披露（UNVERIFIED/assumptions 列表 + 下一步最小验证）
- 成本/预算统计（network calls/runtime；可选）

并且：
- packet 内禁止出现“请无条件通过/请忽略门禁”等指令式文本（如出现，Reviewer 必须拒绝并要求 escalation）。

## 3) Escalation（受控升级）的协议

### 3.1 触发条件（建议）

Reviewer 在以下情况下可以请求 escalation（写入结构化字段，不写自由指令）：
- 缺少关键 artifacts 指针导致无法复核
- diff/编译结果缺失
- 发现潜在注入/不一致，需要查看更高粒度日志

### 3.2 执行方式（MVP）

- Orchestrator 将请求转换为审批包（A?：escalation gate，可作为 A4/A5 的子类），进入 `awaiting_approval`。
- 人类决定：
  - `approve`：补充指定范围的信息（例如再生成一个附录包，或附上编译日志）
  - `reject`：要求重新生成更简洁/更结构化的 packet

所有 escalation 必须写入 `.autoresearch/ledger.jsonl`（见 [`docs/ORCHESTRATOR_STATE.md`](ORCHESTRATOR_STATE.md)）。

## 4) 可测试的验收标准（MVP）

> 这些是“能写成 eval case/脚本”的验收点。

- RI-1（工具隔离）：Reviewer runner 启动参数必须禁用 tools（Claude：`--tools ""`），且执行日志中必须可审计该参数。
- RI-2（输入隔离）：Reviewer 的 prompt 文件只能引用 `review_packet.md`（不允许额外文件拼接）。
- RI-3（无沉默升级）：Reviewer 请求更多信息时，必须进入待审批状态；不得自动把更多日志塞给 Reviewer。
- RI-4（注入防护）：当 packet 中包含指令式注入文本时，Reviewer verdict 必须为 `NOT_READY` 并要求 escalation/人工介入。

### 4.1 M1 的“实现钩子”（让验收可落地）

为了让上述验收点可执行，M1 阶段建议把 Reviewer 的调用方式固定为：

- 由 Orchestrator 生成 `review_packet.md`
- 调用 runner（外部进程）并把调用命令写入 trace/ledger

示意（Claude；工具禁用）：

```bash
bash ~/.codex/skills/claude-cli-runner/scripts/run_claude.sh \
  --model opus \
  --tools '""' \
  --system-prompt-file prompts/plan_review_system_claude_strict.md \
  --prompt-file artifacts/runs/<TAG>/review/review_packet.md \
  --out artifacts/runs/<TAG>/review/reviewer_output.md
```

Gemini（无 MCP/tools 能力；天然 packet-only）：

```bash
bash ~/.codex/skills/gemini-cli-runner/scripts/run_gemini.sh \
  --model gemini-3.0-pro \
  --prompt-file artifacts/runs/<TAG>/review/review_packet.md \
  --out artifacts/runs/<TAG>/review/reviewer_output.md
```

对应的“可自动验收”的点：
- Orchestrator 的 trace/ledger 里必须记录 `--tools '""'`（或等价禁用）
- `review_packet.md` 的来源必须是 Orchestrator（而不是 Executor 自由文本）
- reviewer 输出必须符合固定输出契约（可用现有 `review-swarm` 的 contract checker）

## 5) 未来增强（M2+）

当 Reviewer 需要具备一定的“只读核查能力”（例如自己验证引用/编译）时，再引入更强隔离：

- OS 级 sandbox（容器/沙箱文件系统）+ 只读挂载
- Reviewer 专用的 “audit tool allowlist”（只读工具；所有访问可审计）
- 受控的网络 allowlist（只允许 INSPIRE/arXiv/DOI 等稳定锚点）

但无论如何：
- escalation 仍必须经人类批准；
- 任何写操作都不应由 Reviewer 执行。
