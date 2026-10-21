# 功能测试指南（front-door 当前真相）

本指南面向手工验收当前 front-door truth。`nullius` 是 generic lifecycle + workflow-plan front door；`@nullius/hep-mcp` 是当前最成熟的 domain MCP front door，提供 literature/data、项目内研究输出、Zotero、PDG 能力。本页重点覆盖两者的衔接，而不是把 `hep-mcp` 重新写成 root 产品身份。

> 说明
>
> - 返回值里的时间戳、路径、URI 等动态字段请按结构和不变量核对，不要逐字比对。
> - 下文 HEP 配置以 `packages/hep-mcp/dist/index.js` 为 domain MCP front door；个人插件另组合绑定项目的 `project-mcp` 叶层 adapter。
> - 大对象默认落盘成文件；验收时优先检查 tool result 摘要、返回的项目相对路径，以及 `project_root` 下的实际文件（下载与缓存位于 `artifacts/hep-mcp`，检索导出等研究输出工具写入调用方给定的 `output_dir`）或 scratch `HEP_DATA_DIR` 下的实际文件。

---


原生执行控制的定向检查：

```bash
pnpm --filter @nullius/orchestrator exec vitest run tests/execution-invariants.test.ts tests/execute-manifest-core.test.ts tests/execute-manifest-failure-policy.test.ts tests/computation-launch-stamp.test.ts tests/cli-run-workflow-recovery.test.ts
python3 -m pytest -q packages/project-contracts/tests/test_root_policy.py packages/project-contracts/tests/test_output_policy.py
```

这些检查覆盖审批内容绑定、暂停后的字节保持、最后一步竞争、总截止时间、锁内状态比较与根目录准入；它们不构成科学结果的独立验证。

外部项目边界的验收还应覆盖：从另一处运行时拒绝开发仓、尚未创建的仓内后代与仓目录别名，并确认拒绝发生在任何项目文件写入之前；同父目录的正常外部研究项目仍应可初始化。

## 0. 一次性准备

Julia 包的接口与生命周期规范见 [`julia-package`](../skills/julia-package/SKILL.md)，
性能测量见 [`julia-perf`](../skills/julia-perf/SKILL.md)。包测试、数值结果验收和
性能声明分别核验；benchmark 执行成功或阈值通过不单独构成速度声明的完整证据。

性能测量工具的定向回归可运行：

```bash
julia --startup-file=no --project=skills/julia-perf/scripts skills/julia-perf/tests/runtests.jl
```

这检查测量、baseline、状态与监督入口，不计算研究结果或证明加速。

### 0.0 先确认 front-door 角色

- `nullius` = generic lifecycle + workflow-plan + main-report structural-validation front door
- `research-harness` = Codex / Claude Code / OpenCode 的薄 external project skill；它只负责恢复项目真相、路由到 `nullius` / `research-team` / `markdown-hygiene` / `hep-mcp`、并要求结果折回 durable artifacts，不是新的 CLI 或第二套 control plane
- `.nullius/HARNESS` = `nullius init` 写入的机器可读 runtime handshake；存在时 agent 必须先取得 `nullius status --json` receipt，再开始新工作、milestone 执行、closeout 或 handoff
- `orch_*` = 同一 control plane 的 MCP/operator counterpart，不是第二个产品前门
- `@nullius/hep-mcp` = 当前最成熟的 domain MCP front door
- legacy Python CLI 不再属于公开 front-door；如仍需覆盖，只作为 maintainer/eval/regression-only 内部路径测试
- `nullius init` 使用 canonical generic scaffold；`.mcp.template.json`、根级 `specs/plan.schema.json`、`prompts/`、`team/`、`research_team_config.json` 等 optional support surfaces 只应由明确项目需要或 host-specific tooling 后续创建
- `nullius init --refresh` 生成缺失的 `AGENTS.md`，scaffold 保留已有定制指导及用户 seed 内容（`research_plan.md`、`research_notebook.md`、`research_contract.md`、`project_charter.md`、`project_index.md`、`reports/main_research_report_template.md`、`.gitignore`）；CLI 仍可能同步 notebook 和 index 中已存在的机器管理块，不会插入缺失块；`--dry-run` 可先预览。需要更新已有指导时，在开发仓外的临时 root 生成模板后手工合并。验证定制内容的原始字节、换行和权限保留，以及 `--dry-run` 零写入。
- `nullius init --mode=<engine|file>` 声明项目真相所在（engine=run/approve lifecycle 驱动；file=手工/外部 runner 执行、`run_status` 长期 `idle` 属正常），可随时重跑改声明。`nullius decision record|pending` 追加写 `.nullius/decisions.jsonl`，`decision list` 只读回放，`decision land` 只在分支尾已进入权威主干后原子落号。手动验收至少覆盖：
  - 在开发仓外临时 root 运行 `nullius init --runtime-only --mode=file`，再执行 `nullius decision pending "<问题>"`；打印的 id 必须是 6 字符 Crockford-base32 handle，`status --json` 必须把它计入 `pending_count`、`open_count` 和 `unlanded_count`。随后用该 handle 执行 `nullius decision record "<决定>" --resolves <handle>`，断言 open 数归零，两个 provisional 条目仍完整进入 decided/pending 计数。另用 `--relates <id>` 记录非关闭关系（`record` 与 `pending` 均可），断言它可以指向更早且可读的 decided/pending 条目，并且绝不改变 open 数；同一条 record 可以同时带 `--resolves` 与 `--relates`。
  - 执行 `nullius decision land --json`，断言它按当前主干 ledger 顺序分配后续 `D<n>`、把 answer 的 `resolves` 与任意 `relates` 改成 landed target id、在各条目保留 `provisional_id` 映射，并把 `unlanded_count` 清零；JSON 中的 `rewritten_resolution_count` / `rewritten_related_link_count` 必须与实际改写数一致。若所有 entry 已有 durable id、但迟到的 branch relation 仍指向旧 handle，land 仍须通过保留映射只改写该引用；再次对规范 ledger 执行才是零改写的幂等 no-op。展示顺序按毫秒精度 `ts`，不按随机 handle。
  - 对非 no-op landing，移除 ledger 的全部写权限位后必须拒绝且字节和权限不变。另在 replacement 临时文件已持久化、rename 尚未发生时注入外部修改，last-moment guard 必须拒绝覆盖并清理临时文件。该 guard 只缩小并发窗口：POSIX 没有针对非协作 writer 的可移植 compare-and-swap rename，不能宣称消除最终检查与 rename 之间的竞态。
  - 在 rename 已成功、但父目录 `fsync` 未获确认的 fault injection 中，命令必须明确报告 commit status uncertain，不得谎称零写入，并在两条恢复命令中带回原始 `--project-root`；此时先用 `decision list` 检查目标内容，再重跑 `decision land`。规范 ledger 的 no-op retry 必须实际执行 parent-directory `open`→`fsync`→`close` 来确认目录项持久性，不能只比较可见字节。
  - 手写一个唯一的既有 `D1` pending 条目，不运行 land；`decision list`、`status` 和 `decision record --resolves D1` 必须直接成功，且只读命令不得修改 ledger 字节。这是零迁移回归锁。
  - 手写一条 `resolves` 指向 decided、未来、已关闭或不可读目标的记录；每个坏链接都必须进入 `decision_ledger.unrecognized_relations`，但 containing record 仍须计数、列出且可按 id 寻址，`invalid_lines` 不增加，open 集只按其余有效关闭关系计算。对结构错误的持久化 `relates` 做同样的降级验收。新 CLI 写入仍须严格拒绝这些无效目标。
  - 手写旧版 `kind: "clarify"` 以及另一个未知的非空字符串 kind；两者都必须按当前 `decided` 语义读取，并在记录的 `source_kind` 与 `decision_ledger.normalized_kinds` 中标注原值。只有精确的持久化 `kind: "pending"` 可以增加 `open_count`；若归一化条目带有其余合法的 `resolves`，它仍按 decided 语义关闭 pending。非字符串、空 kind 与其他 core 字段损坏仍计入 `invalid_lines`。
  - 复制任意条目制造同 id 两行；`decision list` 必须非零退出并列出 id 与物理行号，`status --json` 的 `decision_ledger.duplicate_id_count` 必须为 1，`--resolves <重复 id>`、`--relates <重复 id>` 与 `decision land` 都必须拒绝，且 land 失败前后 ledger 字节完全相同。
  - 构造两条不同 `D<n>` 但保留同一 `provisional_id` 的记录，并另测一个当前 handle 与既有 `provisional_id` 重名；两者都必须由 `decision_ledger.ambiguous_provisional_id_count` 与具名行号显式报告，`decision list` 非零退出，相关 relation 被隔离，`decision land` 零改写拒绝。正常铸号必须避让本地已有 `provisional_id`。
  - `status` 文本必须渲染 `execution_mode`、open 项、`decisions_unlanded`、`decisions_unrecognized_relations` 与 `decisions_normalized_kinds`；file 模式下不得出现 `RECOVERY_PLAN_FOCUS_UNAVAILABLE`。未声明 mode、引擎状态冻结且已有日期 run 目录时，`project_surface_drift` 应出现 `EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE`（诊断提示，不阻塞任何命令）。
- reconnect 时应优先读取 `.nullius/HARNESS`、`.nullius/` state 与 project-local durable memory，例如 `research_plan.md`、`research_contract.md`、以及已有实质内容的 `research_notebook.md`
- `research_plan.md#Current Status` 是给人的当前状态入口；测试 scaffold/read-model 时要保证它被作为恢复指引暴露，同时不新增单独状态文档
- `research_notebook.md` 是问题逻辑主线，不是日期 run log，也不承载状态追踪；重要文献 note 必须记录全文/source-first 阅读、section/page/equation/figure 覆盖，并用 LaTeX math 写科学记号；测试 scaffold/read-model 时要保证空模板不会被误判为 substantive，同时真实逻辑内容会进入 reconnect recommended files
- `project_index.md#Main research report` 是主研究报告的唯一当前入口与 supersession registry。验收 `nullius report-validate` 时至少覆盖：短 status/closeout 冒充主报告、已有 superseding report 但 current pointer 未切换、机器 provenance 取代解释性叙事或人类证据、同实现/同输入/同环境 replay 被标作 independent validation；另验 hash 不可变和双向 supersession metadata。结构通过不等于 reviewer 对科学充分性的通过，禁止使用最小字数门槛
- `research-team` 的 team/draft cycle 使用 `artifacts/runs/<run_id>/research_team/`，父 run 持有来源记录；执行 receipt 与导航指针不授予科学验收。完整结论须写入新报告。

### 0.1 构建与计数检查

```bash
pnpm install
pnpm -r build
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
pnpm --filter @nullius/orchestrator exec vitest run tests/run-manifest.test.ts tests/agent-runner.test.ts tests/agent-runner-manifest.test.ts tests/agent-runner-ops-b8-regression.test.ts tests/tool-execution-policy.test.ts tests/tool-dispatch-boundary.test.ts tests/mcp-client-process.test.ts tests/workflow-runtime.test.ts
```

每次 vitest 运行把 `TMPDIR` 指向一个专属临时根 `<系统临时目录>/ntest-<uid>/<标签>-<进程号>-XXXXXX/`（标签取包目录名中的字母数字与 `._`，截取前 6 个字符；为空时用 `tests`）（`ntest-<uid>` 必须是本用户所有、权限 0700 的真实目录，被预先放置的符号链接或他人目录会被拒绝）（名字刻意短：测试工具会在 `TMPDIR` 下建本地套接字，macOS 上套接字路径超过约 104 字节就无法建立）：每个测试都跑完（通过、跳过或待办）、没有失败、运行没有被中断（如监视模式下按 Ctrl-C）、命令的退出状态仍为成功（如覆盖率门槛未达标会使其失败）、且监视模式下此前各次重跑都干净时才删除；失败或中断则保留供检查（空目录也保留；唯一的例外是未被中断、退出状态干净、一个测试都没跑且临时根也是空的命令，如 `vitest list`，静默删除），其中 7 天无任何改动、创建它的进程已结束、且带有创建时写入的来源标记文件 `.nullius-test-root`（内容与格式完全吻合的普通文件）的，由之后的运行清除，没有标记或标记不符的目录一律保留；设 `NULLIUS_KEEP_TEST_TMP=1` 时一律保留。各包 `vitest.config.ts` 的 `globalSetup` 接入 `scripts/lib/vitest-test-temp-root.mjs`；`scripts/tests/vitest-test-temp-root.test.mjs` 锁定接线，并用真实的 vitest 3 与 4 各跑一次通过、失败与只列不跑。

#### 执行恢复与第三方 runner 契约

```bash
pnpm --filter @nullius/orchestrator exec vitest run tests/cli-run-workflow-recovery.test.ts tests/agent-runner-history-compaction.test.ts tests/cli-run-workflow.test.ts tests/agent-runner.test.ts tests/workflow-runtime.test.ts tests/nullius-cli.test.ts
pnpm --filter @nullius/hep-mcp exec vitest run tests/contracts/inspireLiteratureProjectRoot.test.ts tests/toolContracts.test.ts tests/docs/docToolDrift.test.ts
python3 -m pytest -q skills/kimi-cli-runner/tests skills/opencode-cli-runner/tests skills/review-swarm/tests/test_seat_budget.py skills/dsh-cli-runner/tests
```

使用虚构工具与临时项目验证真正进程死亡、未知副作用停止、已提交响应回放、暂停和审批续接。压缩测试保留约束与完整工具配对，过长指令不通过删约束恢复。INSPIRE 七种模式的 catalog、parser 与 dispatch 接纳共同参数并拒绝错误模式参数。runner 测试使用虚构 CLI，验证空输出、异常退出、最终长度截断、总调用/时间预算及本地进程树清理；这不证明真实 provider 可用或科研结果正确。

Kimi/OpenCode 需要 Python 3.10 或更新版本；不满足时在调用模型之前拒绝运行。`--max-attempts` 是包括 fallback/续写的总 CLI 调用数，`--timeout-secs` 是包括 backoff 的总期限。review launcher 的同名预算统计每个 seat 的 runner 进程调用；Gemini 没有内层尝试数控制，不能把该统计声称为准确的底层 HTTP 请求数。每次调用保留 trace；`OUT.partial` 不算完成的 `OUT`。复制安装须重新从当前源码构建/安装并验证；本地定向检查不更新其他安装或已有外部项目。

#### 本地个人插件与项目 MCP

[`project-mcp`](../packages/project-mcp/README.md) 复用 canonical `handleToolCall` / `runCli`，目前暴露 16 个 `orch_*` 操作和 5 个 transport 工具，共 21 个。默认个人插件组合 project 21、HEP standard 52、idea 6，共 79 个不同工具名；非默认 HEP 模式或 provider 开关会改变 HEP 数量。[构建器](../packages/skills-market/docs/PERSONAL_PLUGIN.md) 生成不含本机路径的 Codex/Claude Code 清单，通过目标机器的 `nullius runtime mcp` 启动，不创建远端连接。普通 skills copy 安装同样不记录源机器目录。

构建完成后运行以下针对性检查：

```bash
node scripts/check-portable-paths-anti-drift.mjs
node scripts/check-harness-invocation-anti-drift.mjs
node --test scripts/tests/check-portable-paths-anti-drift.test.mjs
pnpm --filter @nullius/orchestrator exec vitest run tests/runtime-installation.test.ts
python3 -m pytest -q packages/skills-market/tests/test_personal_plugin.py packages/skills-market/tests/test_install_skill.py
NULLIUS_REAL_PLUGIN_SMOKE=1 python3 -m pytest -q -s packages/skills-market/tests/test_personal_plugin_live.py
pnpm --filter @nullius/project-mcp exec vitest run tests/research-loop.test.ts
pnpm --filter @nullius/project-mcp exec vitest run tests/harness-invocation.test.ts
```

真实迁移检查先构建一次插件与普通 skills copy 安装，再搬迁这两个既有产物及运行 checkout，删除原输出，配置新 CLI 和包外私有配置后运行。在临时外部项目初始化 `.nullius/HARNESS`、state 和项目 launcher，启动真实三个 server，仅发送 `initialize` / `tools/list`，检查工具无重名及进程 cwd；还执行复制后的 harness 帮助与 team scaffold。provider 数据目录也限于临时 fixture，不调用 provider 工具。研究闭环测试分别执行正常计算并登记已核验结果，以及篡改生产输出后拒绝错误的 operator pass。

项目入口核验测试显式设置 `NULLIUS_HARNESS_VERIFY=on`，覆盖首次初始化、过期记录拒绝且无副作用、status 恢复、后台执行再次核验、精确重放、符号链接边界和 sampling 内部调用；不能依赖默认测试环境跳过核验后的结果。

交付验收必须区分传输和研究：后台变更使用稳定 `delivery_id`，`outcome_unknown` 不得自动重试，`finalizing` 等待项目锁释放，`committed` 只代表原响应已持久化。还须保留项目文件越界拒绝、本地主机审批、缺少 sampling 时 `unavailable` 等边界；本机脚本不是 OS sandbox 中的代码。上述本地验收不证明 ChatGPT Chat/Work 或 Claude 宿主已接通，tunnel/app ID 和对应宿主验收仍待用户配置。

可选：跑自动化测试。

```bash
pnpm -r test
```

委托 runtime 的故障恢复验收必须覆盖：派发前 intent、跨进程 compare-and-claim、transport 中断后的 `outcome_unknown` 停机、已提交结果的逐字节 replay、审批请求不写 completed checkpoint、根审批后重跑原 producer、root/direct/team 三个 journal namespace 的结构隔离，以及 denied/approval-resolver 批次的 underlying transport 零调用。MCP 子进程验收必须覆盖 ambient credential canary、authenticated proxy 不继承、generic explicit/required credentials、初始化失败、unexpected parent exit 与 timeout 后孙进程不再产生 sentinel、重连预算、timeout 后禁止重连，以及幂等 close。

如需联网 smoke，再显式开启：

```bash
HEP_LIVE_SMOKE=1 pnpm -r test
```

### 0.2 准备一个干净的数据目录

建议每次验收使用隔离的数据根。一次性检查可设置新的 `HEP_DATA_DIR` 或使用默认 scratch；如果结果需要后续验证或接续，应在工具调用中传入已初始化 nullius 项目的 `project_root`，使数据写入该 project root 的 artifact 子目录。

- `/Users/<you>/tmp/hep_data_test_001`
- `project_root=/absolute/path/to/external-project` -> `/absolute/path/to/external-project/artifacts/hep-mcp`
- `project_root` 按规范（解析掉符号链接后的）形式接纳，必须位于 nullius 开发仓之外；工具结果与报告里显示的是规范路径。本次调用实际使用的项目内目录必须经真实目录到达：工具调用使用 `artifacts/`、`artifacts/hep-mcp/` 与 `artifacts/hep-mcp/pdg/`，其中任何一级是符号链接（含悬空链接）时调用以 `UNSAFE_FS` 拒绝。

### 0.3 在 MCP 客户端里接入当前 domain MCP front door

当前公开 MCP contract 是本地 stdio 进程启动、tool `inputSchema`、紧凑 JSON/text tool result、没有 prompts。MCP env 里的路径是本地文件 / artifact / cache root，不是 URI/protocol 设置。Remote HTTP/OAuth、registry publishing 与独立 root MCP server 不属于当前验收面。

最小配置示例：

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/nullius/packages/hep-mcp/dist/index.js"
      ],
      "env": {
        "HEP_DATA_DIR": "~/.nullius/hep-mcp",
        "HEP_TOOL_MODE": "standard",
        "HEP_DOWNLOAD_DIR": "~/.nullius/hep-mcp/downloads"
      }
    }
  }
}
```

**预期**

- 重启或刷新 MCP client 后，可以看到 `hep-mcp` 提供的工具。
- 某些客户端会把工具名 namespacing 成 `mcp__<serverAlias>__<toolName>`；务必以客户端实际显示的名字为准。
- 若 GUI 客户端报 `spawn node ENOENT`，把 `command` 改成 Node 的绝对路径。

### 0.4 `listTools` sanity check

当客户端看不到工具时，优先检查 `listTools` 是否返回合法 schema：

```bash
cd /absolute/path/to/nullius/packages/hep-mcp
node --input-type=module - <<'EOF'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function check(mode) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, HEP_TOOL_MODE: mode },
  });

  const client = new Client({ name: `toolcheck-${mode}`, version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const bad = tools
    .map(t => ({ name: t.name, type: t.inputSchema?.type }))
    .filter(t => t.type !== 'object');
  await client.close();
  return { mode, tool_count: tools.length, bad };
}

const results = [];
for (const mode of ['standard', 'full']) results.push(await check(mode));
console.log(JSON.stringify(results, null, 2));
EOF
```

**预期**

- `standard` 模式工具数为 `52`
- `full` 模式工具数为 `58`
- `bad` 为空数组

### 0.5 可选依赖：Zotero / PDG

若要验收本地文献库或离线粒子数据，再补充：

- Zotero Local API：`ZOTERO_BASE_URL=http://127.0.0.1:23119`
- Zotero fulltext cache：`ZOTERO_DATA_DIR=/absolute/path/to/Zotero`
- PDG sqlite：`PDG_DB_PATH=/absolute/path/to/pdg.sqlite`

---

## 1. 基础连通性

### 1.1 `hep_health`

**调用**

```json
{}
```

**预期**

- 返回成功
- 能看到当前工具模式、基础配置或健康摘要

## 2. 项目内输出目录

### 2.1 `hep_inspire_search_export`（写入项目内 `output_dir`）

先在开发仓外的临时目录执行 `nullius init`，作为 `project_root`。

**调用**

```json
{
  "project_root": "/absolute/path/to/external-project",
  "output_dir": "artifacts/runs/<run_id>/literature",
  "query": "pentaquark",
  "max_results": 5
}
```

**预期**

- `output_dir` 不存在时被创建
- 返回的 `export_path` / `meta_path` 是项目相对路径，指向 `output_dir` 下真实存在的文件
- `<output_dir>/external_api/` 下有本次调用的外部 API 请求/响应记录，`output_dir` 下另有 `inspire_search_export_<hash>_diagnostics.json`
- 返回的文件位置都是项目相对路径，不含 `hep://` URI
- 用同一 `output_dir` 原样再调用一次：被拒绝（提示文件已存在），且在任何 INSPIRE 请求之前；第一次写出的文件字节不变

### 2.2 `output_dir` 拒绝条件

分别用以下 `output_dir` 重复上一调用：

- 不传 `project_root`
- `output_dir` 等于 project root 本身（如 `"."`）
- 位于 `.nullius/`、`team/runs/` 或 `artifacts/hep-mcp/` 之下
- 路径中 project root 以下的某一级是符号链接（含悬空链接，无论指向何处）
- 相对路径用 `..` 走出 project root

**预期**

- 每种情况都被拒绝，且拒绝前不在项目内写出任何输出文件
- 调用中途失败（如 INSPIRE 返回畸形记录）时，`output_dir` 下不留下本次调用的任何文件（已建的目录可留下）；若清理失败，错误会写明残留：已发布的文件删不掉时，错误为 UNSAFE_FS，写明输出不完整并在 `files_left` 中列出它们（残留的暂存文件列在 `staging_left`）；只有暂存文件删不掉时，保留原错误并附 `staging_left`；无法识别的暂存文件在 `staging_path` 中给出；删除之后若无法刷盘，错误为 UNSAFE_FS 并列出 `unflushed_directories`
- 经 project root 的别名（例如指向同一目录的上层符号链接）拼写的绝对 `output_dir` 仍被接受，返回的仍是项目相对路径

---

## 3. 文献 / 数据工作流

### 3.1 `inspire_search`

**调用**

```json
{ "query": "pentaquark", "size": 5 }
```

**预期**

- 返回受限数量的结果
- 可拿到 `recid` 或标识符用于后续调用

### 3.2 `inspire_literature`

**调用**

```json
{ "mode": "get_paper", "recid": "1833986" }
```

**预期**

- 返回单篇论文的结构化元信息
- `get_paper` 不需要 `size`
- `lookup_by_id` 语义上只传 `identifier`；agent 误带的 `size` 会被忽略，但不要主动附带
- `get_author` 语义上只传 `identifier`；agent 误带的 `size` 会被忽略，但不要主动附带

### 3.3 `inspire_topic_analysis`

**调用**

```json
{ "mode": "timeline", "topic": "pentaquark", "limit": 10 }
```

**预期**

- 返回 timeline / evolution 相关摘要

### 3.4 stateful literature workflow consumers

这部分不是 MCP 工具，而是当前真实存在的高层 workflow consumers：

```bash
nullius workflow-plan \
  --recipe literature_landscape \
  --phase prework \
  --run-id 20260502T023000Z-m0-bootstrap-prework-r1 \
  --query "bootstrap amplitudes" \
  --topic "bootstrap amplitudes"
```
先在目标外部 project root 执行 `nullius init`，然后在该 root 内或通过 `--project-root` 调用。这个推荐的公开 stateful front door 会直接通过 `@nullius/literature-workflows` 解析 checked-in workflow authority，并写入 `.nullius/state.json#/plan` / `.nullius/plan.md`。有意义的外部研究运行应显式传入 safe、sortable、readable 的 `--run-id`；如果省略，派生的 `<recipe>-<phase>` 只作为 planning placeholder。

轻量研究头脑风暴/收敛入口使用同一 front door：

```bash
nullius workflow-plan \
  --recipe research_brainstorm \
  --run-id 20260502T023000Z-m0-bootstrap-r1 \
  --topic "bootstrap amplitudes"
```

`research_brainstorm` durable harness 持久化 brainstorm context、candidate angles、screening matrix、single recommendation 与 `next_contract` artifact hints。`.nullius/state.json#/plan` 是机器 SSOT，`.nullius/plan.md` 只是派生 read model；`next_contract` 可以建议后续 recipe，但不会自动启动重流程，也不依赖 host-native thinking process。它是 planning-only harness：持久化的 `research_brainstorm.*` step tools 是 handoff authority，不是内置 runnable tool chain。它不是 idea-engine、不是 full research-team、不是新的 root front door。

> Maintainer / eval / regression only:
>
> 旧的 provider-local Python parser 已删除；maintainer/eval/regression proof 现在改由 lower-level checked-in coverage 提供：
>
> `pnpm --filter @nullius/literature-workflows test -- tests/resolve.test.ts`
>
> `pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts`

**预期**

- `nullius workflow-plan` 仍是唯一 installable public high-level literature entrypoint
- lower-level checked-in runner / resolver / front-door coverage 仍能证明 `literature_gap_analysis` recipe、seed-search 解析、analyze-step wiring 与 live CLI truth
- literature saturation contract 还应保留覆盖每个 declared query 的有界 provider request/page-or-cursor/continuation 账本（known total 完整、末次 continuation exhausted）、逐候选 discovery/disposition、逐 core source bibliography reconciliation、exact-SHA archived canonical-identity provenance 与 coverage-debt 语义、每个 reconciliation candidate 的 source-text method-screening disposition，以及 source-grounded method-family audit/citation-graph coverage；展示 URL 只有在同时是已归档 canonical id/alias 时才参与 identity join；两个 summary receipt 必须绑定同一个 project-root-bounded exact-SHA ledger，并由 writeback 从详细内容重算，缺少任一项时不得把 bounded traversal 的停止状态提升为 `saturated`
- `research_brainstorm` durable harness 通过同一个 entrypoint 验证 harness-step 解析、artifact hints、state plan 与 read-model 恢复；它输出后续 handoff contract，但不自动启动重流程

---

## 4. 本地 reference providers

### 4.1 `zotero_local`

**调用**

```json
{ "mode": "list_collections", "limit": 5 }
```

**预期**

- 若 Zotero Local API 可用，应返回本地 collections

### 4.2 `pdg_info`

**调用**

```json
{}
```

**预期**

- 若 `PDG_DB_PATH` 已设置，应返回本地 DB 与 artifacts 目录信息

### 4.3 `pdg_find_particle`

**调用**

```json
{ "name": "electron", "limit": 5 }
```

**预期**

- 返回候选粒子列表

---

## 5. 常见排障

- 工具看不到：先做 `pnpm -r build`，再跑上面的 `listTools` sanity check
- 找不到输出文件：先确认 tool call 是否传入 `project_root`（写文件的工具还需 `output_dir`）。有 `project_root` 时，下载与缓存在 `<project_root>/artifacts/hep-mcp`，写文件的工具输出在 `output_dir`；没有时检查本轮 `HEP_DATA_DIR` 或默认 scratch 根。`HEP_DOWNLOAD_DIR` 只对非 `project_root` scratch/override 模式生效，且必须位于 HEP data root 之内
- GUI 客户端找不到 Node：把 `command` 换成 Node 的绝对路径
- 想看 generic lifecycle state：不要从 `hep-mcp` 猜，直接使用 `nullius status --project-root ...`

---

## 6. 相关文档

- [`README.md`](../README.md)
- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/TOOL_CATEGORIES.md`](./TOOL_CATEGORIES.md)
- [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)

新项目运行统一位于 `artifacts/runs/<run_id>/`，team/draft 执行记录放在其 `research_team/` 子目录，来源记录盖章在父 run 上。旧 `team/runs` 保留为只读证据，状态、列表、索引和导出使用其原位置，不改写来源、有效性或结果引用；`init --runtime-only` 可重新连接而不移动证据。同名编号明确报告歧义，不可读历史位置报告为不可用，不阻断无关的可读记录。`inventory_run_relocation.py --fixture-root <匿名fixture> --source-manifest <哈希清单>` 只盘点已固定输入的引用、冲突与未解决绑定，没有 apply 模式。独立 reviewer 快照排除所有轮次的执行 payload 和工作区树，保留生产输入；读取仅允许自己的声明输出前缀。历史报告与裁决保留给协调者。`team/LATEST*.md` 与 `artifacts/LATEST.md` 只提供导航。

Carrier ownership checks must cover direct and reverse pointer aliases before any navigation write. Existing `PROJECT_INDEX_AUTO` blocks are unmaintained historical observations; test that helper execution preserves their exact bytes. Live `init --help` must match preserve-existing refresh behavior.

Historical run admission is covered by `packages/orchestrator/tests/run-history-reading.test.ts`: original paths and bytes, origin/validity/result selection, both run export/list surfaces, runtime-only reconnect, scoped unavailable paths, duplicate IDs, and refusal of historical execution writes. Python research-team tests cover historical round discovery and canonical write admission.

Notebook integration regression checks:

```bash
pnpm --filter @nullius/orchestrator exec vitest run tests/notebook-result-links.test.ts tests/notebook-run-links.test.ts tests/notebook-current-state.test.ts
python3 -m pytest -q skills/research-team/tests/test_convergence_registration_gate.py
```

These include adopted results with only an automatic table, unclosed comments,
raw HTML inside quotes/lists, visible links at paragraph/heading boundaries,
literal artifact filenames containing `%` or `?`, wrong-file URI matches, and
headline convergence without a human rewrite. These link tests establish
structural navigation only.

The notebook guidance drift checks compare generated project instructions, active
team inputs, rendered adjudication guidance, public budget descriptions and CLI
help against executable review defaults. They
include controlled outdated-limit and incomplete-original-review regressions.
Public init, refresh preview, refresh and runtime-only refresh must preserve
custom `AGENTS.md` and host instructions byte-for-byte, including modes and CRLF.
The [existing-project update](QUICKSTART.md#updating-existing-project-guidance)
uses a separate template preview and explicit merging.

```bash
pnpm --filter @nullius/orchestrator exec vitest run tests/notebook-review-guidance.test.ts tests/notebook-review-batches.test.ts
python3 -m pytest -q packages/project-contracts/tests/test_scaffold_contract.py packages/project-contracts/tests/test_scaffold_preserves_user_contract.py
python3 -m pytest -q skills/research-team/tests/test_notebook_capacity_prompt_drift.py skills/research-team/tests/test_build_adjudication_response.py
```

Content-review acceptance checks must additionally cover real reviewer dispatch,
bounded original-text calls under one hard budget and no automatic retry, full UTF-8 notebook
snapshot identity including the automatic block, declared dependency hashes,
and edits not represented by a commit. A report needs complete per-section
coverage and source-anchored reasons on derivations, logic, notation, definitions,
assumptions and conventions. Include missing, partial, failed, unavailable,
invalid and stale reports as negative controls; changing either the notebook
or a dependency must invalidate current acceptance while keeping history readable.

Include notebooks individually above 1 MiB, recursively linked text files
individually below that size with a larger total closure, UTF-8/formula boundaries,
late missing derivations, distant conflicting definitions, omitted original
intervals or joint coverage, and changes during or after execution. Verify whole
raw stdin delivery and the complete-original joint packet separately from actual
model recognition. Test small and batched capacity/compaction refusal, storage
and call shortfalls, honest pending scopes and immutable resume. For independent
verification, execute the runner and final consumer: same/similar sound methods
with genuine independent construction can count, while contaminated different
methods, original-code reruns, relevant defects and checkbox-only evidence cannot.
An explicit different-method risk condition needs source-grounded risk evidence,
not different hint labels. Keep the minimum two-independent-evidence floor.

Default `notebook check` must report `structure` and `content_review` separately
and fail unless both pass for the current version. `--result` may only narrow
links, never full-text coverage; `--structure-only` may succeed for navigation
without granting closeout. File/engine convergence must consume the same current
review. Status/current reads must not launch a reviewer or fail merely because
content acceptance is absent. Fixtures and mocked dispatch test these contracts;
they do not establish scientific correctness or substitute for executing a real
reviewer on a research notebook.

Valid UTF-8 text remains text regardless of size; Markdown links are discovered
recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
snapshots and hash locators, not read evidence. Every opaque path/hash needs a
specific `opaque_sources` assessment; a required unread source prevents acceptance.
Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings.

The complete material is frozen before review. Storage (`--snapshot-bytes`,
default 512 MiB; `--max-files`, default 256) is separate from each request's
`--context-bytes` and configured backend `--context-tokens` window (default
200,000 tokens, with instruction/output reserves). Default request bytes use a
conservative token upper bound. A larger explicit byte packet requires captured
backend token usage when that bound exceeds the window; missing capacity evidence,
observed backend compaction or delivery failure supplies no acceptance.

Larger materials use original UTF-8 intervals with adjacent original context,
followed by a joint audit receiving the COMPLETE original notebook and text
dependencies. All intervals and the joint audit must be complete and fresh;
selected quotations or summaries cannot replace this original input. The default
execution budget is 1200 seconds and 64 calls (`--timeout-secs`, `--max-batches`),
with one attempt per call and no automatic retry. Shortfalls expose total frozen
material, pending intervals and joint scope, the reason and a resumable command.
An unfinished intake reports discovered material and incomplete dependency
enumeration. `--resume <run-id>` creates a new run, revalidates original receipts
and material identity, retains explicit dependencies and storage budgets, and
never rewrites old evidence. If the full joint input does not fit the backend,
raise an available backend's request budget or leave the review incomplete.
Only tool mode `none` is accepted. Multiple batches are one semantic review;
they do not establish independent confirmations or a cross-family quorum.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

Negative controls must cover a converged fold with `none` declarations, a missing
launcher, and an otherwise linked selected result with an unlinked current result
outside the selector. Opaque-source controls must cover missing assessments,
path/hash mismatches, required unread sources, manifest staleness and both size
limits; pinned binary bytes alone must never count as semantic coverage.

Exercise the real audited `files_written` path: accepted source must match the member's complete original output, and arbitrary preseeded code must reject. Test neutral packet selection in ordinary team modes, missing-packet refusal, exact original bytes in both member stages and contamination through a later allowed read. A route label supplies no blindness judgment. Multi-judge tests must use independently worded, source-valid complete assessments and reject approvals assembled from partial axes or different lane sets. Unconverged results retain diagnostics but publish no agreed answer. Reproduction assessments must be newly executed by the gate, with capacity bound to the same successful original request and report; imported or foreign failed receipts cannot pass.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

Research storage fixtures cover semantic classifications, aggregate admission, bundle content detection, duplicate index objects, zero-write inspection and byte-exact restoration. Run `python3 -m pytest skills/research-harness/tests/test_run_storage.py` and `pnpm -C packages/orchestrator test tests/run-origin-foreign-paths.test.ts tests/validity-ledger.test.ts tests/traceability-stage3.test.ts`. See [Research output storage](RUN_STORAGE.md).
