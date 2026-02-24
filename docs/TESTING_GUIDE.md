# 功能测试指南（逐项对照版）

本指南用于**手工验收**本仓库 `hep-research-mcp`（`hep-research-mcp` 服务器）当前已实现的主要功能（含 vNext：Project/Run、Evidence-first、Zotero Local API、PDF→Evidence、写作 verifier、导出资产包），并给出每一步的**预期结果**，方便你逐项比对。

> 说明
>
> - 很多返回值包含动态字段（如 `project_id/run_id/created_at`），请按“结构/字段/不变量”对照，而不是逐字匹配。
> - 部分功能需要外部依赖：INSPIRE 网络访问、Zotero Desktop、以及（可选）LLM API key。本文会标注“必需/可选”。
> - Evidence-first：大对象都写入磁盘 artifacts，通过 `hep://...` Resources 读取；tool 返回一般只有 URI + summary。

---

## 0. 一次性准备（必做）

### 0.1 构建与启动（必做）

1) 安装/构建：

```bash
pnpm install
pnpm -r build
```

可选：运行自动化测试（默认不触发联网 smoke）：

```bash
pnpm -r test
```

如需跑联网 live smoke（访问 inspirehep.net；默认 `skip`），再加：

```bash
HEP_LIVE_SMOKE=1 pnpm -r test
```

2) 选择一个干净的数据目录（建议每次验收都新建一个）：

- 例如：`/Users/<you>/tmp/hep_data_test_001`

3) 在 Cursor 配置 MCP（见 `README.md` / `docs/README_zh.md` 的 Cursor 小节）。

最小示例（路径请改成你本机真实绝对路径）：

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"
      ],
      "env": {
        "HEP_DATA_DIR": "/absolute/path/to/hep_data_test_001",
        "HEP_TOOL_MODE": "standard"
      }
    }
  }
}
```

**预期**

- Cursor 重启/刷新后，Chat/Agent 的 **Tools** 面板里可以看到 `hep-research-mcp` 的工具列表，并可调用。
- 备注：部分 MCP 客户端/agent runtime 会对工具名加前缀（例如 `mcp__hep__inspire_search`）；请以客户端 Tools 列表显示的完整名称为准调用。
- 服务器日志输出到 stderr（不污染 stdout）。

#### listTools sanity check（当 Cursor 看不到 Tools 时）

如果 Cursor 里仍然看不到 Tools，优先确认 **MCP `listTools` 返回是否可被客户端解析**：

```bash
cd /absolute/path/to/hep-research-mcp/packages/hep-research-mcp
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

- 输出是一个数组，包含 `standard/full` 两种模式的 `tool_count` 与 `bad`。
- `tool_count` 为正数（当前实现：`standard=72`，`full=84`；`HEP_ENABLE_ZOTERO=0` 时：`standard=64`，`full=76`；以后如有变化，以代码为准）。
- 每个对象的 `bad` 都应为空数组（所有 tool 的 `inputSchema.type` 都应为 `"object"`）。

### 0.2 Zotero Local API（可选，但建议验收）

**前提**

- 已安装 Zotero 7，并启用 Local API。
- 本项目硬约束：只允许 `http://127.0.0.1:23119`。

在 MCP server 的 env 里加入（建议先用最小配置）：

```json
{
  "ZOTERO_BASE_URL": "http://127.0.0.1:23119"
}
```

如需测试 `zotero_local`（mode=`get_attachment_fulltext`，读取 `.zotero-ft-cache`），还需设置：

```json
{
  "ZOTERO_DATA_DIR": "/absolute/path/to/Zotero"
}
```

> 备注：Zotero UI 里可能只显示 “Available at http://localhost:23119/api/”，但本项目会强制使用 `127.0.0.1:23119`（等价、只为避免误配到远端）。

#### 0.2.1 命令行连通性判断（推荐先做）

在终端执行（返回 `200` 表示 Local API 可用）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:23119/api/users/0/items?limit=1"
```

**预期**

- 返回 `200`。

> 说明：用浏览器直接打开这些 `/api/...` URL 可能会显示 `Request not allowed`（Zotero 会阻止“浏览器型请求”直接访问 Local API）。这是正常现象；请以 `curl`/本地程序（如本 MCP server）的访问结果为准。

> 常见坑：如果你在 zsh 看到 `dquote>` 提示符，说明上一条命令的 `"` 没闭合；按 `Ctrl+C` 取消后，补全引号重新执行即可。

#### 0.2.2 “返回 JSON 里的 key 是不是 API Key？”

不是。你在 `/api/users/.../items` 返回的 JSON 里看到的 `key`（例如 `KT5DE25S`）是 **Zotero item key**（条目/附件的 key）。

Zotero Local API **无认证**：不需要 Local API Key，也不会通过 API 返回任何“访问 key”。

**快速自检（终端，可选）**

```bash
curl -s "http://127.0.0.1:23119/api/users/0/collections?limit=1" | head
```

**预期**

- 输出 JSON（不是 HTML），且 HTTP 可达（详见上面的 `http_code` 判断）。

参考：https://www.zotero.org/support/dev/zotero_7_for_developers

补充：Local API 的端点/字段/分页/查询参数大体与 Zotero Web API v3 一致，可把该文档当作接口参考（但实际请求仍然只访问 `http://127.0.0.1:23119/api/`）：https://www.zotero.org/support/dev/web_api/v3/basics

### 0.3 PDG（可选，但建议验收）

> 说明：PDG 工具（`pdg_*`）已聚合进 `hep-research-mcp`，用于本机离线粒子数据查询与 artifacts/resources 验证。

**前提**

- 本机已有 PDG sqlite 文件（示例，版本以你本地为准）：
  - `/home/user/Seafile/AI/mcp-pdg/pdg-2025-v0.3.0.sqlite`
  - `/home/user/Seafile/AI/mcp-pdg/pdgall-2025-v0.3.0.sqlite`

在 MCP server 的 env 里加入（建议把 `PDG_DATA_DIR` 放到测试数据目录内，便于清理）：

```json
{
  "PDG_DB_PATH": "/absolute/path/to/pdg-2025-v0.3.0.sqlite",
  "PDG_DATA_DIR": "/absolute/path/to/hep_data_test_001/pdg"
}
```

#### 0.3.1 `pdg_info`

**调用**

```json
{}
```

**预期**

- `db.configured=true`
- `db.db_path` 等于你设置的 `PDG_DB_PATH`
- `artifacts_dir` 位于你设置的 `PDG_DATA_DIR` 之下

#### 0.3.2 `pdg_find_particle`（可选）

**调用（示例）**

```json
{ "name": "electron", "limit": 5 }
```

**预期**

- 返回 `candidates[]`（长度 <= 5）
- 可从候选中选取一个 `pdgid` 用于后续 `pdg_get`

---

## 1. 基础连通性（建议先做）

### 1.1 `hep_project_list`（无参）

**调用**

```json
{}
```

**预期**

- `isError=false`
- 返回形如：
  - `total: <number>`
  - `projects: []`（首次可能为空）

---

## 2. vNext：Project/Run 基础（M3）

> 建议把本节生成的 `project_id` / `run_id` 记录下来，后续步骤复用同一个 run。

### 2.1 创建 Project：`hep_project_create`

**调用**

```json
{ "name": "Manual Test Project", "description": "acceptance test" }
```

**预期**

- `project_id`：非空、无 `/`、无 `..`
- `project_uri`：形如 `hep://projects/<project_id>`
- `summary.name` 与输入一致

### 2.2 读取 Project：`hep_project_get`

**调用**

```json
{ "project_id": "<project_id>" }
```

**预期**

- `project_id` 与上一步一致
- `project_uri` 可用（后续可 `readResource`）

### 2.3 创建 Run：`hep_run_create`

**调用**

```json
{ "project_id": "<project_id>" }
```

**预期**

- 返回 `run_id`
- `manifest_uri`：形如 `hep://runs/<run_id>/manifest`
- `artifacts` 至少包含 `args_snapshot.json`（URI 为 `hep://runs/<run_id>/artifact/args_snapshot.json`）

### 2.4 读取 Run manifest（Resource）

**读取资源**

- `hep://runs/<run_id>/manifest`

**预期**

- JSON 中包含 `steps[]`
- 至少有一条 `step=run_create` 且 `status=done`

### 2.5 对照磁盘落盘结构（可选但推荐）

在 `HEP_DATA_DIR` 下应出现：

```
<HEP_DATA_DIR>/
  projects/<project_id>/
  runs/<run_id>/
    manifest.json
    artifacts/args_snapshot.json
```

---

## 3. vNext：LaTeX → Evidence Catalog（M6，本地 fixture 版，零网络依赖）

本节用仓库自带 LaTeX fixture 构建 Evidence Catalog，并验证 query/playback。

### 3.1 `hep_project_build_evidence`（使用本地 main.tex）

**准备**

- 使用本仓库 fixture：`packages/hep-research-mcp/tests/fixtures/latex/multifile/main.tex`

**调用**

```json
{
  "project_id": "<project_id>",
  "paper_id": "fixture_multifile",
  "main_tex_path": "/absolute/path/to/hep-research-mcp/packages/hep-research-mcp/tests/fixtures/latex/multifile/main.tex",
  "include_inline_math": false,
  "include_cross_refs": true
}
```

**预期**

- `paper_uri`：形如 `hep://projects/<project_id>/papers/fixture_multifile`
- `catalog_uri`：形如 `hep://projects/<project_id>/papers/fixture_multifile/evidence/catalog`
- `summary.total > 0`

### 3.2 `hep_project_query_evidence`

**调用（示例）**

```json
{
  "project_id": "<project_id>",
  "paper_id": "fixture_multifile",
  "query": "introduction",
  "limit": 5
}
```

**预期**

- `hits.length <= 5`
- 每个 hit 有 `evidence_id`、`text_preview`、`locator`

### 3.3 `hep_project_playback_evidence`

**调用**

```json
{
  "project_id": "<project_id>",
  "paper_id": "fixture_multifile",
  "evidence_id": "<from_query_hit_evidence_id>"
}
```

**预期**

- 返回 `playback.snippet`（包含上下文片段）
- `playback.file/line/column` 存在

---

## 4. vNext：写作（结构化 draft → LaTeX + verifier 强制）（M7，零网络依赖）

### 4.1 成功用例：`hep_render_latex`

**调用（使用最小 draft + allowlist + cite mapping）**

```json
{
  "run_id": "<run_id>",
  "draft": {
    "version": 1,
    "title": "Test Section",
    "paragraphs": [
      {
        "sentences": [
          {
            "sentence": "A grounded factual sentence that must be cited.",
            "type": "fact",
            "is_grounded": true,
            "evidence_ids": ["ev_test_1"],
            "recids": ["1597424"]
          }
        ]
      }
    ]
  },
  "allowed_citations": ["inspire:1597424"],
  "cite_mapping": {
    "Guo:2017jvc": { "status": "matched", "recid": "1597424", "match_method": "doi", "confidence": 1 }
  }
}
```

**预期**

- `isError=false`
- 返回 `artifacts` 包含：
  - `rendered_latex.tex`
  - `rendered_section_output.json`
  - `rendered_latex_verification.json`
- 读取 `rendered_latex.tex`（`hep://runs/<run_id>/artifact/rendered_latex.tex`）应包含：`\\cite{Guo:2017jvc}`
- `summary.verifier_pass = true`

**如果你的 MCP 客户端/模型不擅长提交复杂嵌套 JSON**

可以直接运行脚本（通过 MCP stdio 调用同一个 tool）：

```bash
pnpm -r build
node packages/hep-research-mcp/scripts/test-hep-render-latex-real.mjs --run-id "<run_id>" --data-dir "<HEP_DATA_DIR>"
```

脚本会写入并读取以下 artifacts（避免覆盖默认文件名）：
- `rendered_latex_real.tex`
- `rendered_section_output_real.json`
- `rendered_latex_verification_real.json`

### 4.2 失败用例：unauthorized citation（必须失败）

**调用（allowed_citations 不包含 1597424）**

```json
{
  "run_id": "<run_id>",
  "draft": { "...同上..." },
  "allowed_citations": [],
  "cite_mapping": { "Guo:2017jvc": { "status": "matched", "recid": "1597424" } }
}
```

**预期**

- `isError=true`
- `error.code = "INVALID_PARAMS"`
- `error.data.issues[]` 内至少有一条 `type = "unauthorized_citation"`

### 4.3 失败用例：missing citation（grounded fact 且无 recids，必须失败）

**调用（把 sentence.recids 设为 []）**

```json
{
  "run_id": "<run_id>",
  "draft": {
    "version": 1,
    "title": "Test Section",
    "paragraphs": [
      {
        "sentences": [
          {
            "sentence": "A grounded factual sentence that must be cited.",
            "type": "fact",
            "is_grounded": true,
            "evidence_ids": ["ev_test_1"],
            "recids": []
          }
        ]
      }
    ]
  },
  "allowed_citations": [],
  "cite_mapping": {}
}
```

**预期**

- `isError=true`
- `error.code = "INVALID_PARAMS"`
- `error.data.issues[]` 内至少有一条 `type = "missing_citation"`

### 4.4 citekey 选择稳定性（同 recid 取字典序最小 key）

**调用（同一 recid=1597424 映射到多个 citekey）**

```json
{
  "run_id": "<run_id>",
  "draft": {
    "version": 1,
    "title": "Citekey tie-break",
    "paragraphs": [
      { "sentences": [ { "sentence": "Test.", "type": "fact", "is_grounded": true, "recids": ["1597424"] } ] }
    ]
  },
  "allowed_citations": ["inspire:1597424"],
  "cite_mapping": {
    "Guo:2017jvc": { "status": "matched", "recid": "1597424" },
    "Alternative:2017jvc": { "status": "matched", "recid": "1597424" }
  }
}
```

**预期**

- 输出 LaTeX 中引用应为 `\\cite{Alternative:2017jvc}`（字典序最小）

---

## 5. vNext：Zotero Local API（M8，需要 Zotero）

> 本节需要 Zotero Desktop 正在运行、Local API 已启用；若本节工具返回 404/连接失败，先回到上面的 0.2 用 `curl` 验证本机 `http://127.0.0.1:23119/api/` 是否可用。

> 说明：Zotero 工具面已收敛为 `zotero_local`（用 `mode` 分派）+ 少量高层工具（`zotero_find_items` / `zotero_search_items` / `zotero_export_items` / `zotero_get_selected_collection` / `zotero_add` / `zotero_confirm`）；`full` 模式当前与 `standard` 相同（预留扩展）。

### 5.1 `zotero_local`（mode=`list_collections`）

**调用**

```json
{ "mode": "list_collections", "limit": 50, "start": 0 }
```

**预期**

- `isError=false`
- `meta.status=200`
- `collections.length <= limit`

### 5.2 `zotero_local`（mode=`list_items`）

**调用（可先不填 collection_key，列出 top items）**

```json
{ "mode": "list_items", "limit": 20, "start": 0 }
```

**预期**

- `meta.status=200`
- `scope.kind` 为 `library_top` 或 `collection`

### 5.3 `zotero_local`（mode=`get_item`）

从上一步 artifact 中选一个 `item_key`。

**调用**

```json
{ "mode": "get_item", "item_key": "<item_key>" }
```

**预期**

- 返回字段包含：
  - `item_key`
  - `select_uri`
  - `identifiers`（可能含 `doi/arxiv_id/inspire_recid/title`）
  - `warnings`（数组）

### 5.4 `zotero_local`（mode=`get_item_attachments`）

**调用**

```json
{ "mode": "get_item_attachments", "item_key": "<item_key>" }
```

**预期**

- `attachments` 为数组，且每个元素包含 `attachment_key` 与 `is_pdf`
- `summary.pdf_attachments_total >= 0`

### 5.5 `zotero_local`（mode=`download_attachment`，下载 PDF）

从 attachments artifact 中选一个 `attachment_key`（PDF）。

**调用**

```json
{ "mode": "download_attachment", "attachment_key": "<attachment_key>" }
```

**预期**

- 返回字段包含：
  - `file_path`
  - `sha256`（非空）
  - `size > 0`

> 说明：Zotero Local API 的 `GET /api/users/0/items/<attachment_key>/file` 通常返回 `302 Location: file://...`（指向本机文件路径），不是直接返回 PDF 二进制；本工具会解析该信息从磁盘读取并返回 `file_path/sha256/size`。

### 5.6 `zotero_local`（mode=`get_attachment_fulltext`）

**调用**

```json
{ "mode": "get_attachment_fulltext", "attachment_key": "<attachment_key>" }
```

**预期**

- `status` 二选一：
  - `ok`：返回 `file_path`（指向 `.zotero-ft-cache`）与 `size`
  - `not_indexed`：返回 `expected_cache_path` 与 `guidance[]`

> 若你确认 Zotero 已完成全文索引（例如存在 `~/Zotero/storage/<attachment_key>/.zotero-ft-cache`），但返回 `not_indexed`，请检查 MCP env 的 `ZOTERO_DATA_DIR` 是否指向正确的 Zotero 数据目录（包含 `storage/`）。返回值里会包含 `expected_cache_path`，可直接对照该路径是否存在。

---

## 6. vNext：PDF → Evidence（M9）

### 6.1 text 模式（推荐先测）

**调用（直接使用 Zotero 的 attachment_key）**

```json
{
  "run_id": "<run_id>",
  "zotero_attachment_key": "<attachment_key>",
  "mode": "text",
  "max_pages": 5,
  "output_prefix": "pdf"
}
```

**预期**

- `artifacts` 至少包含：
  - `pdf_pages.json`
  - `pdf_meta.json`
  - `pdf_evidence_catalog.jsonl`
- `summary.processed_pages >= 1`
- `summary.used_zotero_fulltext`：
  - 若存在 `ZOTERO_DATA_DIR/storage/<attachment_key>/.zotero-ft-cache` 且非空：应为 `true`
  - 否则为 `false`（回退到 pdfjs 文本抽取）

### 6.2 visual 模式（产出 page render + region snippet）

**调用**

```json
{
  "run_id": "<run_id>",
  "zotero_attachment_key": "<attachment_key>",
  "mode": "visual",
  "max_pages": 1,
  "render_dpi": 144,
  "output_prefix": "pdfvis"
}
```

**预期**

- `artifacts` 中至少出现：
  - `pdfvis_page_0001.png`
  - `pdfvis_region_*.png`（至少 1 个）
- `catalog_uri` 指向 `hep://runs/<run_id>/artifact/pdfvis_evidence_catalog.jsonl`
- 读取该 JSONL：至少有一条 `type="pdf_region"`，并且该条 `meta.region_uri` 指向某个 `...region_*.png`

### 6.3 Docling JSON 可选后端（不需要安装 docling，也可用最小 JSON 验证）

**准备**

- 在本机任意位置写一个小文件（例如放进 `HEP_DATA_DIR`）：

```json
{
  "texts": [
    {
      "label": "formula",
      "text": "E = m c^2",
      "prov": [
        { "page_no": 1, "bbox": { "l": 90, "t": 710, "r": 520, "b": 650, "coord_origin": "BOTTOMLEFT" } }
      ]
    }
  ],
  "tables": [],
  "pictures": []
}
```

**调用**

```json
{
  "run_id": "<run_id>",
  "zotero_attachment_key": "<attachment_key>",
  "docling_json_path": "/absolute/path/to/docling.min.json",
  "mode": "visual",
  "max_pages": 1,
  "render_dpi": 144,
  "output_prefix": "docling"
}
```

**预期**

- `artifacts` 中出现 `docling_region_formula_p0001_001.png`（或类似包含 `_region_formula_` 的名字）

### 6.4 `visual+ocr`（stub，必须失败）

**调用**

```json
{
  "run_id": "<run_id>",
  "zotero_attachment_key": "<attachment_key>",
  "mode": "visual+ocr",
  "max_pages": 1,
  "output_prefix": "ocr"
}
```

**预期**

- `isError=true`
- `error.code = "INVALID_PARAMS"`
- message 提示 `visual+ocr` 仍未实现（stub only）
- `hep://runs/<run_id>/manifest` 中新增 step `pdf_evidence`，且 `status=failed`

---

## 7. vNext：导出研究资产包（M10）

### 7.1 `hep_export_project`

**前提**

- run 下已有 `rendered_latex.tex`（可先做第 4 节的 `hep_render_latex`）。

**调用**

```json
{
  "run_id": "<run_id>",
  "include_evidence_digests": true,
  "max_chars_per_notebooklm_file": 80000
}
```

**预期**

- `artifacts` 至少包含：
  - `master.bib`
  - `report.tex`
  - `report.md`
  - `run_manifest.json`
  - `export_manifest.json`
  - `research_pack.zip`
  - `notebooklm_pack_report.md`
  - `notebooklm_pack_master.bib`
  - `notebooklm_pack_run_manifest.json`
- 如果 run 或 project 里存在 evidence catalogs，则还会生成：
  - `notebooklm_pack_evidence_digest_001.md`（以及可能的 `_002`、`_003`…，用于分片）

**内容预期（关键对照点）**

- 读取 `report.tex`：包含 `\\cite{...}` 与 `\\bibliography{master}`
- 读取 `report.md`：包含形如 ` [cite: <keys>]` 的引用标记（用于 NotebookLM 友好）
- 读取 `master.bib`：
  - 若 `\\cite{...}` 中存在缺失 citekey（既不在 `writing_master.bib` 也不在 `bibliography_raw.json`）：`hep_export_project` 会 fail-fast，并给出 `next_actions`（先跑 `hep_run_build_citation_mapping` 再重试导出）
- `research_pack.zip`：
  - Resource 读取为 binary（base64 blob），文件头应为 `PK`（ZIP 签名）
- zip 内包含 `notebooklm_pack/` 目录与若干文件

---

### 7.2 `hep_export_paper_scaffold`

> 用于把 run 的写作结果导出为“可投稿/可编译”的 `paper/` 目录脚手架（RevTeX4-2），并同时生成一个可迁移的 `paper_scaffold.zip`。

**前提**

- run 下已有 `writing_integrated.tex`（通常来自第 5 节的 `hep_run_writing_integrate_sections_v1`）。
- run 下已有 `writing_master.bib`（并且覆盖 `\\cite{...}` 需要的 citekeys；否则会 fail-fast）。

**调用**

```json
{
  "run_id": "<run_id>"
}
```

**预期**

- `artifacts` 至少包含：
  - `paper_manifest.json`
  - `paper_scaffold.zip`
- `paper_scaffold.zip` 解压后包含（前缀 `paper/`）：
  - `paper/main.tex`
  - `paper/sections/*.tex`
  - `paper/references_generated.bib`
  - `paper/references_manual.bib`（可能为空）
  - `paper/paper_manifest.json`
  - `paper/UNVERIFIED.md`
- `.tex` 文件中不应出现 `hep://`（否则 LaTeX 无法编译；工具会 fail-fast）

---

### 7.3 `hep_import_paper_bundle`

> 用于把（经 research-writer / 人工润色 / 可重复编译检查后的）`paper/` 目录回灌为 run artifacts，便于长期保存与统一打包导出。

**前提**

- run 目录下存在 `paper/`，且包含 `paper_manifest.json`（通常由 `hep_export_paper_scaffold` 生成）。
- `.tex` 文件中不应出现 `hep://`（必须保持可编译/可迁移；否则会 fail-fast）。

**调用**

```json
{
  "run_id": "<run_id>",
  "dereference_symlinks": false
}
```

**预期**

- `artifacts` 至少包含：
  - `paper_bundle_manifest.json`
  - `paper_bundle.zip`（zip 内前缀为 `paper/`）
- 若 `paper/main.pdf` 存在，则还会写入：
  - `paper_final.pdf`

**可选：统一打包到 research_pack.zip**

- 运行 `hep_export_project` 时传 `include_paper_bundle=true`，则 `research_pack.zip` 内会包含 `paper/` 目录（来自 `paper_bundle.zip` 解包嵌入）。

---

## 8. INSPIRE 核心调研工具（inspire_*，需要网络）

> 本节依赖 inspirehep.net；如果你处于离线环境可跳过。
> 说明：推荐使用统一入口 `inspire_literature(mode=...)`；本仓库已收敛历史分裂入口（不再提供旧式“每个动作一个 tool”的原子入口）。
>
> 备注：`inspire_search` / `inspire_literature` 可直接调用（不需要 Project/Run）。只有 `inspire_deep_research(mode=write, ...)` 才要求 `run_id`（因为要落地 evidence-first 的 run artifacts）。

### 8.1 `inspire_search`

**调用（示例）**

```json
{ "query": "t:pentaquark", "size": 3, "sort": "mostrecent" }
```

**预期**

- `total >= 0`
- `papers.length <= 3`
- 每个 paper 有 `recid`

### 8.2 `inspire_literature`（mode=`get_paper`）

从上一步选一个 `recid`。

**调用**

```json
{ "mode": "get_paper", "recid": "<recid>" }
```

**预期**

- 返回包含标题/作者/年份等元信息

### 8.3 `inspire_literature`（mode=`get_references` / `get_citations`）

**调用**

```json
{ "mode": "get_references", "recid": "<recid>", "size": 5 }
```

```json
{ "mode": "get_citations", "recid": "<recid>", "size": 5 }
```

**预期**

- 返回数组（长度 <= 5）

### 8.4 `inspire_literature`（mode=`get_bibtex`）

**调用**

```json
{ "mode": "get_bibtex", "recids": ["<recid>"] }
```

**预期**

- 返回 BibTeX 字符串（包含 `@` 开头的 entry）

### 8.5 真实论文示例：X(3872)（recid: 1238419 / 1258603）

> 目的：给“深度研究/写作”工具提供一个**真实、可复现**的输入集合（网络依赖）。  
> 主题背景：X(3872) / $\chi_{c1}(3872)$（BESIII + 相关理论/实验）。

#### 8.5.1 元信息（`inspire_literature`，mode=`get_paper`）

**调用**

```json
{ "mode": "get_paper", "recid": "1238419" }
```

```json
{ "mode": "get_paper", "recid": "1258603" }
```

**预期**

- 两条记录均可返回（`isError=false`）
- 标题应分别包含：
  - `Production of the X(3872) in charmonia radiative decays`（recid=1238419）
  - `Observation of e+e− → γX(3872) at BESIII`（recid=1258603，标题里可能含 LaTeX）

#### 8.5.2 引用/被引用（`inspire_literature`，mode=`get_references` / `get_citations`）

**调用（示例）**

```json
{ "mode": "get_references", "recid": "1238419", "size": 5 }
```

```json
{ "mode": "get_citations", "recid": "1258603", "size": 5 }
```

**预期**

- 返回数组（长度 <= 5）
- `references` 通常包含（至少能在更大 size 下看到）一些经典 X(3872) 相关论文，例如：
  - `627760`（Belle 2003：X(3872) 发现）
  - `1221245`（J^PC 判定）
  - `897836`（$X(3872)\\to J/\\psi\\gamma$）
- `citations` 是动态集合：随时间增长，返回内容会变化属正常现象

#### 8.5.3 建议的最小 corpus（可直接用于下文写作/深度研究）

> 为了让输出更稳定、运行更快，建议先用一个小集合做 smoke test：

```json
["1238419", "1258603", "627760", "1221245", "897836"]
```

### 8.6 vNext 写作（推荐：`hep_*` 写作链）

> 写作统一走 run artifacts（Evidence-first），不再提供 legacy 的非 run 写作入口。

最小 smoke test（Client Path）：

1) 创建 project/run（见第 3 节）
2) 生成写作 packets（`inspire_deep_research`，mode=`write`，必须带 `run_id`，`llm_mode=client`）：

```json
{
  "identifiers": ["1238419", "1258603", "627760", "1221245", "897836"],
  "mode": "write",
  "run_id": "<run_id>",
  "options": { "topic": "X(3872) mini-review", "target_length": "short", "llm_mode": "client" }
}
```

3) 为每个 section 生成并提交 N-best 候选（每节至少 2 个）：

```json
{
  "tool": "hep_run_writing_create_section_candidates_packet_v1",
  "args": { "run_id": "<run_id>", "section_index": 1 }
}
```

按返回的 `next_actions`：
- 用 `hep_run_stage_content(content_type='section_output')` 写入每个候选的 `SectionOutputSubmission` JSON
- 用 `hep_run_writing_submit_section_candidates_v1` 提交候选集

然后为该 section 进行 judge 选择（同样按 next_actions；通常是）：
- `hep_run_writing_create_section_judge_packet_v1`
- Host LLM 产出 `JudgeDecision` JSON（建议用 `hep_run_stage_content(content_type='judge_decision')` 写入）
- `hep_run_writing_submit_section_judge_decision_v1`

对 `writing_packets_sections.json` 中的每个 `section_index` 重复上述流程，直到所有 sections 都完成 judge 选择（生成 `writing_section_###.json`）。

4) 推进 run-based 写作流水线（生成审稿 prompt / 等待审稿报告）：

再次调用 `inspire_deep_research`（同一 `run_id`；可不传 `resume_from`，系统会自动从未完成的 step 继续）：

```json
{
  "identifiers": ["1238419", "1258603", "627760", "1221245", "897836"],
  "mode": "write",
  "run_id": "<run_id>",
  "options": { "topic": "X(3872) mini-review", "llm_mode": "client", "target_length": "short" }
}
```

**预期**

- 若返回里出现 `client_continuation.next_actions`，按其中提示执行（通常包含 `hep_run_writing_submit_review`）。
- 审稿 prompt/context 会写入 run artifacts（如 `writing_reviewer_prompt.md`、`writing_reviewer_context.md`）；用任意 LLM 跑完后，把 reviewer JSON 通过 `hep_run_writing_submit_review` 提交到 run。

5) 集成并导出：
- `hep_run_writing_integrate_sections_v1`（生成 `writing_integrated.tex` + `writing_integrate_diagnostics.json`）
- `hep_export_project`（通常把 `rendered_latex_artifact_name` 指向 `writing_integrated.tex`）

### 8.7 深度研究（`inspire_deep_research`，建议：先 analyze/synthesize，再 write）

> 说明：这是一个“整合工作流”工具，适合作为端到端 smoke test。输出可能较长；建议先用上面的最小 corpus。

#### 8.7.1 Analyze（结构化抽取）

**调用**

```json
{
  "identifiers": ["1238419", "1258603"],
  "mode": "analyze",
  "options": { "extract_conclusions": true, "extract_methodology": true }
}
```

**预期**

- `isError=false`
- 返回 `analysis`（结构化字段；不同论文覆盖度不同属正常）

#### 8.7.2 Synthesize（综述聚合）

**调用**

```json
{
  "identifiers": ["1238419", "1258603", "627760", "1221245", "897836"],
  "mode": "synthesize",
  "options": { "review_type": "overview", "include_bibliography": true }
}
```

**预期**

- `isError=false`
- 返回 `review`（可能为 markdown/json，取决于 `format`）

#### 8.7.3 Write（端到端写作流水线，默认不在 MCP 内部调用 LLM）

**调用（Client Path：run-based；必须带 `run_id`）**

```json
{
  "identifiers": ["1238419", "1258603", "627760", "1221245", "897836"],
  "mode": "write",
  "run_id": "<run_id>",
  "options": { "topic": "X(3872) mini-review", "llm_mode": "client", "target_length": "short" }
}
```

**预期**

- `isError=false`
- 返回包含 `run.manifest_uri` + `run.artifacts[]`，并给出 `client_continuation`（提示按 `next_actions` 完成候选提交 + judge；见 8.6）

---

## 9. 常见问题（对照排障）

### 9.1 Cursor 看不到 Tools

- 确认已 `pnpm -r build`，并且 `packages/hep-research-mcp/dist/index.js` 存在。
- MCP 配置的 `args` 必须指向 **dist**（不要指向 ts 源码）。
- 重启/刷新 Cursor MCP servers。
- 在 Chat/Agent 的 Tools 面板里对该 server “启用/信任 tools”（不同版本 UI 文案不同）。

### 9.2 Resources 列表没有枚举每个 artifact

- 这是预期行为：为避免在客户端 UI 中出现海量条目，server 的 `resources/list` 只暴露少量入口（例如 `hep://projects` / `hep://runs` / `pdg://artifacts`）。
- 想查看历史 projects：读取 `hep://projects`。
- 想查看 runs：读取 `hep://runs`，再读 `hep://runs/{run_id}/manifest` 获取该 run 的 artifacts 列表与 URI。
- PDG 同理：读取 `pdg://artifacts` 获取缓存文件列表，再读 `pdg://artifacts/<name>` 读取内容。

### 9.3 Zotero 报错不是 `http://127.0.0.1:23119`

- 这是硬约束：只允许 Local API。请检查 `ZOTERO_BASE_URL` 是否严格为 `http://127.0.0.1:23119`。

### 9.4 `inspire_deep_research`（mode=write，llm_mode=client）报 `llm_mode='client' requires run_id`

`inspire_deep_research`（mode=`write`，`llm_mode=client`）报 `llm_mode='client' requires run_id`

**常见原因**
- 忘记先创建 run（`hep_run_create`），或调用时漏传 `run_id`。

**处理方式**
- 先执行 `hep_project_create` → `hep_run_create`，再把 `run_id` 传给 `inspire_deep_research`（mode=`write`）。
- 若只想做快速 smoke test 而不走 Client Path，可用 `llm_mode=passthrough`（不建议长期依赖；推荐统一走 run artifacts）。

---

## 10. 新增能力补充验收（建议做：R9/写作 Evidence/Style Corpus）

### 10.1 INSPIRE 安全翻页（`inspire_search_next`）

> 目的：验证 `next_url` 只允许同源、并且翻页行为可复现（避免 client 直接 fetch 任意 URL）。

**调用**

```json
{ "query": "t:pentaquark", "size": 3, "sort": "mostrecent" }
```

若返回包含 `next_url`，再调用：

```json
{ "next_url": "<next_url>" }
```

**预期**

- 第二次返回结构与 `inspire_search` 一致，且 `papers.length <= 100`
- 若 `next_url` 被篡改到非 inspirehep 域名/非 literature 路径，应报错（安全检查生效）

### 10.2 INSPIRE search 导出到 run artifacts（`hep_inspire_search_export`）

> 目的：验证 “大结果不走 tool payload”，并且分页≤10k 时可稳定导出。

**调用（示例）**

```json
{
  "run_id": "<run_id>",
  "query": "t:pentaquark",
  "sort": "mostrecent",
  "size": 50,
  "max_results": 200,
  "output_format": "jsonl"
}
```

**预期**

- `export_uri` / `meta_uri` 为 `hep://runs/<run_id>/artifact/...`
- `summary.exported <= max_results`
- 读取 `meta_uri` 可看到 `pages_fetched/has_more/next_url/warnings[]` 等字段

### 10.3 批量解析 identifiers（`hep_inspire_resolve_identifiers`）

> 目的：验证“混合输入（recid/arXiv/DOI/url）→ recid”映射落盘，便于后续写作/深研复用。

**调用（示例）**

```json
{
  "run_id": "<run_id>",
  "identifiers": [
    "1238419",
    "1258603",
    "doi:10.1103/PhysRevLett.91.262001",
    "https://arxiv.org/abs/hep-ph/0308259"
  ]
}
```

**预期**

- 返回 `mapping_uri` / `meta_uri`（均为 `hep://runs/<run_id>/artifact/...`）
- `meta` 中包含 `matched/not_found/errors` 统计；mapping 为 JSONL，每行对应一个 input

### 10.4 vNext 写作 Evidence（`hep_run_build_writing_evidence` + `hep_project_query_evidence_semantic`）

> 目的：验证 “证据 catalog + embeddings + enrichment” 落 run artifacts，并可用于语义检索（semantic query 缺 embeddings 会 fail-fast）。

**调用（示例：先只做 LaTeX evidence，预算压小做 smoke）**

```json
{
  "run_id": "<run_id>",
  "latex_sources": [{ "identifier": "1238419" }, { "identifier": "1258603" }],
  "max_evidence_items": 200,
  "embedding_dim": 256
}
```

然后做语义查询：

```json
{
  "run_id": "<run_id>",
  "project_id": "<project_id>",
  "query": "X(3872) production in radiative decays",
  "limit": 5
}
```

**预期**

- 写作 evidence step 返回的 `artifacts[]` 中包含 `latex_evidence_catalog.jsonl` / `latex_evidence_embeddings.jsonl` / `latex_evidence_enrichment.jsonl`（默认名；以 `writing_evidence_meta.json` 为准）
- `hep_project_query_evidence_semantic.summary.semantic.implemented=true`（embeddings 可用；无 embeddings 会直接报错）

### 10.5 Style Corpus（RMP/PRL/NatPhys/PhysRep；full 模式）

> 说明：`standard` 模式默认只暴露 `inspire_style_corpus_query`（安全、只读）；构建/下载/打包等重操作在 `full` 模式。

**前提**

- 在 MCP server env 把 `HEP_TOOL_MODE` 设为 `full`
- `HEP_DATA_DIR` 是一个你愿意写入语料的目录（语料默认落到 `<HEP_DATA_DIR>/corpora/<style_id>/...`）

**最小 smoke（以 RMP 为例，压小预算）**

1) 初始化 profile：

```json
{ "style_id": "rmp", "overwrite": false }
```

2) 生成/扩充 manifest：

```json
{ "style_id": "rmp", "target_papers": 10, "max_results_per_category": 200 }
```

3) 下载（只下载前 3 篇做 smoke）：

```json
{ "style_id": "rmp", "force": false, "limit": 3, "concurrency": 2 }
```

4) 构建 evidence（只处理前 2 篇做 smoke）：

```json
{
  "style_id": "rmp",
  "force": false,
  "limit": 2,
  "concurrency": 2,
  "include_inline_math": false,
  "max_paragraph_length": 800,
  "map_citations_to_inspire": true
}
```

5) 构建 index：

```json
{ "style_id": "rmp", "embedding_dim": 256 }
```

6) 查询（返回 URI + summary；详细 hits 在 artifact 内）：

```json
{ "style_id": "rmp", "query": "experimental setup", "top_k": 5, "mode": "lite", "retrieval": "paragraph" }
```

**预期**

- `profile_uri` / `manifest_uri` / `artifact.uri` 都是 `hep://corpora/rmp/...`
- 下载/构建/查询的详细结果都落在 `<HEP_DATA_DIR>/corpora/rmp/artifacts/` 下（可审计）
