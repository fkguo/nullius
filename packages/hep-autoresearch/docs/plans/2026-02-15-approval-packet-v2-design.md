# Approval Packet v2（packet_human + packet_full）设计

- Date: 2026-02-15
- Status: APPROVED（对话确认；实现将在迁移后的新根目录进行）
- Owner: hep-autoresearch Orchestrator CLI

## 0. 背景与问题

当前 `hep-autoresearch request-approval` 生成的审批包（现为 `packet.md`）对人类几乎不可读：信息密度偏向溯源字段堆叠，但缺少“我该不该批”的决策材料。以 A3（compute gate）为例，审批包往往只有泛化的 plan（例如“Validate run_card / Execute phases”），缺少：

- 真实将执行的命令（含已解析参数）
- 参数覆盖差分（default vs override）
- 预期输出与 DoD（如何验收/失败怎么办）

目标：让人类用户在 30 秒内完成“批/不批”判断，同时保留 evidence-first 的完整可审计溯源信息。

## 1. 术语澄清（避免混淆）

- **Gate（A1–A5）**：Orchestrator 的审批门禁类别（见 [docs/APPROVAL_GATES.md](../APPROVAL_GATES.md)）。例如 **A3=compute_runs**，表示“需要人类批准后才能继续执行可能耗时/耗资源的计算类动作”。
- **Workflow**：Orchestrator 的工作流（例如 `computation`）。
- **Phase**：`computation` 的 run_card v2 中的 `phases[*]`（例如 `phase_id=solve_numerics`），不是 Gate。

本设计解决的是“**Gate 触发后如何生成可决策的审批包**”，不是修改用户项目中的 phase DAG。

## 2. 总体方案（双文件：人类决策卡 + 全量溯源）

每次进入 `awaiting_approval`（无论是手动 `request-approval` 还是自动 gate）都写两份文件，并把路径写入 ledger（append-only）。

### 2.1 输出文件（固定路径结构）

审批目录：

- `artifacts/runs/<RUN_ID>/approvals/<APPROVAL_ID>/`

其中写入：

1) `packet_human.md`：**1 页决策卡**（中文默认；可 `--lang zh|en`）

2) `packet_full.md`：**完整溯源**（保留当前 `packet.md` 的信息量，并分层）

> 备注：本项目未发布，不以“旧 `packet.md` 兼容”为约束；实现可选择：
> - 直接用 `packet_full.md` 替代旧 `packet.md`（推荐：明确语义），或
> - 同时写一个 `packet.md` 作为 `packet_full.md` 的副本（可选便利，但不作为契约）。

### 2.2 State / Ledger

State（见 [docs/ORCHESTRATOR_STATE.md](../ORCHESTRATOR_STATE.md)）的 `pending_approval` 扩展：

- `packet_path`: 指向 `packet_human.md`（默认给人看）
- `packet_human_path`: 指向 `packet_human.md`
- `packet_full_path`: 指向 `packet_full.md`

Ledger 的 `approval_requested.details` 至少包含：

- `approval_id`, `category`
- `packet_human_path`, `packet_full_path`
- 可选：`suite_snapshot_path`, `suite_snapshot_sha256`（当使用 `--suite` 时）

## 3. `packet_human.md` 格式（固定六段，≤5 行/段）

文件顶部固定 6 段，顺序固定、每段 ≤5 行（短句/要点，不做长篇叙述）：

1) 做什么  
2) 为什么  
3) 成本（时间&资源）  
4) 风险  
5) 回滚  
6) 你要看什么判据（DoD）

接下来按 workflow 追加“决策所需细节”。本设计优先覆盖 `computation`（A3 的主战场）。

### 3.1 顶部六段的文字模板（用于 golden test 与稳定解析）

`packet_human.md` **必须始终包含**以下 6 个二级标题（header 文案为字面常量，保证可测试性）：

当 `--lang zh`：

```markdown
## 做什么
- ...

## 为什么
- ...

## 成本（时间&资源）
- ...

## 风险
- ...

## 回滚
- ...

## 你要看什么判据（DoD）
- ...
```

当 `--lang en`：

```markdown
## What
- ...

## Why
- ...

## Cost (time & resources)
- ...

## Risks
- ...

## Rollback
- ...

## Definition of Done (DoD)
- ...
```

规则（deterministic）：

- 每个段落 **必须**有 1–5 行 `- ` 开头的 bullet；若无内容，写 `- N/A`
- 不允许省略任一段落（避免输出结构漂移）

### 3.2 Consensus（可选加分项，放在六段之后）

若存在 `review-swarm` 双审输出（例如 Opus + gemini-3-pro-preview），则在六段之后自动插入：

- `## Consensus`
  - `- Opus: VERDICT ... — <1 句 blocker 摘要> (file: <path>)`
  - `- Gemini: VERDICT ... — <1 句 blocker 摘要> (file: <path>)`

规则：

- 仅当两份 reviewer 输出文件均存在且能解析出 `VERDICT:` 时插入，否则不插入该段
- 摘要句只允许 1 句，且必须包含可点击的文件指针（便于定位）

## 4. computation：必须自动补齐的决策材料

### 4.1 参数差分表（run_card v2 + overrides）

对 `computation`，`packet_human.md` 必须包含参数差分表：

仅列出 **与 run_card 默认值不同** 的参数行：

`key | default | override | why`

来源：

- default：run_card v2 的 `parameters.<key>.default`（按声明 type 类型化）
- override：参数覆盖（来源见 §5 suite/CLI）
- why：优先来自 suite（若提供），否则为空

排序规则（deterministic）：

- 按 `key` 进行字典序升序

表示规则（deterministic）：

- `default/override` 使用 JSON 规范化表示（数字/布尔不带多余格式；字符串按原值）
- 若某参数未声明 default，则 `default` 显示为 `(no default)`；只要存在 override 就视为差分

#### 4.1.1 overrides 合并与类型化（hard requirement）

覆盖参数的来源与优先级（从低到高）：

1) run_card `parameters.<key>.default`  
2) CLI `--param <key>=<value>`（全局覆盖；suite 模式下对所有 runs 生效）  
3) suite `runs[*].params.<key>`（run 级覆盖；仅对该 run 生效）

规则：

- 覆盖参数必须 **按 run_card `parameters.<key>.type` 严格类型化**：`integer|number|string|boolean`
- 未在 run_card 声明的参数 key：**直接报错退出（fail-closed）**
- 类型不匹配或无法解析（例如 `boolean` 给了 `"maybe"`）：**直接报错退出（fail-fast）**
- 差分仅在“类型化后比较不相等”时才显示（例如 default=2001，override="2001" 解析为 int 后相等 → 不显示）
- `why`：优先取 suite 的 `why`；若覆盖来自 CLI，则 `why` 为空

### 4.2 将实际执行的命令（从 backend.argv 渲染，含已解析参数）

对每个 phase，列出“将执行的命令”（**参数已解析**，避免人类猜测）：

- phase 顺序：拓扑排序（与 `computation` 执行一致；见 [src/hep_autoresearch/toolkit/computation.py](../../src/hep_autoresearch/toolkit/computation.py)）
- 每个 phase 展示：
  - `phase_id`
  - `cwd`: `<PROJECT_DIR>/<backend.cwd>`
  - `argv`: 对 `backend.argv` 做 `${param}` 替换后的 token 列表
  - （可选）`timeout_seconds`、`gates`

路径去非确定性（deterministic）：

- 不输出绝对路径
- 将 workspace/output 引用统一写成占位符：
  - `<REPO_ROOT>`：仓库根目录
  - `<PROJECT_DIR>`：插件项目根目录
  - `<WORKSPACE>`：`artifacts/runs/<RUN_ID>/computation`
- 若 argv 中存在 `phases/...` 形式的输入路径，渲染为 `<WORKSPACE>/phases/...`（而不是绝对路径）

命令行渲染（deterministic）：

- 使用稳定 quoting：**逐 token 使用 Python `shlex.quote()`（POSIX 规则）**，作为唯一 SSOT

参数替换 fail-fast（hard requirement）：

- 若 `backend.argv` 中存在 `${param}` 但无法从 run_card defaults 与 overrides 解析得到该参数值：**在生成审批包前直接报错退出**
- 禁止将未解析的 `${param}` 原样写入 `packet_human.md`（避免“看似可运行但实际会炸”的误导）

### 4.3 DoD（验收判据）自动生成

优先从 run_card v2 自动生成 DoD：

- `acceptance.json_numeric_checks`：逐条列出（路径、pointer、min/max）
- `headline_numbers.extract`：逐条列出（tier、label、pointer）

在 `packet_human.md` 的 DoD 段中只保留“可 30 秒核对”的摘要，例如：

- “所有 acceptance checks 通过（详见表）”
- “headline numbers 可从 `<path>` 提取到 N 项（含至少 1 个 T2/T3）”

同时在 `packet_full.md` 中保留完整列表（含结构化 JSON 版本，见 §7.3）。

## 5. 多-run suite（r3/r4/r5 网格收敛等）

### 5.1 新增：`hepar request-approval --suite suite.json`

用途：在单个 `packet_human.md` 中列出每个 run 的：

- “仅差异参数”（§4.1）
- “将执行的命令”（§4.2，可选简化为每 phase 一行）
- “DoD”（§4.3 + suite-level DoD）

### 5.2 suite 文件结构（schema_version=1）

建议的 `suite.json`（示意；对应 JSON Schema 见下）：

```json
{
  "schema_version": 1,
  "suite_id": "A3-suite-2026-02-15-r1",
  "workflow_id": "computation",
  "runs": [
    {
      "run_id": "M0-grid-r3",
      "run_card": "examples/schrodinger_ho/run_cards/ho_groundstate.json",
      "project_dir": "examples/schrodinger_ho",
      "params": {
        "n_grid": { "value": 2001, "why": "baseline" }
      },
      "dod": [
        "RMSE < 1e-8 (from run_card.acceptance)",
        "Record runtime minutes"
      ]
    },
    {
      "run_id": "M0-grid-r4",
      "run_card": "examples/schrodinger_ho/run_cards/ho_groundstate.json",
      "params": {
        "n_grid": { "value": 4001, "why": "grid refine" }
      }
    }
  ],
  "suite_dod": [
    "Convergence: |RMSE(r4)-RMSE(r3)| decreases with refinement"
  ]
}
```

约束：

- `workflow_id` 先限定 `computation`（v1 scope）
- `runs[*].run_id` 必填且互异（用于生成 `<WORKSPACE>` 占位）
- `run_card` 必须是 repo_root 内的相对路径（避免不可审计的外部引用）
- `params` 会按 run_card.parameters 的 type 做 coercion；未知参数一律 fail-closed
- `project_dir` 可选；缺省时从 `run_card` 推断 `<project_dir>/run_cards/...`（与现有 `computation` 逻辑一致）
- `params` 支持两种写法（实现必须归一化）：
  - 标量：`"n_grid": 4001` 等价于 `{"value": 4001, "why": null}`
  - 对象：`"n_grid": {"value": 4001, "why": "grid refine"}`

#### 5.2.1 suite JSON Schema（v1，最小可执行契约）

实现时建议将该 schema 固化为 `specs/approval_suite_v1.schema.json`（并在 CLI 中强制校验，unknown keys fail-closed）。

注：在 `params` 的标量类型里仅保留 `number`（不单列 `integer`），因为 JSON Schema 中 `integer` 是 `number` 的子集；在 `oneOf` 同时列出两者会导致整数值出现“同时匹配多个分支”的歧义。真正的 `integer|number|string|boolean` 约束由 run_card `parameters.<key>.type` 的类型化/校验负责。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "hep-autoresearch:approval_suite_v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "suite_id", "workflow_id", "runs"],
  "properties": {
    "schema_version": { "const": 1 },
    "suite_id": { "type": "string", "minLength": 1 },
    "workflow_id": { "enum": ["computation"] },
    "runs": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["run_id", "run_card"],
        "properties": {
          "run_id": { "type": "string", "minLength": 1 },
          "run_card": { "type": "string", "minLength": 1 },
          "project_dir": { "type": "string", "minLength": 1 },
          "params": {
            "type": "object",
            "additionalProperties": {
              "oneOf": [
                { "type": "string" },
                { "type": "number" },
                { "type": "boolean" },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["value"],
                  "properties": {
                    "value": {
                      "oneOf": [
                        { "type": "string" },
                        { "type": "number" },
                        { "type": "boolean" }
                      ]
                    },
                    "why": { "type": "string" }
                  }
                }
              ]
            }
          },
          "dod": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "suite_dod": { "type": "array", "items": { "type": "string" } }
  }
}
```

### 5.3 suite 与 A3 gate 的“生效”语义

为了让“一次 A3”真实 gate 整个套件，v1 **必须实现**套件执行入口（否则每个子 run 仍会各自触发一次 A3，审批体验会被 spam）：

- 设计要求（v1 必做）：新增 `hepar run --suite suite.json`（或等价的 suite-run 命令），作为套件执行入口
- 该入口将：
  - 先触发一次 A3（生成 suite 审批包）
  - A3 批准后，按 `suite.json` 的 `runs` 数组输入顺序依次触发每个子 run 的 `computation` 执行

可发现性（v1 必做）：

- suite 审批包除写入 `<ENVELOPE_RUN_ID>` 的 approvals 目录外，还应在每个子 run 的 approvals 目录写入一份 **内容相同** 的副本（便于从任一 run 目录回溯审批）。

## 6. `packet_full.md`（全量溯源）分层建议

目标：保留现有 `packet.md` 的审计信息，但结构清晰、可定位。

建议层次：

- L0: 元信息（approval_id、category、run_id/workflow_id、context pack、run-card SHA256、plan step 等）
- L1: 决策摘要（可直接链接到 `packet_human.md`）
- L2: workflow-specific details（`computation` 的参数解析结果、命令渲染、DoD 结构化对象）
- L3: gate resolution trace（若存在；与 adapter 逻辑一致）
- L4: 原有 Purpose/Plan/Budgets/Risks/Outputs/Rollback（尽量保留现有字段）

## 7. Determinism 规则（硬约束）

### 7.1 排序规则（固定）

- suite runs：按 `suite.json` 的 `runs` 数组输入顺序（既是渲染顺序，也是执行顺序）
- 参数差分：按 `key` 字典序升序
- phases：拓扑序（若多解，按 phase_id 字典序打破平局）
- 表格行：固定顺序，不做“按值排序”等可能随格式变化的排序

### 7.2 时间戳

- `generated_at` 单独字段/单独行出现
- 不将时间戳嵌入路径或标题（approval_id 自身是序列号，稳定）
- 格式固定为 UTC：`YYYY-MM-DDTHH:MM:SSZ`

### 7.3 机器可执行 DoD（v1 必须）

在 `packet_full.md` 中嵌入一个结构化 JSON，**且**同时落盘为 `dod.json`（机器可消费 SSOT；避免从 Markdown 解析）：

```json
{
  "schema_version": 1,
  "workflow_id": "computation",
  "runs": [
    {
      "run_id": "M0-grid-r3",
      "acceptance": { "json_numeric_checks": [...] },
      "headline_numbers": { "extract": [...] }
    }
  ],
  "suite_dod": [...]
}
```

用途：后续可以做“自动验收/自动 fail closed”而不依赖人类阅读。

### 7.4 JSON 规范化（deterministic）

- `packet_full.md` 内嵌 JSON、`dod.json`、以及所有 “default/override” 值的 JSON 表示均使用 **JSON key 排序**（`sort_keys=true`）
- 禁止把不稳定字段（例如绝对路径、随机数、运行时探测到的临时目录）写入 JSON SSOT；这些必须通过占位符表达或单独字段记录

## 8. CLI 选项（v1）

对 `hep-autoresearch request-approval`：

- `--lang zh|en`（默认 `zh`）
- `--suite <path>`（与手动 `--plan/--risk/--output` 组合时，规则：suite 负责 computation 细节；其余字段作为额外补充）

可选（非 v1 必需）：

- `--human-only` / `--full-only`：用于调试；默认仍写两份（契约不变）

## 9. 测试与验收（实现完成后的 Definition of Done）

### 9.1 Golden test（至少 1 个）

给定固定 run_card + 覆盖参数，`packet_human.md` 输出应稳定且包含：

- 六段顶部字段（做什么/为什么/成本/风险/回滚/DoD）
- 参数差分表（仅列出不同项）
- 渲染后的 commands（含已解析参数）
- DoD（至少包含 acceptance/headline 的摘要或表）

建议用例：

- run_card：`examples/schrodinger_ho/run_cards/ho_groundstate.json`
- overrides：`n_grid=4001`（与 default 2001 不同）
- 断言：输出包含 `n_grid | 2001 | 4001` 以及 `scripts/solve_numerics.py` 的 argv

为避免时间戳导致不稳定，测试应通过注入固定 `generated_at`（例如 mock `utc_now_iso()` 或提供测试专用环境变量）。

### 9.2 其他回归

- `request-approval` 写出两份文件，且 state/ledger 记录路径
- suite 多-run：每个 run 只显示差异参数，且 runs 排序稳定

## 10. 实现落点（供迁移后实现参考）

推荐拆分（避免把格式逻辑塞进 CLI 巨石）：

- 新增模块：`src/hep_autoresearch/toolkit/approval_packet.py`
  - `render_packet_human(context) -> str`
  - `render_packet_full(context) -> str`
  - `load_suite(path) -> Suite`
  - `w_compute_enrichment(...)`：参数差分、命令渲染、DoD 提取
- CLI 改动点：`src/hep_autoresearch/orchestrator_cli.py`
  - `_request_approval(...)`：写入 `packet_human.md` + `packet_full.md`，并更新 state/ledger 字段
  - `cmd_request_approval(...)`：解析 `--suite/--lang`

文档：

- 新增/更新：`docs/APPROVAL_PACKET_FORMAT.md`（说明两类 packet 的字段、格式、确定性规则、suite 格式）

---

## 变更记录

- 2026-02-15：对话确认采用双文件审批包；`pending_approval.packet_path` 默认指向 `packet_human.md`；采用 `--suite suite.json` 支持多-run 套件。
