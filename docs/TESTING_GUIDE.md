# 功能测试指南（front-door 当前真相）

本指南面向手工验收当前 front-door surface。重点对象是 `@autoresearch/hep-mcp` 这条 MCP front door，以及它今天真实提供的 Project/Run、evidence、writing/export、literature/data、Zotero、PDG 能力。通用 lifecycle CLI `autoresearch` 是另一个入口，本文只在需要时简要指出。

> 说明
>
> - 返回值里的 `project_id`、`run_id`、时间戳、URI 等动态字段请按结构和不变量核对，不要逐字比对。
> - 本文所有 MCP 配置都以 `packages/hep-mcp/dist/index.js` 为当前 front door。
> - 大对象默认落盘成 artifacts，通过 `hep://...` 或 `pdg://...` resources 读取。

---

## 0. 一次性准备

### 0.1 构建与计数检查

```bash
pnpm install
pnpm -r build
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
```

可选：跑自动化测试。

```bash
pnpm -r test
```

如需联网 smoke，再显式开启：

```bash
HEP_LIVE_SMOKE=1 pnpm -r test
```

### 0.2 准备一个干净的数据目录

建议每次验收用新的 `HEP_DATA_DIR`，例如：

- `/Users/<you>/tmp/hep_data_test_001`

### 0.3 在 MCP 客户端里接入当前 front door

最小配置示例：

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js"
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

- 重启或刷新 MCP client 后，可以看到 `hep-mcp` 提供的工具。
- 某些客户端会把工具名 namespacing 成 `mcp__<serverAlias>__<toolName>`；务必以客户端实际显示的名字为准。
- 若 GUI 客户端报 `spawn node ENOENT`，把 `command` 改成 Node 的绝对路径。

### 0.4 `listTools` sanity check

当客户端看不到工具时，优先检查 `listTools` 是否返回合法 schema：

```bash
cd /absolute/path/to/autoresearch-lab/packages/hep-mcp
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

- `standard` 模式工具数为 `72`
- `full` 模式工具数为 `101`
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

### 1.2 `hep_project_list`

**调用**

```json
{}
```

**预期**

- 首次可能返回空列表
- 返回结构中应包含 `projects`

---

## 2. Project / Run + Resources

### 2.1 `hep_project_create`

**调用**

```json
{ "name": "Manual Test Project", "description": "front-door acceptance" }
```

**预期**

- 返回非空 `project_id`
- 返回 `project_uri = hep://projects/<project_id>`

### 2.2 `hep_project_get`

**调用**

```json
{ "project_id": "<project_id>" }
```

**预期**

- 名称与描述和创建时一致
- 返回 project manifest 摘要

### 2.3 `hep_run_create`

**调用**

```json
{ "project_id": "<project_id>", "args_snapshot": { "purpose": "manual acceptance" } }
```

**预期**

- 返回非空 `run_id`
- 返回 `manifest_uri = hep://runs/<run_id>/manifest`
- artifacts 中至少包含 `args_snapshot.json`

### 2.4 读取 `hep://runs/{run_id}/manifest`

在客户端资源面板或资源调用里读取：

- `hep://runs`
- `hep://runs/{run_id}/manifest`

**预期**

- `hep://runs` 能列出刚创建的 run
- manifest 中的首个 step 是 `run_create`
- manifest 会指向 run artifacts

### 2.5 对照磁盘布局

检查：

```text
<HEP_DATA_DIR>/projects/<project_id>/
<HEP_DATA_DIR>/runs/<run_id>/manifest.json
<HEP_DATA_DIR>/runs/<run_id>/artifacts/args_snapshot.json
```

**预期**

- 路径真实存在
- run manifest 与资源里读到的内容一致

---

## 3. Evidence 构建与查询

### 3.1 `hep_project_build_evidence`

使用本仓库 fixture：

- `packages/hep-mcp/tests/fixtures/latex/multifile/main.tex`

**调用**

```json
{
  "project_id": "<project_id>",
  "main_tex_path": "/absolute/path/to/autoresearch-lab/packages/hep-mcp/tests/fixtures/latex/multifile/main.tex",
  "paper_id": "fixture-paper"
}
```

**预期**

- 返回或写入 evidence catalog
- `hep://projects/<project_id>/papers/fixture-paper/evidence/catalog` 可读

### 3.2 `hep_run_build_writing_evidence`

**调用**

```json
{
  "run_id": "<run_id>",
  "latex_sources": [
    {
      "main_tex_path": "/absolute/path/to/autoresearch-lab/packages/hep-mcp/tests/fixtures/latex/multifile/main.tex",
      "include_cross_refs": true
    }
  ]
}
```

**预期**

- run artifacts 中出现 `latex_evidence_catalog.jsonl`
- 同时生成 embeddings / enrichment / source status 相关 artifacts

### 3.3 `hep_project_query_evidence`

**调用**

```json
{
  "project_id": "<project_id>",
  "query": "Content from subfile",
  "limit": 3
}
```

**预期**

- 返回 hits 或 query artifact URI + summary
- 至少有一个命中与 fixture 文本相关

### 3.4 `hep_project_playback_evidence`

从上一节的 evidence locator 或 catalog item 里取一个 `evidence_id`：

```json
{
  "project_id": "<project_id>",
  "paper_id": "fixture-paper",
  "evidence_id": "<evidence_id>"
}
```

**预期**

- 返回稳定 snippet
- snippet 与 evidence catalog 中的原文本对得上

---

## 4. 写作与导出

### 4.1 `hep_run_build_citation_mapping`

**调用**

```json
{
  "run_id": "<run_id>",
  "identifier": "arXiv:2001.00001"
}
```

**预期**

- run artifacts 中出现 citation mapping 相关 JSON artifacts

### 4.2 `hep_render_latex`

**调用**

```json
{
  "run_id": "<run_id>",
  "draft": "{... structured draft JSON ...}"
}
```

**预期**

- 成功时生成渲染后的 LaTeX artifacts
- 若引用缺失或未授权，应 fail-fast

### 4.3 `hep_export_project`

**调用**

```json
{
  "_confirm": true,
  "run_id": "<run_id>"
}
```

**预期**

- 生成 `master.bib`
- 生成 `report.tex` / `report.md`
- 生成 `research_pack.zip`

### 4.4 `hep_export_paper_scaffold`

**调用**

```json
{
  "_confirm": true,
  "run_id": "<run_id>"
}
```

**预期**

- 生成 `paper/` 脚手架
- 生成 `paper_scaffold.zip`

### 4.5 `hep_import_paper_bundle`

在 `paper/` 下准备好最终论文文件后调用：

```json
{
  "run_id": "<run_id>"
}
```

**预期**

- 生成 `paper_bundle.zip`
- 生成 `paper_bundle_manifest.json`
- 如有最终 PDF，可一并进入 run artifacts

---

## 5. 文献 / 数据工作流

### 5.1 `inspire_search`

**调用**

```json
{ "query": "pentaquark", "size": 5 }
```

**预期**

- 返回受限数量的结果
- 可拿到 `recid` 或标识符用于后续调用

### 5.2 `inspire_literature`

**调用**

```json
{ "mode": "get_paper", "recid": "1833986" }
```

**预期**

- 返回单篇论文的结构化元信息
- `get_paper` 不需要 `size`

### 5.3 `inspire_topic_analysis`

**调用**

```json
{ "mode": "timeline", "topic": "pentaquark", "limit": 10 }
```

**预期**

- 返回 timeline / evolution 相关摘要

### 5.4 launcher-backed literature workflow consumers

这部分不是 MCP 工具，而是当前真实存在的高层 workflow consumers：

```bash
autoresearch workflow-plan \
  --recipe literature_landscape \
  --phase prework \
  --query "bootstrap amplitudes" \
  --topic "bootstrap amplitudes"
```
先在目标外部 project root 执行 `autoresearch init`，然后在该 root 内或通过 `--project-root` 调用。这个推荐的 stateful launcher-backed front-door 会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 是较底层的并行 consumer。

```bash
python -m hep_autoresearch.orchestrator_cli \
  --project-root /abs/path/to/project \
  literature-gap \
  --tag gap-smoke \
  --topic "nucleon structure"
```
下面这个 `python -m hep_autoresearch.orchestrator_cli ... literature-gap` 示例只用于 maintainer/eval/regression 路径的 internal full-parser compatibility；安装态 `hepar` public shell 已不再暴露 `literature-gap`。

**预期**

- `autoresearch workflow-plan` 仍是唯一 installable public high-level literature entrypoint
- internal full-parser compatibility path 仍能解析 workflow plan or bundle 以供 regression coverage

---

## 6. 本地 reference providers

### 6.1 `zotero_local`

**调用**

```json
{ "mode": "list_collections", "limit": 5 }
```

**预期**

- 若 Zotero Local API 可用，应返回本地 collections

### 6.2 `pdg_info`

**调用**

```json
{}
```

**预期**

- 若 `PDG_DB_PATH` 已设置，应返回本地 DB 与 artifacts 目录信息

### 6.3 `pdg_find_particle`

**调用**

```json
{ "name": "electron", "limit": 5 }
```

**预期**

- 返回候选粒子列表

---

## 7. 常见排障

- 工具看不到：先做 `pnpm -r build`，再跑上面的 `listTools` sanity check
- 资源列表很少：这是设计如此；先看 `hep://projects` 或 `hep://runs`，再进入 manifest / artifact URI
- GUI 客户端找不到 Node：把 `command` 换成 Node 的绝对路径
- 想看 generic lifecycle state：不要从 `hep-mcp` 猜，直接使用 `autoresearch status --project-root ...`

---

## 8. 相关文档

- [`README.md`](../README.md)
- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/TOOL_CATEGORIES.md`](./TOOL_CATEGORIES.md)
- [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)
