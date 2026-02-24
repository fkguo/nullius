# @hep-research/pdg-mcp

[English](./README.md) | 中文

`pdg-mcp` 是一个 **本地（offline）** 的 MCP server（stdio transport），用于对 PDG（Review of Particle Physics）发布的 **SQLite snapshot** 做可复现查询。

设计原则：

- **Evidence-first**：大结果写入本地 `artifacts/`，tool 只返回 `uri + summary`；通过 `pdg://` resources 读取内容。
- **Schema SSOT**：工具参数以 Zod schema 为唯一事实来源，并由此派生 MCP `inputSchema`（避免漂移）。

> 依赖：需要系统 `sqlite3` 在 `PATH` 中（内部通过 `sqlite3 -json` 执行只读查询）。

## 环境变量与目录

### 必需

- `PDG_DB_PATH`：PDG sqlite 文件的 **绝对路径**（例如：`/abs/path/to/pdg-2025-v0.3.0.sqlite`）
  - 未设置时：仅 `pdg_info` 可用（会返回 `db.configured=false`），其他工具会报 `INVALID_PARAMS`。

### 可选

- `PDG_DATA_DIR`：本地数据目录（默认：若设置了 `HEP_DATA_DIR` 则为 `<HEP_DATA_DIR>/pdg`；否则 `~/.hep-research-mcp/pdg`）
  - artifacts 目录为：`$PDG_DATA_DIR/artifacts`
- `PDG_ARTIFACT_TTL_HOURS`：PDG artifacts 缓存 TTL（小时；`0/off` 禁用；启动时 + 周期性清理；默认 24）
- `PDG_ARTIFACT_DELETE_AFTER_READ`：若启用，则在通过 `pdg://artifacts/<name>` 成功读取后立即删除该文件（适合“即时查询缓存”用法）
- `PDG_TOOL_MODE`：工具暴露模式（`standard` 默认；`full` 时可暴露更多工具，若未来添加）
- `PDG_SQLITE_MAX_STDOUT_BYTES`：限制 sqlite3 单次输出（默认 50MB）
- `PDG_SQLITE_CONCURRENCY`：sqlite3 并发上限（默认 4）

## Resources（`pdg://`）

`pdg-mcp` 额外暴露 resources 以读取本地 artifacts：

- `pdg://info`
  - 返回：最小化 server 信息与 `artifacts_dir`（JSON 文本）
- `pdg://artifacts`
  - 返回：当前 artifacts 目录下的文件列表（JSON 文本）
- `pdg://artifacts/<name>`
  - 文本类（`.json/.jsonl/.txt/.md`）：直接返回文件文本
  - 二进制类（如 `.pdf/.png/.zip`）：**不返回 base64**，仅返回文件元信息 JSON（`file_path/size_bytes/sha256/mimeType`）

> 说明：为避免 MCP 客户端 UI 中出现海量条目，`resources/list` 只暴露入口资源（`pdg://info` 与 `pdg://artifacts`）。具体 artifact 可通过直接读取 `pdg://artifacts/<name>`（名称从 `pdg://artifacts` index 获取），或通过 `resources/templates/list` 的模板 `pdg://artifacts/{artifact_name}` 访问。

## Tools（`pdg_*`）

### 1) `pdg_info`

用途：返回 server 信息、目录信息、以及当前 `PDG_DB_PATH` 的元信息（小结果）。

输入：`{}`

输出要点：

- `db.configured`：是否设置了 `PDG_DB_PATH`
- 若已配置：包含 `db.file.sha256`、`db.edition`、`db.license`、`db.citation` 等（来自 `pdginfo` 表）
- `data_dir` / `artifacts_dir`

### 2) `pdg_find_particle`

用途：按 **name / MCID / PDG identifier(pdgid)** 查找粒子候选（小结果；支持分页）。

输入（三选一，必须且只能提供一个 query）：

- `name: string`
- `mcid: int`（PDG Monte Carlo ID / PDG code；也接受纯数字字符串）
- `pdg_code: int`（`mcid` 的别名）
- `pdgid: string`

通用参数：

- `case_sensitive?: boolean = false`
- `match?: 'exact' | 'prefix' | 'contains' = 'exact'`（仅 `name` 查询使用）
- `start?: int = 0`
- `limit?: int = 20`（最大 50）

输出要点：

- `candidates[]`：包含 `pdgid/pdgid_id/name/mcid/charge/cc_type/pdg_description`
- `match`：记录命中来源（`particle` 直接命中，或通过 `pdgitem`/`pdgitem_map` 间接命中）
- `has_more`：分页提示
- `normalized_name`：当输入包含希腊字母/上标等，会进行规范化（例如 `π`→`pi`）

### 3) `pdg_get_property`

用途：读取高频物理量（`mass/width/lifetime`）并返回带不确定度的结构化结果（小结果）。

输入：

- `particle`: `{ name | mcid | pdg_code | pdgid, case_sensitive?: boolean = false }`（四选一）
- `property: 'mass' | 'width' | 'lifetime'`
- `edition?: string`
- `allow_derived?: boolean = false`

输出要点：

- `particle`：解析到的 base 粒子及其带电变体（variants）
- `property`：对应的 `pdgid/pdgid_id/data_type/flags`
- `value`：`display_value_text` + 机器可用 `value/error_*` + `display_text`
- `pdg_locator`：可定位到 `pdgdata` 表中的 `pdgdata_id`
- `value_type_meaning/limit_type_meaning`：会查询 `pdgdoc` 给出代码释义（若存在）

派生宽度：

- 当请求 `width` 且 PDG 未给出宽度，但存在寿命 `lifetime` 时，可设置 `allow_derived=true`
- 返回 `derived.width_from_lifetime`，并提供来源 locator 与常数信息（`Γ = ħ / τ`）

### 4) `pdg_get`

用途：读取一个 **PDG identifier（pdgid）** 的完整明细（写 JSON artifact；tool 返回 `uri + summary`）。

输入：

- `pdgid: string`（例如 `S043M`）
- `edition?: string`
- `artifact_name?: string`（安全文件名，不能包含路径分隔符）

输出要点：

- `uri: pdg://artifacts/<name>`
- `summary`：包含 `pdgid/pdgid_id/description/data_type/flags/edition`、`pdgdata_rows`、`child_count` 等
- artifact 内容：`pdgid` 行、`pdgdata_rows`、`pdgdecay_rows`、children sample（便于后续离线分析）

### 5) `pdg_get_decays`

用途：列出粒子的衰变道（写 JSONL artifact；tool 返回 `uri + summary`；支持分页）。

输入：

- `particle`: `{ name | mcid | pdg_code | pdgid, case_sensitive?: boolean = false }`（四选一）
- `edition?: string`
- `start?: int = 0`
- `limit?: int = 200`（最大 500）
- `artifact_name?: string`

输出要点：

- `uri: pdg://artifacts/<name>`
- `summary.preview`：前几条衰变道预览（含 `display_text`）
- JSONL 每行包含：
  - `decay`：形如 `W+ -> e+ + nu`
  - `incoming/outgoing[]`：粒子列表（含 `multiplier`、`subdecay_id`）
  - `branching`：分支比的 `pdgdata_id/edition/display_text` 等

### 6) `pdg_find_reference`

用途：在 `pdgreference` 中按 DOI / INSPIRE recid / document id / title 查找参考文献（小结果；支持分页）。

输入（必须且只能提供一个 query）：

- `doi: string`
- `inspire_id: string`（通常为纯数字 recid）
- `document_id: string`（PDG 内部文献标识，例如 `PATEL 1965`）
- `title: string`

通用参数：

- `match?: 'exact' | 'prefix' | 'contains' = 'contains'`
- `case_sensitive?: boolean = false`
- `start?: int = 0`
- `limit?: int = 20`（最大 50）

输出要点：

- `references[]`：`id/document_id/publication_name/publication_year/doi/inspire_id/title`
- `references[].inspire_lookup_by_id`：可直接喂给 `hep-research-mcp` 的 `inspire_literature`（mode=`lookup_by_id`）
  - 若 `doi` 以 `10.` 开头 → 追加 DOI
  - 若 `inspire_id` 为纯数字 → 追加 INSPIRE recid

### 7) `pdg_get_reference`

用途：获取单条参考文献记录（小结果；带 INSPIRE 连接提示）。

输入（二选一）：

- `id: int`
- `document_id: string`

通用参数：

- `case_sensitive?: boolean = false`（仅 `document_id` 使用）

输出要点：

- `reference`：同 `pdg_find_reference` 的结构，额外带 `reference.inspire_lookup_by_id`
- `pdg_locator`：`{ table: 'pdgreference', pdgreference_id: <id> }`

### 8) `pdg_get_measurements`

用途：列出某个 PDG identifier 的测量明细（写 JSONL artifact；支持分页；可选 join 引用/数值/脚注）。

该工具也支持一个更符合直觉的 **粒子模式** 入口：

- 你可以传入 `particle`（`name | mcid | pdgid`），或
- 直接把数字形式的 `pdgid` 当作 **MCID/PDG code** 的简写（例如 `pi0` 的 `111`）。

当粒子对应 **多个** “测量序列”（同一粒子下有多个 child PDG identifier 具备测量数据）时，工具会返回一个 **JSON artifact**，列出可选序列；此时不会直接返回测量 JSONL。

输入：

三选一（必须且只能提供一个入口，或直接使用 property_pdgid）：

- `pdgid: string`（PDG identifier，例如 `S009T`；若为纯数字则按 MCID/PDG code 处理）
- `particle: { name | mcid | pdg_code | pdgid, case_sensitive?: boolean = false }`
- `property_pdgid: string`（可直接单独使用，查询特定的 PDG identifier，例如 `S009R1`）

可选的消歧参数（当使用 `particle` 或纯数字 `pdgid` 时）：

- `property_pdgid?: string`（指定某个 child 序列，例如 `S009T`）
- `data_type?: string`（按 PDGID.DATA_TYPE 选择，例如 `T`、`M`、`BR`）

- `case_sensitive?: boolean = false`
- `start?: int = 0`
- `limit?: int = 50`（最大 200）
- `include_values?: boolean = true`
- `include_reference?: boolean = true`
- `include_footnotes?: boolean = true`
- `artifact_name?: string`

输出要点：

- 测量模式（JSONL）：
  - `uri: pdg://artifacts/<name>`
  - `summary.has_more`：是否还有更多测量可取
  - `summary.next_page_hint`：当 `has_more=true` 时，给出下一次调用参数（`start`、`limit`）
  - **分页**：当 `has_more=true` 时，下一页使用 `start = previous_start + previous_limit`
  - JSONL 每行包含：
    - `measurement`：来自 `pdgmeasurement`
    - `values[]`：来自 `pdgmeasurement_values`（含 `column_name/value_text/value/error_*` 与 `display_text`）
    - `reference`：来自 `pdgreference`（若开启），并附 `reference.inspire_lookup_by_id`
    - `footnotes[]`：来自 `pdgmeasurement_footnote` + `pdgfootnote`（若开启）
- 序列选项模式（JSON）：
  - `summary.kind = 'series_options'`
  - `summary.requires_selection = true`（表示必须停下并选择一个序列）
  - `summary.stop_here = true`（**关键**：不要用相同的 particle/pdgid 再调用）
  - artifact 列出该粒子下可选序列（含 `measurement_count`）以及下一步调用提示
  - **关键**：当收到 `series_options` 或 `stop_here=true` 时，必须立刻停止查询；不要用同样的 particle/pdgid 继续调用 `pdg_get_measurements`（会导致无限循环）。请改用 `example_next_calls` 中带 `property_pdgid` 或 `data_type` 的调用来选择具体序列。

### 9) `pdg_batch`

用途：一次请求执行多个 PDG tool call（写 JSON artifact；支持有限并发）。

可用性：**full-only**（standard 模式不暴露）。

输入：

- `calls: Array<{ tool: <pdg tool name>, arguments?: object }>`（1–50）
- `concurrency?: int = 4`（最大 16）
- `continue_on_error?: boolean = false`
- `artifact_name?: string`

允许的 `tool`：

- `pdg_info`
- `pdg_find_particle`
- `pdg_find_reference`
- `pdg_get_reference`
- `pdg_get_property`
- `pdg_get`
- `pdg_get_decays`
- `pdg_get_measurements`

输出要点：

- `uri: pdg://artifacts/<name>`
- `summary.ok/errors/skipped` + `preview`
- artifact 里保存完整调用结果（含每个 call 的 `duration_ms`、错误结构等），方便审计与复现实验

## 与 `hep-research-mcp` 的衔接（Reference Bridge）

当 `pdg-mcp` 被聚合进 `hep-research-mcp`（单一 MCP server）时：

- 所有 `pdg_*` tools 在同一 server 中可用
- `pdg_find_reference` / `pdg_get_reference` / `pdg_get_measurements` 输出的 `references[].inspire_lookup_by_id` 可直接喂给 `inspire_literature`（mode=`lookup_by_id`）
  - 后续再用 `inspire_literature`（mode=`get_paper` / `get_bibtex` 等）进入引用管理/写作链路
