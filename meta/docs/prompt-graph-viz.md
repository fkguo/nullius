# 通用图谱可视化层设计 Prompt

> **工作目录**: /home/user/Coding/Agents/Autoresearch/autoresearch-meta-graph-viz
> **工作分支**: `design/graph-viz` (worktree, 从 main @ e64423f 创建)
> **日期**: 2026-02-22

## 背景

Autoresearch 生态圈正在执行 114 项重构 (REDESIGN_PLAN.md v1.5.0-draft)。
全局约束: 所有组件未正式发布，无外部用户，可自由 breaking change，不需要向后兼容。

当前 research-team skill 中有一个 Claim DAG 渲染器:
- 文件: /home/user/Coding/Agents/Autoresearch/skills/research-team/render_claim_graph.py
- 功能: claims.jsonl + edges.jsonl → Graphviz DOT/PNG/SVG
- 模型: typed nodes (claim/hypothesis/evidence) + typed edges (supports/contradicts/derives) + status metadata

这个渲染器的核心能力 (typed graph → visualization) 与多个子系统同构:

1. **Track B Memory Graph (EVO-20)**: gene 谱系、signal→gene 关联、co-change edges、bandit 探索轨迹
   - 设计文档: docs/track-b-evo-20-memory-graph.md
   - Schema: schemas/memory-graph-*.schema.json

2. **文献关联图**: paper 之间的引用/竞争/扩展关系 (hep-research-mcp 的 inspire_* 工具输出)

3. **Ideas / hypothesis 关联图**: 想法之间的 supports/contradicts/fork (idea-core 的 IdeaCard 关系)
   - idea-core 源码: /home/user/Coding/Agents/Autoresearch/idea-core/

4. **研究进度图**: milestone 节点 + 完成状态 + 依赖链 (research-team 的 milestone tracking)

5. **研究演化轨迹**: 从探索到验证的状态流转

## 开始前

```bash
cd /home/user/Coding/Agents/Autoresearch/autoresearch-meta-graph-viz
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
```

## 设计任务

### a) 通用核心提取

请先阅读 render_claim_graph.py 源码:
- 文件: /home/user/Coding/Agents/Autoresearch/skills/research-team/render_claim_graph.py

回答:
- 从中提取什么作为通用核心 (graph renderer)?
- 保留什么作为 claim-specific adapter?
- 通用 node/edge 模型的字段定义

### b) Schema Adapter 设计

为以下每种图谱定义 adapter:
1. **Claim DAG adapter**: claims.jsonl + edges.jsonl → 通用 node/edge
2. **Memory Graph adapter**: EVO-20 SQLite/JSONL → 通用 node/edge
3. **Literature graph adapter**: INSPIRE paper metadata → 通用 node/edge
4. **Idea map adapter**: IdeaCard relations → 通用 node/edge
5. **Progress graph adapter**: milestone/task 状态 → 通用 node/edge

每种 adapter 需说明:
- 输入格式和来源
- 映射规则 (领域字段 → 通用字段)
- 领域特定的渲染样式 (颜色、形状、分组)

### c) 架构归属

这个可视化层在系统架构中归属哪里？
- 独立模块 (`packages/graph-viz/`)
- research-team 的子组件
- 平台级服务 (shared/)
- 其他

需要考虑: monorepo 结构 (NEW-05)、各组件的依赖方向、维护责任

### d) 渲染策略

是否需要支持交互式渲染 (D3.js/Mermaid/浏览器)，还是只需要静态输出 (DOT/PNG/SVG)?
考虑:
- 当前用户 (研究者 + agent) 的实际使用场景
- agent 消费图谱的方式 (structured data vs visual)
- 交互式渲染的复杂度与收益

### e) Memory Graph 集成

如何与 Track B 的 MemoryGraph 服务接口 (§6.6) 集成:
- 通过 adapter 直接查询 SQLite?
- 通过 MemoryGraph API 导出 JSONL?
- 两者都支持?

参考: docs/track-b-evo-20-memory-graph.md §6.6 服务接口

## 参考文件

优先阅读:
1. `/home/user/Coding/Agents/Autoresearch/skills/research-team/render_claim_graph.py` — 现有渲染器 (**必读**)
2. `docs/track-b-evo-20-memory-graph.md` — Memory Graph 设计
3. `schemas/memory-graph-*.schema.json` — Memory Graph schemas
4. `REDESIGN_PLAN.md` — 全局重构方案 (Phase 5 EVO-20/19/12a/21)
5. `/home/user/Coding/Agents/Autoresearch/idea-core/` — idea 引擎源码 (IdeaCard 关系)

可选参考:
- `hep-research-mcp-main/` — INSPIRE 文献检索工具 (文献图谱数据来源)
- `skills/research-team/` — research-team skill 目录结构

## 输出

请将设计文档写入 `docs/graph-visualization-layer.md`，包含:
1. 通用 node/edge schema 定义
2. 各 adapter 的映射规范 (含示例)
3. 架构归属建议 (含 REDESIGN_PLAN 中的 Phase 归属)
4. 渲染策略选择 (静态/交互) 及理由
5. Memory Graph 集成方案
6. 如需新增 REDESIGN_PLAN 项，请提出 item ID 和内容草稿 (但不要直接修改 REDESIGN_PLAN.md)

所有变更提交到 `design/graph-viz` 分支。

## 约束

- 遵循 ECOSYSTEM_DEV_CONTRACT.md (CODE-01 ≤200 eLOC 等)
- 无向后兼容负担 (见 REDESIGN_PLAN §全局约束)
- 设计应追求最终形态的简洁性
- 通用核心必须领域无关，领域逻辑通过 adapter 注入
