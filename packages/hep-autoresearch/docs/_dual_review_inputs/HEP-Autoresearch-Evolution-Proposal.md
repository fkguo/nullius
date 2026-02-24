# HEP-Autoresearch 演化方案 (v3.18 — 模式 A + Outcome Gate)

> 经三轮独立双模型审稿 (R1-R3) 收敛定稿至 v3.1。v3.2 基于工具生态调研新增三层架构。v3.3 解决 R4 审核 blocker。v3.4 纳入 R4 高价值非阻塞建议。v3.5 将 MCP 集成策略从硬编码桥接 (模式 B) 全面转向动态发现 + 结果验证 (模式 A + Outcome Gate)，同时基于 MCP 写作工具深度调研优化写作流水线设计。v3.6 对齐 repo 现状：更新耦合量化统计，修正路径语义 (inputs/outputs) 与 W_compute workspace / artifact contract 的一致性。v3.7 对齐 repo HEAD：标记 Phase A2 已完成，并更新耦合量化分母口径与基准 commit。v3.8 对齐 repo HEAD：标记 Phase A3 已完成；补齐耦合量化可复现命令；并将“未发布可不兼容 + 新 idea 分支决策（Opus+Gemini 评估；大改先人类审议）”明确写入实施门禁。v3.9 对齐 repo HEAD：标记 Phase A4 已完成（baryon_baryon_su6 声明式项目：run_cards + wrappers + collect_summary），并明确 A4/A6 之间 legacy domain 迁移策略（A4 允许 wrappers 调用 legacy toolkit；A6 再删除 legacy 并迁移实现）。v3.10 对齐 repo HEAD：标记 Phase A5 已完成（schrodinger_ho 独立验证项目：run_card v2 + 三 phase + eval cases），用于验证 W_compute/run_card v2 不对 baryon 用例过拟合。v3.11 对齐 repo HEAD：A6 已完成（删除 W2_v1/W4_potential_matrix legacy workflow + 移除 baryon 示例；回归改为以 W_compute 为核心）。v3.12 对齐 repo HEAD：B1 已完成（补齐 W_compute 用户文档 + examples 文档；固化可点击入口与最小命令集）。v3.13 对齐 repo HEAD：B2 已完成（run-card render: DAG 可视化；并补齐 CLI + 测试覆盖）。v3.14 对齐 repo HEAD：B4/B6 已完成（W_compute→MCP bridge Outcome Gate + `hepar doctor`/`smoke-test`），并补齐失败态审计产物（`bridge_state.json`/`bridge_report.json`）与协议协商/安全策略测试。v3.15 对齐 repo HEAD：C1 已完成（`hepar literature-gap`：MCP INSPIRE 工具链编排 + 可审计 artifact bundle + 离线 stub 测试），并补齐 C1 的 workflow spec 与 methodology trace。v3.16 对齐 repo HEAD：C2 (MVP-1) 已完成（`hepar method-design`：生成可运行 W_compute 插件项目脚手架；含 `pdg_snapshot` 模板、离线 stub 测试与 workflow spec）。v3.17 对齐 repo HEAD：C2 (MVP-2) 已完成（`spec_v1`：从 `method_spec` v1 结构化输入 materialize 可运行插件项目；含路径安全约束与离线回归测试）。v3.18 对齐 repo HEAD：补齐 `method_spec` v1 JSON Schema + 预校验脚本，便于共享/生成/在进入运行时前 fail-fast。
>
> 目标: 将项目从"一个硬编码示例的复现平台"演化为"可承载任意 HEP 研究问题的通用 Agent 平台"。

---

## 目录

- [审稿收敛摘要](#审稿收敛摘要)
- [现状诊断](#现状诊断)
- [设计原则与非目标](#设计原则与非目标)
- [现有工具生态](#现有工具生态-v32-新增)
- [三层架构: MCP / Skills / Agent](#三层架构-mcp--skills--agent-v32-新增)
- [方案一: 拆分领域示例 (纯声明式插件)](#方案一-拆分领域示例)
- [方案二: 构建通用计算工作流 (W_compute + run_card v2)](#方案二-构建通用计算工作流)
- [方案三: 重心转向研究能力](#方案三-重心转向研究能力)
- [实施路线图 (v3.2 修订版)](#实施路线图-v32-修订版)
- [附录A: 影响面分析](#附录a-影响面分析)
- [附录B: 审稿历史](#附录b-审稿历史)

---

## 审稿收敛摘要

### 当前状态: v3.18（实施门禁: Opus + Gemini-3-pro-preview 双审核收敛，2026-02-09）

本文档已完成“方案设计阶段”的四轮独立双模型审稿（R1-R4；见[附录B](#附录b-审稿历史)）。此外，从 v3.6 起，每次方案文档修订都必须通过“实施门禁”（Opus + Gemini-3-pro-preview）并归档到 artifacts:

- v3.6: READY (artifacts tag `M57-evolution-proposal-r2`)
- v3.7: READY (artifacts tag `M59-evolution-proposal-r2`)
- v3.8: READY (artifacts tag `M62-evolution-proposal-r1`)
- v3.9: READY (artifacts tag `M64-evolution-proposal-r1`)
- v3.10: READY (artifacts tag `M66-evolution-proposal-r1`)
- v3.11: READY (artifacts tag `M68-a6-dual-review-r1`)
- v3.12: READY (artifacts tag `M69-b1-docs-r2`)
- v3.13: READY (artifacts tag `M70-b2-run-card-render-r1`)
- v3.14: READY (artifacts tag `M72-evolution-proposal-r1`)
- v3.15: READY (artifacts tag `M74-evolution-proposal-r1`)
- v3.16: READY (artifacts tag `M76-evolution-proposal-r1`)
- v3.17: READY (artifacts tag `M78-evolution-proposal-r1`)
- v3.18: READY (artifacts tag `M80-evolution-proposal-r1`)

注: 下表为设计阶段的 R1-R4 审稿历史，不等同于每次文档修订的实施门禁。

| 轮次 | GPT-5.2 xhigh | Gemini | 结论 |
|------|---------------|--------|------|
| R1 | REVISE | REVISE | 方向正确，需补充关键设计细节 |
| R2 | REVISE (4 blockers) | APPROVE (with modifications) | 需解决 4 个 blocker 后可实施 |
| R3 | APPROVE (minor suggestions) | APPROVE | 收敛: 所有 blocker 已解决 |
| R4.1 | REVISE (3 blockers) | APPROVE | v3.2 工具生态集成: 需补桥接契约、修正 MCP 定义、收窄 P4 验收 |
| R4.2 | APPROVE | APPROVE | v3.3: 所有 R4 blocker RESOLVED |
| — | — | — | v3.4: 纳入 R4 高价值非阻塞建议 |
| — | — | — | v3.5: 模式 A + Outcome Gate 架构转型 |

### R2 GPT-5.2 四项 Blocker 及 v3 解决方案

| # | Blocker | v3 解决方案 |
|---|---------|------------|
| 1 | **路径语义未定义**: `inputs`, `outputs`, `cwd` 相对于什么目录？phase 间如何传递文件？ | 新增 [路径语义规范](#路径语义规范) 章节，定义 `${PROJECT_DIR}`, `${WORKSPACE}`, `${REPO_ROOT}` 三个基准目录及所有字段的解析规则 |
| 2 | **DAG 失败语义不完整**: `on_failure="continue"` 时依赖链如何传播？crash recovery 如何处理？ | 在 [Phase 状态机](#22-phase-状态机) 中补充完整失败传播规则、multi-dependency 语义、resume 与 crash recovery 规则 |
| 3 | **信任行为对自动化不友好**: 非交互环境下信任行为未定义 | 在 [安全信任模型](#15-安全信任模型) 中明确交互/非交互两种模式及 `--trust-project` 的强制要求 |
| 4 | **Schema 兼容性策略过于复杂**: 次版本号 + 未知字段 warning 引入隐性兼容性问题 | Schema 简化: `schema_version` 仅为整数，未知字段报 ERROR，仅支持当前版本 |

### R2 双方一致意见 (已在 v3 中采纳)

1. **删除 legacy shim**: 工具未发布，无外部用户，不需要向后兼容迁移路径
2. **压缩路线图**: 原 Phase A + B 合并为单一 Phase A
3. **Schema 严格模式**: 未知字段 ERROR (非 warning)，移除次版本号概念

### R3 审稿结果

v3 提交第三轮独立双模型审稿，双方均给出 APPROVE:

- **GPT-5.2 xhigh**: APPROVE with minor suggestions — 4 项 R2 blocker 全部 RESOLVED，无 remaining blocker
- **Gemini gemini-3-pro-preview**: APPROVE — 4 项 R2 blocker 全部 RESOLVED，无 remaining blocker，无新问题

### GPT-5.2 Minor Suggestions (已纳入 v3.1)

| # | Suggestion | v3.1 处置 |
|---|-----------|----------|
| 1 | **Run identity 歧义**: `run_card.run_id` vs CLI `--run-id` 需要优先级规则 | CLI `--run-id` 优先，覆盖 run_card 中的值；若未提供则使用 run_card.run_id |
| 2 | **Project discovery**: pseudo-code 用 `run_card_path.parent.parent` 推导 PROJECT_DIR 不够健壮 | 要求标准布局: `<project_dir>/run_cards/<card>.json`；可通过 `--project-dir` 显式覆盖 |
| 3 | **Pointer 格式**: `#/…` 应明确为 RFC 6901 JSON Pointer | 在 run_card v2 规格中明确: `pointer` 字段使用 RFC 6901 JSON Pointer 语法 |
| 4 | **收敛摘要准确性**: 附录B 表格将 "schema 严格性" 替代了 "workspace vs 执行模型" | 更新附录B R2 收敛表，补充 workspace 条目 |

---

## 现状诊断

### 核心矛盾

PROJECT_CHARTER 声明的 profile 是 `toolkit_extraction`（平台工程），但实际代码结构是"一个特定论文复现器 + 包裹它的通用壳"。

| 维度 | 现状 | 目标 |
|------|------|------|
| 新研究问题接入 | 需修改 5 个平台源文件 | 只需提供配置 + 脚本 |
| 内置物理 | SU(6) 势矩阵、重子质量、LEC 方程 | 零内置物理 |
| orchestrator_cli.py | 128K 单体，领域标识约 57 行命中 | 按职责拆分，零领域引用 |
| 工作流扩展 | 硬编码 if-else 分支 | 注册表驱动 |

### 耦合量化

```
领域专用代码:
  w2v1_lec_solve.py         460 行
  w2v1_poles.py             912 行
  w2v1_scattering_lengths.py 519 行
  w4_potential_matrix.py     779 行
 w2_reproduce.py            299 行
  ─────────────────────────────────
  合计:                    2,969 行 / 17,939 行 (16.6%)

领域标识符在平台代码中的出现:
  orchestrator_cli.py          57 行命中
  workflow_context.py          23 行命中
  orchestrator_regression.py   40 行命中
  ─────────────────────────────────
  合计:                       120 行命中

领域专用 eval case: E7, E8, E9, E10 (4 个 / 30 个)

项目中引用 recid-3109742 的文件: 30 个 (注: v3.6 的 125 统计包含 artifacts 等运行产物; v3.7 起收窄口径至项目源文件，排除 artifacts/, team/, paper/, references/, .hep/, .autoresearch/, .git/, __pycache__)

(统计口径: src/**/*.py 总行数排除 __pycache__；“领域标识符命中”按 `rg -n 'w2v1|W2_v1|potential_matrix|SU\\(6\\)|su6|baryon|LEC|lec_solve|scattering_lengths|poles' <file> | wc -l` 计算)
```

统计复现命令（基准 commit: hep-autoresearch@bb9dbfe）:

```bash
# 领域专用代码行数
wc -l \
  src/hep_autoresearch/toolkit/w2v1_lec_solve.py \
  src/hep_autoresearch/toolkit/w2v1_poles.py \
  src/hep_autoresearch/toolkit/w2v1_scattering_lengths.py \
  src/hep_autoresearch/toolkit/w4_potential_matrix.py \
  src/hep_autoresearch/toolkit/w2_reproduce.py

# src/**/*.py 总行数（排除 __pycache__）
python3 - <<'PY'
from pathlib import Path
total = 0
for p in Path("src").rglob("*.py"):
    if "__pycache__" in p.parts:
        continue
    total += sum(1 for _ in p.open("r", encoding="utf-8", errors="replace"))
print(total)
PY

# 领域标识符命中（平台代码）
rg -n 'w2v1|W2_v1|potential_matrix|SU\\(6\\)|su6|baryon|LEC|lec_solve|scattering_lengths|poles' src/hep_autoresearch/orchestrator_cli.py | wc -l
rg -n 'w2v1|W2_v1|potential_matrix|SU\\(6\\)|su6|baryon|LEC|lec_solve|scattering_lengths|poles' src/hep_autoresearch/toolkit/workflow_context.py | wc -l
rg -n 'w2v1|W2_v1|potential_matrix|SU\\(6\\)|su6|baryon|LEC|lec_solve|scattering_lengths|poles' src/hep_autoresearch/toolkit/orchestrator_regression.py | wc -l

# 项目中引用 recid-3109742 的文件数（排除运行产物目录）
rg -l 'recid-3109742' --glob '!{artifacts,team,paper,references,.hep,.autoresearch,.git,__pycache__}/**' | wc -l
```

---

## 设计原则与非目标

### 设计原则

1. **声明式优先**: 项目插件通过 JSON 声明，不通过 Python import-by-path。可执行逻辑通过 shell backend 调用。
2. **预发布: 允许不向后兼容/直接切换**: 工具未发布，零外部用户。旧代码直接删除替换，不设 legacy shim 或双路径迁移期；用双模型审核 + eval 回归门禁控制风险。回归锚点以 `W_compute` + `examples/schrodinger_ho`（E31/E32）为主，并用 `orchestrator_regression` 的 `wcompute` scenario 覆盖默认 A3 门禁行为。
3. **最小正确核心**: W_compute v1 只实现串行 DAG + 状态持久化 + resume + 产物溯源。不追求完整的工作流引擎。
   - **W_compute 命名说明 (v3.3)**: `W_compute` 沿用项目的 `W_` 前缀约定 (W1_ingest, W3_revision)，直接替代 W2/W4 的 legacy 位。虽名为 "compute"，实为**通用声明式 DAG 执行引擎**，可运行任何 shell 命令链 (计算、绘图、数据处理、验证等)。在 `run_card v2` 中通过 `"workflow_id": "W_compute"` 引用。
4. **安全显式化**: 执行用户脚本需要显式信任，路径约束在项目根目录内。
5. **先查后写 (Reuse-first)**: W_compute phase 的脚本生成过程中，agent 应先调查现有工具生态 (hep-calc、MCP 工具、PDG 数据库等) 是否已有成熟实现，只在确认不存在或不适用时才从头编写。research-team skill 中的代码写作规范同样适用。
   - **可审计 (v3.4 新增)**: 每个新功能需产出一条 methodology trace 记录: "查过哪些现有工具 → 为何不适用 → 为何新写"。trace 存储在 `${WORKSPACE}/methodology_traces/` 下，格式为 JSON (含 `searched_tools[]`, `rejection_reasons[]`, `new_impl_rationale`)。
6. **三层分离**: MCP (原子操作) → Skills (编排模式) → Agent (状态/工作流)。各层职责明确，不越级重复实现。
7. **新功能下沉 (Sink-to-reusable)**: 需要新编写的功能，应优先实现为可复用的 MCP 工具或 skill，而非嵌入 agent 一次性逻辑。判定标准见下方决策框架。
8. **动态发现优先 (v3.5 新增)**: Agent 与 MCP 工具的集成应通过运行时动态发现 (`ToolSearch` + 读工具描述) 实现，而非在代码中硬编码工具名和参数结构。硬编码 MCP 调用 (模式 B) 仅在有明确理由时允许 (如性能关键路径)。
9. **结果契约优先 (v3.5 新增)**: 跨层集成 (W_compute → MCP、MCP 写作工具 → research-writer) 通过验证**结果是否满足契约** (Outcome Gate) 来保证质量，而非硬编码**过程步骤**。这使 agent 保留编排灵活性，同时确保产出质量。
10. **允许研究分支与方案演化 (v3.6 补充)**: 实施过程中出现“更好的方案/方法/架构”是正常研究流程的一部分。Agent 可以提出替代方案并组织 Opus + Gemini-3-pro-preview 共同评估其利弊与迁移成本；若属于**大改**（改变目标/验收/关键接口/阶段顺序），必须先提交给人类审议通过，再进入实现。
11. **对外发布示例策略 (v3.14 补充)**: 选项 A（当前偏好）：对外发布时主仓库不保留 `examples/` 作为示例集（避免将示例演化混入主程序开发/发布代码）。预发布阶段可保留 `examples/` 作为回归锚点；在首次对外发布前，将示例项目迁移至独立仓库或 release bundle，并把必要的最小夹具迁入 `tests/fixtures/` 以维持回归稳定性。

### 新功能归属决策框架 (v3.2 新增)

当识别到需要新编写的功能时，按以下流程决定其实现位置:

```
需要新功能
  ↓
是否为原子化操作？(显式 I/O，幂等或受控副作用)
  ├─ 是 → 实现为 MCP 工具
  │       例: 新的数据库查询、格式转换、数值检查、产物写入
  │
  └─ 否 → 是否为可复用的多步编排模式？
           ├─ 是 → 实现为 Skill
           │       例: 新的审稿流程、新的计算编排模式
           │
           └─ 否 → 是否为 W_compute 引擎核心？(状态管理、DAG 编排)
                    ├─ 是 → 实现在 agent 层
                    │       例: phase 状态机、resume 逻辑
                    │
                    └─ 否 → 实现为项目脚本 (examples/ 下)
                            例: 特定物理计算、特定数据处理
```

**归属判定示例**:

| 新功能 | 归属 | 理由 |
|--------|------|------|
| 将 Mathematica 输出转 JSON | MCP 工具 | 无状态转换，可被多个项目复用 |
| 自动从 arXiv TeX 提取公式 | MCP 工具 | 无状态提取，已有类似工具 (`hep_project_build_evidence`) 可扩展 |
| 双模型审稿 + 收敛判定 | Skill | 多步编排模式，已有 review-swarm |
| 参数敏感度分析编排 | Skill | 可复用的 sweep + aggregate 模式 |
| Phase 状态持久化 | Agent 层 | W_compute 引擎核心 |
| DAG 拓扑排序 + 失败传播 | Agent 层 | W_compute 引擎核心 |
| SU(6) 势矩阵计算 | 项目脚本 | 领域特定，不可复用 |

### 非目标 (v3 明确不做)

| 非目标 | 理由 |
|--------|------|
| 并行 phase 执行 | 串行满足当前所有用例；并行引入调度器复杂度 |
| 分布式执行 (Slurm/K8s) | 超出单机 agent 平台定位 |
| 容器化隔离 | 用户脚本在本地执行，依赖系统环境 |
| 条件分支 (if/else phases) | 用 shell 脚本内部逻辑处理 |
| 内置缓存/增量构建 | 通过 resume 语义 (checksum 匹配跳过已完成 phase) 简化实现 |
| run_card GUI 编辑器 | JSON + JSON Schema + CLI validate 足够 |
| Schema 次版本号 / 未知字段容忍 | 仅支持当前 schema version，未知字段视为 ERROR |
| Legacy shim / 双路径迁移 | 零外部用户，直接切换 |

---

## 现有工具生态 (v3.2 新增)

> v3.2 新增。深入调研后发现，项目已积累大量可复用的 skills 和 MCP 工具。演化方案必须充分利用这些已有能力，避免重复造轮子。

### MCP 工具层 (hep-research MCP, 70+ 工具)

| 类别 | 工具数 | 关键工具 | 能力 |
|------|-------|---------|------|
| **项目/运行管理** | 15 | `hep_project_create/get/list`, `hep_run_create`, `hep_run_stage_content`, `hep_run_read_artifact_chunk` | 项目 CRUD、运行创建、产物暂存/读取、manifest 管理 |
| **证据构建** | 8 | `hep_project_build_evidence`, `hep_project_query_evidence`, `hep_run_build_writing_evidence`, `hep_run_build_pdf_evidence`, `hep_run_build_evidence_index_v1` | 从论文 PDF/TeX 提取结构化证据，语义查询 |
| **写作流水线** | 20+ | `hep_run_writing_create_token_budget_plan_v1`, `create_outline_candidates`, `create_section_write_packet`, `submit_section_candidates`, `create_section_judge_packet`, `integrate_sections_v1` | 完整的 evidence-first 论文写作: 预算规划 → 大纲候选 → 大纲评判 → 分节撰写 → 分节评判 → 审稿 → 修订 → 整合 |
| **INSPIRE 研究** | 8 | `inspire_search`, `inspire_literature`, `inspire_critical_research`, `inspire_topic_analysis`, `inspire_network_analysis`, `inspire_field_survey`, `inspire_deep_research` | 文献搜索、引用网络分析、关键研究发现、领域综述、深度研究 |
| **PDG 数据** | 6 | `pdg_find_particle`, `pdg_get_property`, `pdg_get_decays`, `pdg_get_measurements` | 粒子属性查询、衰变模式、实验测量值 |
| **Zotero 集成** | 5 | `zotero_find_items`, `zotero_search_items`, `zotero_export_items`, `zotero_add` | 文献库管理、导入导出 |
| **导入导出** | 5 | `hep_export_project`, `hep_export_paper_scaffold`, `hep_import_paper_bundle`, `hep_import_from_zotero`, `hep_render_latex` | 项目导出、论文脚手架、LaTeX 渲染 |

### Skills 编排层 (6 个研究类 skills)

| Skill | 定位 | 核心能力 | 与本方案的关系 |
|-------|------|---------|---------------|
| **hep-calc** | Mathematica/Julia HEP 计算编排 | 符号推导、数值积分、LaTeX 审计、Mathematica/Julia 代码生成 | W_compute phase 脚本可调用 hep-calc 生成的代码；不应重新实现符号计算能力 |
| **research-team** | 双成员收敛工作流 | 2 人独立推导 → 收敛门禁 → 可复现胶囊；含代码写作规范 | 提供代码写作规范 (W_compute 脚本生成应遵守)；收敛模式可嵌入 W_compute gates |
| **research-writer** | 确定性论文撰写 | scaffold → 分节起草 → consume-manifest (与 MCP 写作工具对接) | 写作环节直接使用此 skill + MCP 写作流水线，W_compute 不涉及 |
| **referee-review** | 离线确定性审稿 | 严格 JSON schema 输出 (VERDICT + 5 节)、无网络 | 可作为 W_compute phase 的审稿后处理；输出格式已标准化 |
| **review-swarm** | 双模型 clean-room 执行 | Claude + Gemini 独立执行 → 输出合同验证 → 自动回退 → 多样性追踪 | 为阶段门禁 (双模型审核) 提供标准化执行基础设施 |
| **codex/gemini-cli-runner** | CLI 调用封装 | 文件输入、模型回退、重试、dry-run | review-swarm 的底层依赖；也可独立用于单模型任务 |

### 关键发现

1. **MCP 项目/运行系统与 W_compute 互补而非重叠**: MCP 管理的是"研究项目"元数据 + 证据 + 写作流水线；W_compute 管理的是"计算任务"的 DAG 执行 + 产物溯源。两者通过 `run_id` 关联。
2. **写作能力已完备**: MCP 写作流水线 (20+ 工具) + research-writer skill 已覆盖从证据提取到论文整合的完整流程。方案三 §3.2 中"写作"能力不仅仅是"足够"，而是**成熟且结构化**。
3. **研究发现能力已有基础**: MCP INSPIRE 工具 (`inspire_critical_research`, `inspire_topic_analysis`, `inspire_network_analysis`) 已提供文献缺口发现、引用网络分析等能力。P4 不应从头构建，而应编排这些已有工具。
4. **双模型审核基础设施已就绪**: review-swarm 提供了标准化的 Claude + Gemini clean-room 执行、输出合同验证、自动回退。阶段门禁应复用此基础设施。
5. **代码写作有成熟规范**: research-team skill 包含详细的代码写作规范 (函数签名、测试要求、收敛条件)。W_compute phase 脚本生成应遵守这些规范。

---

## 三层架构: MCP / Skills / Agent (v3.2 新增)

> v3.2 新增。明确三层职责边界，防止越级重复实现。

```
┌──────────────────────────────────────────────────────┐
│  Agent 层 (hepar CLI + W_compute 引擎)               │
│  ─ 状态管理 (phase_state.json, manifest.json)        │
│  ─ DAG 编排 (拓扑排序、失败传播、resume)             │
│  ─ 研究分支 (plan.branching: 新 idea → 分支候选 → 收敛选择) │
│  ─ 安全信任 (TTY 检测、路径约束)                     │
│  ─ 产物溯源 (sha256、workspace 结构)                 │
├──────────────────────────────────────────────────────┤
│  Skills 层 (编排模式)                                 │
│  ─ hep-calc: Mathematica/Julia 计算编排              │
│  ─ research-team: 双成员收敛工作流                    │
│  ─ research-writer: 确定性论文撰写                    │
│  ─ referee-review: 结构化审稿                         │
│  ─ review-swarm: 双模型 clean-room 执行               │
├──────────────────────────────────────────────────────┤
│  MCP 层 (原子操作，显式 I/O)                          │
│  ─ 70+ 个工具: 项目管理、证据构建、写作流水线、       │
│    INSPIRE 搜索、PDG 查询、Zotero 集成               │
│  ─ 每个工具: 原子化、显式输入输出、幂等或受控副作用   │
└──────────────────────────────────────────────────────┘
```

**MCP 层特征澄清 (v3.3 修正)**: MCP 工具并非严格无副作用。部分工具 (如 `hep_run_create`, `hep_run_stage_content`, `zotero_add`) 会创建/写入本地 artifact 或外部系统。MCP 层的判据是:
- **原子化**: 单次调用完成一个完整操作，无需多步协调
- **显式 I/O**: 输入参数和输出结构明确定义
- **幂等或受控副作用**: 同一输入重复调用产生相同结果 (幂等)，或副作用范围可预测 (受控)

### 职责边界规则

| 操作 | 归属 | 不应归属 |
|------|------|---------|
| 搜索 INSPIRE 文献 | MCP (`inspire_search`) | Agent 直接调 API |
| 分析引用网络 | MCP (`inspire_network_analysis`) | W_compute phase |
| 提取论文证据 | MCP (`hep_project_build_evidence`) | Agent 自行解析 PDF |
| 符号推导 | Skills (hep-calc) | W_compute phase 从头写 Mathematica |
| 双成员收敛判定 | Skills (research-team) | Agent 硬编码比较逻辑 |
| 双模型执行 + 回退 | Skills (review-swarm) | Agent 手动调两次 CLI |
| 论文写作全流程 | Agent 动态编排 MCP 写作工具箱 + Skills (research-writer 验证) | Agent 硬编码固定调用顺序 |
| DAG 执行 + 状态持久化 | Agent (W_compute) | MCP 或 Skills |
| 运行 workspace + 溯源 | Agent (W_compute) | MCP run 系统 |
| 阶段门禁双模型审核 | Agent 编排 + Skills (review-swarm) | Agent 从头实现 |
| 新 idea / 方法分支评估 | Agent (plan.branching) + Skills (review-swarm / referee-review) | MCP 或 W_compute phase 内隐式改动 |

### W_compute 与现有工具的集成点

> v3.5 修订: 所有集成点采用模式 A (动态发现)，agent 通过 ToolSearch 发现 MCP 工具并按工具描述构造调用，不在代码中硬编码工具名或参数。

1. **Phase 脚本生成**: Agent 生成 W_compute phase 脚本时，应先查询是否可复用 hep-calc 的输出 (Mathematica/Julia 代码)、PDG 数据 (粒子属性)、INSPIRE 文献 (已有计算结果)。
2. **Phase 审稿**: phase 产物可交给 referee-review skill 进行结构化审稿，输出标准 JSON 格式。
3. **阶段门禁**: 实施路线图中的"双模型审核收敛"应复用 review-swarm 的 `run_dual_task.py`。
4. **结果写入论文**: W_compute 完成后，agent 动态发现 MCP 写作工具，自行决定调用顺序和组合方式，将计算结果整合入论文。research-writer `consume_manifest` 作为最终确定性验证 + 编译层。
5. **MCP run 桥接**: W_compute 完成后，agent 动态发现 MCP 项目/运行管理工具，将计算产物注册到 MCP evidence 系统。桥接质量通过 Outcome Gate 验证 (见 B4)。

---

## 方案一: 拆分领域示例

### 目标

将领域示例从平台核心代码中完全解耦，使其成为"研究项目插件"；平台仅提供通用执行与审计能力（W_compute + run_card v2）。

注：`baryon_baryon_su6` 用例已作为临时压力测试完成验证后从 main 移除（预发布不要求兼容；避免将领域代码混入将发布的主代码）。当前 repo 以 `examples/schrodinger_ho/` 作为轻量验证插件示例。

### 1.1 目标目录结构

```
hep-autoresearch/
├── src/hep_autoresearch/
│   ├── toolkit/
│   │   ├── w1_ingest.py            # 保留 (通用)
│   │   ├── w2_reproduce.py         # 保留 (toy regression anchor)
│   │   ├── w3_revision.py          # 保留 (通用)
│   │   ├── literature_survey*.py   # 保留 (通用)
│   │   ├── w_compute.py            # 新增: 通用计算引擎
│   │   ├── run_card_schema.py      # 新增: run_card v2 解析/验证
│   │   ├── adapters/
│   │   │   ├── base.py             # 保留 (通用接口)
│   │   │   ├── registry.py         # 改造: 支持声明式项目发现
│   │   │   ├── shell.py            # 保留 (通用)
│   │   │   └── artifacts.py        # 保留 (通用)
│   │   │
│   │   └── (w2v1_* / w4_potential_matrix 已删除)
│   │
│   ├── cli/
│   │   └── dispatch.py             # 从 orchestrator_cli.py 提取
│   │
│   └── orchestrator_cli.py         # 改造: 移除所有领域分支
│
├── examples/
│   └── schrodinger_ho/              # 验证项目 (声明式 W_compute)
│       ├── project.json
│       ├── scripts/
│       │   ├── derive_params.py      # 解析推导: E0=omega/2
│       │   ├── solve_numerics.py     # 确定性 RK4: 求解 ODE
│       │   └── validate.py           # 对比解析解 (RMSE/max_abs_diff)
│       ├── run_cards/
│       │   └── ho_groundstate.json
│
└── evals/cases/
    ├── E31-schrodinger-ho-params/
    ├── E32-schrodinger-ho-wavefunction/
    └── ...
```

### 1.2 项目描述文件 (project.json) — v3 修订版

**关键设计**: 纯声明式。无 `entry/callable/inputs_class` 等 Python import-by-path 字段。工作流通过 `run_card` 路径引用，执行通过 shell backend。

```json
{
  "schema_version": 1,
  "project_id": "schrodinger_ho",
  "title": "Schrodinger equation validation: harmonic oscillator ground state (toy)",
  "description": "Declarative W_compute project to validate run_card v2 without domain coupling.",

  "run_cards": {
    "ho_groundstate": "run_cards/ho_groundstate.json"
  },

  "required_references": [],

  "eval_cases": []
}
```

**路径语义**: `run_cards` 和 `eval_cases` 路径相对于 `${PROJECT_DIR}` (即包含 `project.json` 的目录)。`required_references` 路径相对于 `${REPO_ROOT}` (见 [路径语义规范](#路径语义规范))。

### 1.3 注册表改造

**当前** (`adapters/registry.py`): 硬编码 workflow_id -> Adapter 的映射。

**改造后**: 注册表支持两种来源:
1. 内置工作流 (W1_ingest, W3_revision 等通用工作流)
2. 项目 run_cards (从 `examples/*/project.json` 或 `--project-dir` 指定路径发现)

```python
_BUILTIN_WORKFLOWS = {
    "W1_ingest",
    "W3_revision",
    "W3_literature_survey_polish",
    "W_compute",          # 新增: 通用计算
    "ADAPTER_shell_smoke",
}

def discover_project_run_cards(project_dir: Path) -> dict[str, Path]:
    """从 project.json 发现可用 run_cards。"""
    pj = json.loads((project_dir / "project.json").read_text())
    return {name: project_dir / path for name, path in pj["run_cards"].items()}

def verify_project_references(project_dir: Path, repo_root: Path) -> list[str]:
    """预检: 确认 required_references 存在。"""
    ...
```

### 1.4 安全信任模型 (v3 修订版)

**交互模式** (默认，检测到 TTY):

```
hepar run --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
→ 检测到 run_card 中的 shell 命令
→ 提示: "This run_card executes shell commands. Trust this project? [y/N]"
→ 用户确认后执行
```

**非交互模式** (无 TTY):

```
hepar run --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
→ 检测到无 TTY
→ 检测到缺少 --trust-project 标志
→ ERROR: "Non-interactive mode requires --trust-project flag. Aborting."
→ 退出码 1
```

**自动信任** (CI/automation):

```
hepar run --trust-project --run-card ...
→ 跳过确认，直接执行
```

**信任规则**:

- 信任 **不持久化**: 每次 `hepar run` 调用独立判断。不在磁盘上记录"已信任项目"。
- 交互模式 (TTY 存在): 提示用户确认。
- 非交互模式 (TTY 不存在): **必须** 传入 `--trust-project`，否则以 error 终止。
- CI/automation 环境: 始终传入 `--trust-project`。

**注意**: `--trust-project` 只回答“是否允许执行项目提供的 shell 命令”。它不绕过 `phase.gates` 声明的 A1-A5 审批门禁：即使已信任项目，包含 `gates: ["A3"]` 的 phase 仍需先完成 A3 审批才会执行。

**路径约束**:

- `backend.cwd` 必须在 `${PROJECT_DIR}` 内 (不允许 `../..` 或绝对路径逃逸)
- `inputs` / `outputs` 必须为相对路径，且不得包含 `..` 或绝对路径；`phases/<...>/...` 形式的输入相对于 `${WORKSPACE}` 解析，其它输入相对于 `${PROJECT_DIR}` 解析 (均做 containment enforcement)
- `outputs` 路径相对于 phase 的工作目录；phase 成功后复制到 `${WORKSPACE}/phases/<phase_id>/` (复制时拒绝 symlink，避免越权拷贝)
- 执行前记录 run_card 快照与所有脚本 sha256 到 `manifest.json` (artifact SSOT)

---

## 路径语义规范

> **R2 GPT-5.2 Blocker #1**: 路径相对于什么？phase 间如何传递文件？

### 基准目录定义

| 符号 | 定义 | 示例 |
|------|------|------|
| `${PROJECT_DIR}` | 包含 `project.json` 的目录 | `examples/schrodinger_ho/` |
| `${WORKSPACE}` | W_compute 的工作目录 (artifact step) | `artifacts/runs/M1-my-calc-r1/w_compute/` |
| `${REPO_ROOT}` | 仓库根目录 | `hep-autoresearch/` |

### 字段路径解析规则

| 字段 | 相对于 | 说明 |
|------|--------|------|
| `backend.cwd` | `${PROJECT_DIR}` | Phase 执行时的工作目录。受约束: 解析后的绝对路径必须在 `${PROJECT_DIR}` 内，不得逃逸。 |
| `backend.argv` 中的脚本路径 | `${PROJECT_DIR}` | 如 `"scripts/solve.py"` 解析为 `${PROJECT_DIR}/scripts/solve.py` |
| `inputs` | `${PROJECT_DIR}` 或 `${WORKSPACE}` | 约定: 以 `phases/<...>/...` 形式引用上游输出时相对于 `${WORKSPACE}` 解析；其它输入相对于 `${PROJECT_DIR}` 解析 (两者均做 containment enforcement)。 |
| `outputs` | `${PROJECT_DIR}` (phase 工作目录) | `outputs` 中路径相对于 phase 的工作目录；phase 成功后复制到 `${WORKSPACE}/phases/<phase_id>/`。 |
| `required_references` (project.json) | `${REPO_ROOT}` | 论文源文件等全局资源 |
| `headline_numbers.source` | `${WORKSPACE}` | 从 workspace 中读取结果文件 |
| `acceptance` 中的 `path` | `${WORKSPACE}` | 验收检查读取 workspace 中的产物 |

### 执行语义

1. Phase 执行时，工作目录设为 `${PROJECT_DIR}` (除非 `backend.cwd` 指定子目录)
2. Phase 的脚本从 `${PROJECT_DIR}` 读取输入、执行计算
3. 输出文件由脚本写入其当前工作目录或指定的输出路径
4. Phase 成功完成后，引擎将 `outputs` 中声明的文件 **复制** 到 `${WORKSPACE}/phases/<phase_id>/`
5. 后续 phase 通过 `${WORKSPACE}/phases/<upstream_phase_id>/<filename>` 访问上游产物

### 路径解析示例

给定以下 run_card 片段:

```json
{
  "phases": [
    {
      "phase_id": "derive_params",
      "backend": {
        "argv": ["python3", "scripts/derive_params.py"],
        "cwd": "."
      },
      "inputs": [],
      "outputs": ["results/params.json"]
    },
    {
      "phase_id": "solve_numerics",
      "depends_on": ["derive_params"],
      "backend": {
        "argv": ["python3", "scripts/solve_numerics.py",
                 "--params", "phases/derive_params/results/params.json"],
        "cwd": "."
      },
      "inputs": ["phases/derive_params/results/params.json"],
      "outputs": ["results/wavefunction.npy", "results/diagnostics.json"]
    }
  ]
}
```

解析过程:

- `derive_params` 执行: cwd = `${PROJECT_DIR}/.` = `${PROJECT_DIR}`。脚本 = `${PROJECT_DIR}/scripts/derive_params.py`。输出写入 `${PROJECT_DIR}/results/params.json`，然后复制到 `${WORKSPACE}/phases/derive_params/results/params.json`。
- `solve_numerics` 执行: cwd = `${PROJECT_DIR}`。`inputs` 中的 `phases/derive_params/results/params.json` 相对于 `${WORKSPACE}` 解析。引擎验证该文件存在后执行。`backend.argv` 中的 `phases/derive_params/results/params.json` 在命令行替换时解析为 `${WORKSPACE}/phases/derive_params/results/params.json` 的绝对路径。

### 约束检查 (引擎启动时)

引擎在执行任何 phase 前进行以下检查:

1. `backend.cwd` 解析后必须在 `${PROJECT_DIR}` 内 (containment enforcement)
2. `backend.argv` 中的脚本路径必须存在于 `${PROJECT_DIR}` 内
3. `outputs` 不含 `..` 或绝对路径
4. `required_references` 引用的文件在 `${REPO_ROOT}` 下存在

---

## 方案二: 构建通用计算工作流

### 目标

用户定义新的研究问题时，不需要修改任何平台源码。只需提供:
1. 一个 **run_card v2** (声明要执行什么)
2. 一组 **计算脚本** (实现具体物理)
3. 可选的 **验收条件** (eval case)

### 2.1 run_card v2 规格 — v3 修订版

**v3 关键变更**:
- `schema_version` 为整数 (仅当前版本有效，不支持次版本号)
- 未知字段 → ERROR (非 warning)
- 移除 `engine_compat` 字段 (仅支持当前引擎版本，未来需要时再加)
- 路径语义全部明确 (见 [路径语义规范](#路径语义规范))

```json
{
  "schema_version": 2,
  "run_id": "M1-my-calc-r1",
  "workflow_id": "W_compute",
  "title": "Compute X cross-section at NLO",
  "description": "...",

  "parameters": {
    "n_points": {"type": "integer", "default": 100, "description": "Grid points"},
    "energy_mev": {"type": "number", "description": "Center-of-mass energy (MeV)"}
  },

  "on_failure": "fail-fast",

  "phases": [
    {
      "phase_id": "setup",
      "description": "Prepare input files",
      "inputs": [],
      "backend": {
        "kind": "shell",
        "argv": ["python3", "scripts/prepare_inputs.py",
                 "--n-points", "${n_points}",
                 "--energy", "${energy_mev}"],
        "cwd": ".",
        "timeout_seconds": 60
      },
      "outputs": ["results/inputs.json"],
      "gates": [],
      "depends_on": [],
      "retries": 0
    },
    {
      "phase_id": "main",
      "description": "Run NLO calculation",
      "inputs": ["phases/setup/results/inputs.json"],
      "backend": {
        "kind": "shell",
        "argv": ["python3", "scripts/run_nlo.py",
                 "--config", "phases/setup/results/inputs.json"],
        "cwd": ".",
        "timeout_seconds": 3600
      },
      "outputs": [
        "results/results.json",
        "results/diagnostics.json"
      ],
      "gates": ["A3"],
      "depends_on": ["setup"],
      "retries": 2
    },
    {
      "phase_id": "validate",
      "description": "Compare with known values",
      "inputs": ["phases/main/results/results.json"],
      "backend": {
        "kind": "shell",
        "argv": ["python3", "scripts/validate.py",
                 "--results", "phases/main/results/results.json"],
        "cwd": ".",
        "timeout_seconds": 120
      },
      "outputs": ["results/validation_report.json"],
      "gates": [],
      "depends_on": ["main"],
      "retries": 0
    }
  ],

  "headline_numbers": {
    "source": "phases/main/results/results.json",
    "extract": [
      {"pointer": "#/sigma_nlo_pb", "label": "sigma_NLO (pb)", "tier": "T1"},
      {"pointer": "#/k_factor", "label": "K-factor", "tier": "T2"},
      {"pointer": "#/scale_uncertainty_percent", "label": "Scale unc. (%)", "tier": "T3"}
    ]
  },

  "acceptance": {
    "json_numeric_checks": [
      {"path": "phases/main/results/results.json", "pointer": "#/sigma_nlo_pb", "min": 10.0, "max": 100.0},
      {"path": "phases/main/results/diagnostics.json", "pointer": "#/numerical_stability", "min": 0.99}
    ]
  }
}
```

**路径语义说明**: `inputs` 中引用上游 phase 输出时使用 `phases/<upstream_id>/<output_path>` 格式，相对于 `${WORKSPACE}` 解析。`outputs` 中的路径相对于 phase 的工作目录，成功后复制到 `${WORKSPACE}/phases/<phase_id>/`。`headline_numbers.source` 和 `acceptance` 中的 `path` 相对于 `${WORKSPACE}` 解析。

**Schema 严格性**: 引擎解析 run_card 时，遇到 schema 中未定义的字段立即报 ERROR 并终止。不存在 warning-and-continue 行为。`schema_version` 必须等于引擎支持的当前版本 (整数 `2`)，否则报 ERROR。

**Pointer 格式**: `headline_numbers.extract[].pointer` 和 `acceptance.json_numeric_checks[].pointer` 使用 [RFC 6901 JSON Pointer](https://datatracker.ietf.org/doc/html/rfc6901) 语法 (如 `#/sigma_nlo_pb` → key `sigma_nlo_pb` at document root)。

### 2.2 Phase 状态机 (v3 修订版)

每个 phase 在运行时有以下状态:

```
NOT_STARTED ──► PENDING ──► RUNNING ──► SUCCEEDED
                               │            │
                               ▼            ▼
                            FAILED     (后续 phase)
                               │
                               ▼
                          [retries > 0?]
                           ├─ yes ──► RUNNING (retry)
                           └─ no ──► FAILED (terminal)
```

特殊状态:
- `BLOCKED_BY_GATE`: phase 需要审批门禁，等待人工确认
- `SKIPPED`: 上游 phase 失败且当前 phase 依赖于该上游 (在 `on_failure="continue"` 模式下)

#### DAG 失败语义 (完整规则)

**`on_failure="fail-fast"`** (默认):

- 第一个 phase 进入 FAILED 状态 → 触发 `ABORT_RUN`
- 所有尚未开始的 phase → 保持 `NOT_STARTED`
- 当前 run 立即终止，返回错误报告

**`on_failure="continue"`**:

- 失败的 phase → `FAILED`
- 该 phase 的 **直接及间接依赖者** → `SKIPPED`
- 与失败 phase **无依赖关系**的 phase → 正常继续执行

**Multi-dependency 规则**:

- 一个 phase 声明 `"depends_on": ["A", "B"]`，当且仅当 A 和 B **均为** `SUCCEEDED` 时该 phase 才会执行
- 若 A 或 B 中**任一**为 `FAILED` 或 `SKIPPED`，则该 phase → `SKIPPED`

**SKIPPED 的传播性**:

- `SKIPPED` 视同 `FAILED` 进行传播: 若 phase C 依赖 phase B，B 被 SKIPPED，则 C 也被 SKIPPED

#### Resume 语义 (v3 修订版)

```bash
hepar run --run-id M1-my-calc-r1 --workflow-id W_compute --run-card card.json --resume
```

Resume 逻辑:
1. 读取 `${WORKSPACE}/phase_state.json`
2. 对每个 `SUCCEEDED` phase: 校验 `outputs_manifest.json` 中的 sha256 是否与磁盘文件匹配
   - 匹配 → 跳过该 phase
   - 不匹配 → 视为 `FAILED`，从该 phase 重新执行
3. 对每个 `FAILED` phase: 重新执行 (从头开始)
4. 对每个 `SKIPPED` phase: 根据其上游 phase 的最新状态重新评估
   - 所有上游均为 `SUCCEEDED` → 该 phase 重新进入 `PENDING`，正常执行
   - 仍有上游为 `FAILED` / `SKIPPED` → 该 phase 保持 `SKIPPED`

#### Crash Recovery

若引擎在某个 phase 处于 `RUNNING` 状态时崩溃 (进程被 kill、OOM 等):
- 下次 `--resume` 时，该 phase 视为 `FAILED`
- 该 phase 的所有输出视为不完整，从头重新执行
- 不尝试恢复部分完成的输出

### 2.3 Run Workspace 与产物溯源

每次 W_compute 执行创建规范目录结构:

```
artifacts/runs/<run_id>/w_compute/            ← ${WORKSPACE}
├── manifest.json              # artifact contract SSOT (run_card v2 快照 + scripts sha256 + git/env)
├── summary.json               # artifact contract SSOT (definitions/stats)
├── analysis.json              # artifact contract SSOT (headline numbers + acceptance + diffs)
├── report.md                  # deterministic view (derived from JSON SSOT)
├── phase_state.json           # 所有 phase 的当前状态 + 时间戳
├── phases/
│   ├── setup/
│   │   ├── stdout.log
│   │   ├── stderr.log
│   │   ├── exit_code
│   │   ├── outputs_manifest.json  # {path, sha256, size, timestamp}
│   │   └── results/
│   │       └── inputs.json        # ← phase 输出的副本
│   ├── main/
│   │   ├── stdout.log
│   │   ├── stderr.log
│   │   ├── exit_code
│   │   ├── outputs_manifest.json
│   │   └── results/
│   │       ├── results.json
│   │       └── diagnostics.json
│   └── validate/
│       └── ...
├── headline_numbers.json      # 提取的关键数值
└── acceptance_report.json     # 验收检查结果 (analysis.json 中也应有机器可追溯指针)
```

**manifest.json 内容**:

```json
{
  "schema_version": 1,
  "created_at": "2026-02-07T12:00:00Z",
  "command": "hepar run --run-id M1-my-calc-r1 --workflow-id W_compute --run-card ... --trust-project",
  "cwd": "hep-autoresearch/",
  "params": {
    "run_id": "M1-my-calc-r1",
    "workflow_id": "W_compute",
    "run_card_path": "examples/schrodinger_ho/run_cards/ho_groundstate.json",
    "run_card_sha256": "abc123...",
    "parameters": {"n_points": 100, "energy_mev": 500.0}
  },
  "versions": {
    "git_sha": "2d2b3c0...",
    "python_version": "3.12.1",
    "hepar_version": "0.0.1",
    "timestamp_utc": "2026-02-07T12:00:00Z"
  },
  "outputs": [
    "phase_state.json",
    "phases/",
    "headline_numbers.json",
    "acceptance_report.json",
    "analysis.json"
  ],
  "scripts": [
    {"path": "scripts/prepare_inputs.py", "sha256": "def456..."},
    {"path": "scripts/run_nlo.py", "sha256": "789abc..."}
  ]
}
```

### 2.4 W_compute 在 orchestrator 中的实现

```python
# 新增: toolkit/w_compute.py (通用计算工作流引擎)

@dataclass(frozen=True)
class ComputeInputs:
    tag: str
    run_card_path: str
    parameters: dict[str, Any] | None = None
    project_dir: Path | None = None
    resume: bool = False
    trust_project: bool = False

def compute_run(inputs: ComputeInputs, *, repo_root: Path) -> dict:
    """执行通用计算工作流。"""
    run_card = load_and_validate_run_card(repo_root / inputs.run_card_path)

    # Run identity: CLI --run-id overrides run_card.run_id
    run_id = inputs.tag or run_card.get("run_id")
    if not run_id:
        raise ValueError("run_id must be provided via --run-id or in run_card")

    # Schema 严格模式: 未知字段 → ERROR
    validate_schema_strict(run_card)

    # 安全检查
    if not inputs.trust_project:
        if not sys.stdin.isatty():
            raise RuntimeError(
                "Non-interactive mode requires --trust-project flag. Aborting."
            )
        prompt_trust_confirmation(run_card)

    # 路径约束检查
    # Standard layout: <project_dir>/run_cards/<card>.json
    # --project-dir CLI flag overrides auto-detection
    project_dir = inputs.project_dir or (repo_root / inputs.run_card_path).parent.parent
    if not (project_dir / "project.json").exists():
        raise FileNotFoundError(
            f"No project.json found in {project_dir}. "
            "Use --project-dir to specify project root."
        )
    verify_path_containment(run_card, project_dir)

    # 初始化 run workspace
    workspace = init_run_workspace(run_id, run_card, repo_root)
    write_manifest_json(workspace, run_card, repo_root)

    # 参数解析与验证
    params = resolve_parameters(run_card, inputs.parameters)

    phases = topo_sort(run_card["phases"])
    on_failure = run_card.get("on_failure", "fail-fast")

    for phase in phases:
        phase_id = phase["phase_id"]
        state = load_phase_state(workspace, phase_id)

        # Resume: 跳过已完成且输出完整的 phase
        if inputs.resume and state == "SUCCEEDED":
            if verify_outputs_integrity(workspace, phase):
                continue
            else:
                state = "FAILED"  # 输出不完整，视为 FAILED

        # Resume: crash recovery — RUNNING 视为 FAILED
        if inputs.resume and state == "RUNNING":
            state = "FAILED"

        # 检查是否被上游 SKIPPED
        if should_skip(phase, workspace):
            record_phase_skipped(workspace, phase_id)
            continue

        # 检查门禁
        if phase.get("gates"):
            request_approval(phase["gates"])

        # 验证 inputs 存在
        verify_phase_inputs(phase, workspace, project_dir)

        # 执行 (含重试)
        update_phase_state(workspace, phase_id, "RUNNING")
        for attempt in range(1 + phase.get("retries", 0)):
            result = execute_phase(phase, params, workspace, project_dir)
            if result.success:
                copy_outputs_to_workspace(phase, workspace, project_dir)
                record_phase_success(workspace, phase, result)
                break
        else:
            record_phase_failure(workspace, phase_id, result)
            if on_failure == "fail-fast":
                return {"errors": [...], "workspace": workspace}
            # on_failure == "continue": 继续执行无依赖关系的 phase

    # 提取 headline numbers
    extract_headline_numbers(workspace, run_card)

    # 运行 acceptance checks
    run_acceptance_checks(workspace, run_card)

    return {"errors": [], "workspace": workspace}
```

### 2.5 Schema 治理 (v3 修订版)

**严格模式**:
- `schema_version` 为整数。引擎仅支持当前版本 (`2`)。不存在次版本号。
- run_card 中出现 schema 未定义的字段 → **ERROR** (立即终止，不是 warning)
- 若未来需要 schema 迁移，届时再构建 `run-card migrate` 工具。当前不预建迁移基础设施。

**CLI 工具**:
```bash
hepar run-card validate path/to/card.json   # 校验 schema + 路径 + 参数类型
hepar run-card render path/to/card.json     # 可视化 DAG + 参数 + 门禁
```

### 2.6 对现有工作流的影响

| 现有工作流 | 处理方式 |
|-----------|---------|
| W1_ingest | **保留**。文献采集是通用平台能力 |
| W2_reproduce | **保留**（toy regression anchor）。用于数值/依赖栈的确定性 sanity check |
| W2_v1 | **删除** → W_compute + 多阶段 run_card 替代 |
| W3_revision | **保留**。LaTeX 审稿修改是通用平台能力 |
| W3_literature_survey_polish | **保留**。文献综述是通用平台能力 |
| W4_potential_matrix | **删除** → W_compute + 验证 run_card 替代 |

**直接切换** (非渐进迁移): 构建 W_compute → 移植 examples → 删除旧代码 → 更新测试。一个 milestone 内完成。

退役后的最终工作流集合:

```
W1_ingest                  # 文献采集 (通用)
W3_revision                # 审稿修改 (通用)
W3_literature_survey_polish # 文献综述 (通用)
W2_reproduce               # toy 数值回归锚点 (保留)
W_compute                  # 通用计算 (新增, 替代 W2_v1/W4)
ADAPTER_*                  # 注册表适配器 (已有, 保留)
```

### 2.7 第二验证项目: Schrodinger 方程验证 (schrodinger_ho)

**目的**: 构建一个与任何领域代码/旧 workflow 无关的验证项目，覆盖 run_card v2 + W_compute 的关键语义（params 展开、phase DAG、outputs 复制、headline_numbers、acceptance、fail-fast）。

**物理背景（简化版）**:

- 1D 谐振子基态满足 ODE: $\psi''(x) = (\omega^2 x^2 - 2E)\, \psi(x)$，其中 $E_0=\omega/2$。
- 取初值 $\psi(0)=1$，$\psi'(0)=0$（不归一化），解析解 $\psi_{\rm analytic}(x)=\exp(-\omega x^2/2)$。

**项目位置**:

- `examples/schrodinger_ho/`
  - run-card: `run_cards/ho_groundstate.json`
  - scripts: `scripts/derive_params.py`, `scripts/solve_numerics.py`, `scripts/validate.py`

**运行**:

```bash
hepar run-card validate --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
hepar run --run-id M65-a5-schrodinger-ho-r2 --workflow-id W_compute --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json --trust-project
```

**Eval cases**:

- `E31-schrodinger-ho-params`
- `E32-schrodinger-ho-wavefunction`

**验收**:

- RMSE / max_abs_diff <= 1e-8（由 run_card acceptance 声明）
- eval runner 通过:

```bash
python3 scripts/run_evals.py --case-id E31-schrodinger-ho-params --case-id E32-schrodinger-ho-wavefunction --tag M65-a5-evals-r1
```

### 2.8 研究场景覆盖

| 场景 | run_card 配置方式 |
|------|-----------------|
| **论文复现** | phases: [prepare, compute, compare_with_paper] |
| **参数扫描** | phases: [generate_grid, sequential_compute, aggregate, plot] |
| **新计算** | phases: [setup, main_calc, validate_limits, diagnostics] |
| **方法对比** | phases: [method_a, method_b, compare_methods, report] |
| **敏感度分析** | phases: [baseline, vary_param_1, vary_param_2, sensitivity_report] |
| **解析验证** | phases: [extract_from_tex, independent_derivation, compare] |

注: "参数扫描"中 `sequential_compute` 在 v2 中为串行。并行扫描需在用户脚本内部实现，或等待未来版本支持 `fanout` phase type。

---

## 方案三: 重心转向研究能力

### 3.1 问题

当前代码量分布:

```
编排/状态/门禁/回归/评测/文档:   ~80%
实际通用研究能力:                ~20% (W1 ingest + W3 revision)
```

治理层已经足够成熟。继续在治理层投入的边际收益很低。

### 3.2 能力缺口分析 (v3.2 修订)

> v3.2 修订: 基于对 70+ 个 MCP 工具和 6 个 skills 的深入调研，重新评估各环节能力。

```
文献调研 ──► 提出问题 ──► 设计方法 ──► 执行计算 ──► 分析结果
    │                                                   │
    │       ◄──── 与已有工作对比 ◄──── 发现/讨论 ◄──────┘
    │                                       │
    └──────────────────► 写作 ◄─────────────┘
```

| 环节 | 已有能力 | 差距 | v3.2 策略 |
|------|---------|------|-----------|
| 文献调研 | W1_ingest + KB + MCP INSPIRE (8 工具) + Zotero (5 工具) | **充裕**: `inspire_search`, `inspire_literature`, `inspire_field_survey`, `inspire_deep_research` 已覆盖各层次检索 | 编排已有 MCP 工具 |
| 提出问题 | MCP `inspire_critical_research`, `inspire_topic_analysis` | **中**: 有工具基础但缺编排 | P4: 编排 MCP 工具 + 引导推理 |
| 设计方法 | methodology_traces (手动) + hep-calc (符号推导) | **中**: hep-calc 能力强但未与 W_compute 集成 | P4: hep-calc → W_compute phase 桥接 |
| 执行计算 | W2 (硬编码一个示例) | **大** → W_compute 解决 | Phase A: W_compute 引擎 |
| 分析结果 | headline numbers (手动配置) + PDG 工具 (6 个) | **小** → run_card headline_numbers + PDG 数据查询 | Phase A: run_card 自动提取 + PDG 对比 |
| 对比已有工作 | MCP `inspire_network_analysis`, `inspire_discover_papers` | **小**: 工具已有但未编排 | P4: 编排 MCP 工具 |
| 写作 | W3_revision + lit_survey_polish + research-writer skill + MCP 写作流水线 (20+ 工具) | **充裕**: evidence-first 完整流程已实现 | 直接复用，不新建 |
| 审稿 | referee-review skill (离线、确定性、JSON 输出) + review-swarm (双模型) | **充裕**: 结构化审稿 + 双模型收敛 | 直接复用 |

### 3.3 建议投入优先级 (v3.2 修订)

> v3.2 修订: 从"从头构建"转为"编排已有 + 补缺口"。

**P1: W_compute 引擎 (含执行基底)** — 不变

不仅是 DAG 执行器，必须包含 "boring but essential" 基础设施:
- Phase 状态机 + 持久化 (含完整 DAG 失败语义)
- Run workspace + 产物溯源
- Resume 语义 (checksum 校验 + crash recovery)
- 安全信任模型 (交互/非交互双模式)
- Schema 严格验证
- 路径语义实现 (containment enforcement)

**P2: 直接切换** — 不变

一个 milestone 内完成全部切换:
- 构建 W_compute → 固化 `examples/schrodinger_ho` 回归锚点 → 删除 legacy workflow → 更新测试
- 无 legacy shim，无双路径

**P3: 并行构建第二个验证项目** — 不变

- `examples/schrodinger_ho/` 从零构建
- **核心验收**: 全过程不修改 `src/` 下任何文件

**P4: Agent 辅助研究能力 (v3.2 大幅修订)**

> v3.2 关键变更: 从"以 KB 为基础从头构建"改为"编排已有 MCP 工具 + Skills"。

**P4a: 文献缺口发现与问题提出** (编排 MCP INSPIRE 工具)

不应从头构建文献分析能力。应编排已有 MCP 工具链:

```
inspire_field_survey(topic)                     → 领域全景
  ↓
inspire_topic_analysis(topic)                   → 研究热点 + 趋势
  ↓
inspire_critical_research(topic)                → 关键缺口 + 矛盾
  ↓
inspire_network_analysis(paper_ids)             → 引用网络 + 关键节点
  ↓
Agent 推理 (基于以上结构化输出)                 → 候选研究问题
```

**P4b: 方法设计与计算规划** (hep-calc + PDG + W_compute 桥接)

```
pdg_find_particle / pdg_get_property            → 粒子参数 (质量、宽度等)
  ↓
hep-calc (Mathematica/Julia 符号推导)           → 解析公式、数值代码
  ↓
Agent 生成 W_compute run_card                   → 声明式计算 DAG
  ↓
research-team 代码写作规范                      → 脚本质量保证
```

**P4c: 计算结果 → 论文** (W_compute → MCP 写作工具箱 → research-writer 验证)

> v3.5 修订: 基于 MCP 写作工具深度调研。MCP 写作工具是**可组合的工具箱**，不是固定流水线。工具**不生成内容**——它们构建 Prompt Packet 返回给 agent，由 agent 调用 LLM 生成内容后提交。agent 可自由选择调用顺序、跳过步骤、使用 `hep_render_latex` 直接提交。

MCP 写作工具的实际工作模式:

```
Agent 调用 create_section_write_packet(section_id)
    → MCP 返回 { prompt_packet, next_actions[] }    (建议，非强制)
    → Agent 自行调用 LLM 生成内容                    (100% agent 控制)
    → Agent 调用 submit_section_candidates(content)
    → MCP 验证 + 持久化
```

Agent 可选择的写作路径:

```
路径 A (完整流程):
  token_budget_plan → outline_candidates → outline_judge
    → section_write_packet → section_candidates → section_judge
    → integrate_sections → research-writer consume_manifest

路径 B (简化流程):
  Agent 直接生成各节内容 → hep_render_latex(SectionDraft)
    → integrate_sections → research-writer consume_manifest

路径 C (最小流程):
  Agent 生成完整论文 → research-writer consume_manifest (仅验证+编译)
```

唯一硬约束: `hep_render_latex` 中的 **citation verifier** (每个 `\cite{}` 必须在 `allowed_citations` 列表中)。该列表接受 INSPIRE recid、`inspire:recid` 和**任意 BibTeX key** (如 `"Weinberg:1990rz"`, `"Goldberger:1964"`)；不在 INSPIRE 上的老论文、教科书、跨领域文献可通过 `manual_add` 或 bibliography 映射加入。若不提供 allowlist 且 claims_table 为空，验证器自动禁用。这是学术诚信保证，非流程限制。

**跨领域文献 citation 流通 (v3.5 补充)**:

MCP evidence 系统正确存储 `arxiv:` 前缀的论文 ID，但 citation verifier 仅自动展开 `inspire:` 格式。通过 arXiv 搜索发现的跨领域论文 (数学、CS、老论文等) 需要 agent 在写作前调用 `hep_run_build_citation_mapping` 将所有发现的 paper IDs (含 `arxiv:*`) 映射为 BibTeX citekey，纳入 `allowed_citations`。

模式 A 下的完整流通链:

```
文献发现 (research-team arXiv 搜索 / INSPIRE / Zotero)
    → 收集所有 paper IDs (inspire:*, arxiv:*, 手动 BibTeX key)
    → hep_run_build_citation_mapping (动态发现)
    → allowed_citations.json (全来源合并)
    → hep_render_latex (citation verifier 放行所有已发现论文)
```

此流通链由 agent 在模式 A 下自主编排。agent 可根据论文来源自行判断是否需要 citation mapping 步骤——若所有引用均来自 INSPIRE，可跳过映射直接使用 recid。

Quality policy (`standard` / `publication`) 由 agent 选择，各 gate (LLM evaluator, LaTeX compile) 的 `required` 字段均可配置。

**P4d: 审稿收敛** (referee-review + review-swarm)

```
论文草稿                                        → referee-review skill → JSON 审稿报告
  ↓
review-swarm (Claude + Gemini 独立审稿)          → 双模型审稿报告
  ↓
Agent 汇总 + 修订                               → 下一轮迭代
```

**P4 验收标准 (v3.3 收窄)**:

**范围限定**: P4 仅涉及公开资料/文献驱动的研究。不要求访问私有实验数据 (如 LHCb raw data)。所有计算脚本必须可在单机环境复现。

**可度量验收 (替代"双模型 APPROVE")**:

| 子阶段 | 验收指标 | 阈值 |
|--------|---------|------|
| P4a 文献缺口发现 | 结构化报告包含: 领域综述 + 引用网络图 + ≥3 个候选研究问题 | 报告格式通过 JSON Schema 验证 |
| P4b run_card 生成 | 生成的 run_card 通过 `hepar run-card validate`; 脚本可在 `--trust-project` 下执行 | 0 schema error; 所有 phase exit code 0 |
| P4c 计算→论文 | W_compute 产物成功桥接到 MCP evidence (Outcome Gate 通过); research-writer consume_manifest 验证通过 | bridge_report.json status=success; 草稿覆盖所有 headline numbers; LaTeX 编译通过 |
| P4d 审稿收敛 | referee-review 产出结构化审稿; agent 能基于审稿修订 | 审稿 JSON 通过 schema; ≤3 轮修订后无 blocker |

**失败回退**: P4 子阶段失败时:
- P4a/P4b 失败 → 记录 methodology trace (查过什么、为何失败) → 人工介入
- P4c/P4d 失败 → 保留 W_compute 计算结果 (已持久化) → 人工完成写作/审稿
- 最大迭代: 每个子阶段 ≤3 轮自动迭代，超出后升级为人工任务

**示例主题修正**: 使用"scattering lengths of nucleon-nucleon systems from chiral EFT"(纯理论计算，公开方法，无需私有数据) 替代原 LHCb 示例。

### 3.4 治理层冻结建议

| 模块 | 当前状态 | 建议 |
|------|---------|------|
| A1-A5 门禁分类 | 5 类已定义 | 冻结 |
| 审批策略模式 | safe/interactive/full_auto | 冻结 |
| 超时语义 | block/reject/escalate | 冻结 |
| 宪法保护 | 延迟窗口 + 人工复核 | 冻结 |
| Reviewer 信息隔离 | packet_only + escalation | 冻结 |
| 文档数量 | 48+ 文件 | 冻结 |

把精力集中在**让平台能做更多事**，而不是让平台对做同样少的事控制得更精细。

---

## 实施路线图 (v3.2 修订版)

> v3 变更: 合并原 Phase A + Phase B 为单一 Phase A (构建 + 切换)。删除 legacy shim 阶段。
> v3.2 变更: Phase B 扩展为含工具生态集成; 新增 Phase C 研究能力路线图。

### 阶段门禁: 双模型审核收敛

每个实施阶段 (A1, A2, A3, ...) 的交付物在进入下一阶段前，必须通过以下流程:

1. **独立双模型审核**: 将阶段交付物同时提交 **Claude Opus** (via `claude` CLI / Codex) 和 **Gemini gemini-3-pro-preview** 进行独立审核
2. **迭代收敛**: 若任一模型给出 REVISE，修改后重新提交审核，直到双方均给出 APPROVE
3. **进入下一阶段**: 双方 APPROVE 后方可开始下一阶段的实施

```
阶段 N 实施 → 交付物 → 双模型审核 ─┬─ 双方 APPROVE → 阶段 N+1
                                    └─ 任一 REVISE → 修改 → 重新审核
```

此流程与方案本身的审稿收敛流程 (R1→R2→R3) 一致，确保每一步实施质量。

### 分支/方案演化 (研究流程内化，v3.6 补充)

实施过程中出现新 idea（可能需要小规模调研/文献查找；等价于在分支树上生成新分支）属于正常研究流程。为避免“隐式改动”导致不可审计漂移，统一按以下机制处理:

1. **显式记录**: 在 Plan SSOT 中新增 `plan.branching` 的 `branch_decision/branch_candidate`，并写一条 methodology trace (query→shortlist→decision)。
2. **双审核评估**: 组织 Opus + Gemini-3-pro-preview 对比“继续当前路径”与“切换分支”的收益/风险/迁移成本，必要时给出最小可行试验 (MVP) 的验证建议。
3. **人类审议大改**: 若属于**大改**（改变目标/验收/关键接口/阶段顺序），必须先提交给人类审议通过，再进入实现；否则在 Plan 中切换 active branch 并继续阶段门禁流程。

分层内化（对应 MCP / Skills / Agent 三层架构）:
- **MCP 层**: 承载 discovery/证据类原子工具（INSPIRE/arXiv/Zotero/evidence index 等），为新 idea 提供“可追溯输入”。
- **Skills 层**: 承载可复用的 triage/对比/审稿编排（例如用 [idea_brief](../../templates/idea_brief.md) 与 [idea triage prompt](../../templates/prompt_idea_triage.md) 生成候选分支；用 review-swarm 做双模型对比评估）。
- **Agent 层**: 维护 Plan SSOT 的 branching 状态（`plan.branching`），驱动阶段门禁与执行；所有分支切换必须可在 artifacts + traces 中复盘。

### Phase A: 构建 + 切换

**A1: 定义 run_card v2 schema** ✅ DONE (2026-02-07)

- 输出: `specs/run_card_v2.schema.json`
- 内容: phases (含 inputs/outputs/retries/depends_on)、parameters (类型化)、DAG 依赖、headline number 提取、内联验收、on_failure
- Schema 严格模式: 整数 `schema_version`，未知字段 ERROR
- 路径语义文档: `${PROJECT_DIR}`, `${WORKSPACE}`, `${REPO_ROOT}` 全部定义
- 非目标声明: 文档化 v2 不做的事 (并行、分布式、条件分支、缓存、schema 版本迁移)
- 验收: schema 通过 JSON Schema validation; `examples/schrodinger_ho/run_cards/ho_groundstate.json` 可用 v2 描述
- **双模型审核**:
  - GPT-5.2 xhigh: **APPROVE with modifications** (4 项 non-blocking suggestions — 全部已实现)
    1. 参数 default 类型约束 (if/then) ✅
    2. RFC 6901 pointer pattern 加严 (~0/~1 escaping) ✅
    3. 参数名 propertyNames 约束 ✅
    4. minLength/uniqueItems 健壮性 ✅
- Gemini gemini-3-pro-preview: **APPROVE**
  - **收敛**: 双方 APPROVE，4 项 modification 已实现并通过测试
- **测试**: 29/29 通过 (3 正向 + 26 负向)
  - 复现命令: `python3 -m pip install jsonschema` 后运行 `python3 specs/tests/validate_schema.py`

**A2: 实现 W_compute 工作流引擎** ✅ DONE (2026-02-08)

- 输出: `src/hep_autoresearch/toolkit/w_compute.py` + `run_card_schema.py`
- 核心功能:
  - 读取 run_card v2 → Schema 严格验证 (未知字段 ERROR)
  - 安全检查 (TTY 检测 → 交互提示 / 非交互要求 --trust-project)
  - 路径约束检查 (containment enforcement)
  - DAG 拓扑排序
  - Phase 状态机 (NOT_STARTED → PENDING → RUNNING → SUCCEEDED/FAILED/SKIPPED)
  - Phase gate 语义: 读取 `phase.gates`，未满足则进入 `BLOCKED_BY_GATE` 并触发对应 A1-A5 审批；审批后可 `--resume` 继续
  - 完整 DAG 失败语义 (fail-fast / continue + SKIPPED 传播)
  - Run workspace 初始化 + 输出复制语义
  - 逐 phase 执行 (复用 ShellAdapter) + 重试
  - 输出校验 (inputs/outputs) + 产物溯源 (sha256)
  - 提取 headline numbers + 内联验收
  - Resume 支持 (含 crash recovery: RUNNING → FAILED)
  - artifact contract 对齐: 写入 `artifacts/runs/<run_id>/w_compute/{manifest,summary,analysis}.json` + `report.md`，其余 phase_state/headline/acceptance 为辅助产物
- 验收: 能用一个最小 run_card (单 phase, `echo ok`) 跑通完整生命周期，包括 resume 和 crash recovery
  - **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M58-a2-wcompute-r3`)
  - **测试**: `python3 -m unittest discover -s tests -p "test_*.py"` (包含最小 run_card、crash recovery、cycle detection、on_failure=continue)

**A3: CLI 集成 + run-card validate** ✅ DONE (2026-02-08)

- 输出: `src/hep_autoresearch/orchestrator_cli.py` + `tests/test_orchestrator_w_compute_cli.py`
- 在 `hepar run` 中注册 `W_compute`（adapter workflow）
- 添加 `--run-card`, `--trust-project`, `--resume`, `--param key=value` CLI 参数
- 添加 `hepar run-card validate` 子命令（严格校验 run_card v2: schema + 语义 + DAG）
- 验收: `hepar run --run-id test --workflow-id W_compute --run-card card.json --trust-project` 可执行；`hepar run-card validate --run-card card.json` 可用
- **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M60-a3-cli-r3`)
- **测试**: `python3 -m unittest discover -s tests -p "test_*.py"`

说明: 本阶段以“接入新路径 + 严格校验 + 可测试”为主；对 orchestrator_cli 的完整拆分、以及 W2_v1/W4 legacy workflow 的删除/切换，统一留到 A6（避免过早引入大范围 churn）。

**A4: baryon_baryon_su6 声明式项目（临时压力测试）** ✅ DONE (2026-02-08) → RETIRED (2026-02-08)

- 说明: 该用例用于验证 run_card v2 + W_compute 能承载较复杂的多阶段 pipeline；已按“预发布可不兼容 + 不混入发布主代码”原则从 main 删除（仍可在 git history / artifacts 中追溯）。
- 证据: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M63-a4-baryon-project-r2`)。

**A5 (与 A2-A4 并行): 构建 Schrodinger 方程验证项目** ✅ DONE (2026-02-08)

- 输出: `examples/schrodinger_ho/`
  - `run_cards/ho_groundstate.json`（3 phases: `derive_params` → `solve_numerics` → `validate`）
  - `scripts/derive_params.py`, `scripts/solve_numerics.py`, `scripts/validate.py`（确定性 RK4；不依赖 baryon 代码）
- Eval cases:
  - `E31-schrodinger-ho-params`（检查 `E0=omega/2`）
  - `E32-schrodinger-ho-wavefunction`（检查 RMSE / max_abs_diff / 输出形状）
- 设计目的: 在不触碰 `src/` 的前提下，覆盖 run_card v2 的关键语义（params 展开、phases/<id>/ 输入路径解析、headline_numbers、acceptance、fail-fast）
- **核心验收**:
  - 全过程不修改 `src/` 下任何文件 ✅
  - `hepar run --run-id M65-a5-schrodinger-ho-r2 --workflow-id W_compute --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json --trust-project` 跑通，且 `artifacts/runs/<run_id>/w_compute/analysis.json` 中 `ok=true`
  - `python3 scripts/run_evals.py --case-id E31-schrodinger-ho-params --case-id E32-schrodinger-ho-wavefunction` 通过
- **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M65-a5-schrodinger-project-r1`)

**A6: 删除旧代码 + 更新回归测试** ✅ DONE (2026-02-08)

- 删除 legacy domain workflow + 测试用例:
  - 删除 `src/hep_autoresearch/toolkit/w2v1_{lec_solve,poles,scattering_lengths}.py`
  - 删除 `src/hep_autoresearch/toolkit/w4_potential_matrix.py`
  - 删除 `scripts/run_w2v1_*.py`, `scripts/run_w4_potential_matrix.py`
  - 删除 `examples/baryon_baryon_su6/`（临时测试用例）
  - 删除 legacy eval cases（E7-E10, E12）
- 更新回归:
  - `orchestrator_regression.py`: 用 `wcompute` scenario 覆盖 W_compute + 默认 A3 门禁路径（基于 `examples/schrodinger_ho`）
- 验收:
  - `rg -n \"w2v1|W2_v1|w4_potential_matrix|W4_potential_matrix\" src/hep_autoresearch | wc -l` 返回 0
  - `python3 -m unittest discover -s tests -p \"test_*.py\"` 通过
  - `python3 scripts/run_evals.py --tag M67-a6-evals-r1` 全部通过
  - `python3 scripts/run_orchestrator_regression.py --tag M67-a6-orchreg-wcompute-r1 --scenarios wcompute` 通过
  - schrodinger_ho: E31/E32 通过

**Phase A 整体验收**: W_compute/run_card v2 全链路可用；平台代码无 legacy domain workflow；eval suite + orchestrator_regression(wcompute) 均通过；schrodinger_ho 通过。

### Phase B: 文档 + 稳定化 + 工具生态集成 (v3.2 修订)

**B1: 编写 W_compute 用户文档** ✅ DONE (2026-02-08)

- 输出:
  - `docs/W_COMPUTE.md` + `docs/W_COMPUTE.zh.md`
  - `docs/EXAMPLES.md` + `docs/EXAMPLES.zh.md`
  - `docs/INDEX.md` 增加 W_compute / examples 入口
- 说明:
  - run_card v2 的 schema/实现仍以 `specs/run_card_v2.schema.json` 与 `src/hep_autoresearch/toolkit/run_card_schema.py` 为 SSOT，文档只提供“用户视角入口 + 最小命令集”。
  - `docs/BEGINNER_TUTORIAL.{md,zh.md}` 已补充指向 `docs/W_COMPUTE*` 与 `docs/EXAMPLES*` 的入口链接。
- **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M69-b1-docs-r2`)

**B2: CLI 工具完善** ✅ DONE (2026-02-08)

- `hepar run-card validate`（已具备）:
  - schema 严格校验 + 参数覆盖（`--param`）+ `--project-dir` 推断/覆盖
  - phase DAG 环检测（与 W_compute 同语义）
- `hepar run-card render`（新增）:
  - 输出 phase DAG 可视化：`--format mermaid|dot|text`，可 `--out <path>` 写文件
- 测试:
  - `tests/test_orchestrator_w_compute_cli.py::test_run_card_render_mermaid` 覆盖 render 基本行为
- **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M70-b2-run-card-render-r1`)

**B3: 阶段门禁标准化 (复用 review-swarm)** ✅ DONE (2026-02-08)

- 输出: `scripts/run_dual_review.py`（Opus + Gemini gemini-3-pro-preview clean-room）
  - 复用 review-swarm 的 `run_dual_task.py`
  - 输出合同: `VERDICT:` + `## Blockers/## Non-blocking/## Real-research fit/## Robustness & safety/## Specific patch suggestions`
  - 归档: `artifacts/runs/<TAG>/dual_review/{packet.md,analysis.json,manifest.json,summary.json,...}`
- 验收: 任意阶段交付物变更前后均可运行 `python3 scripts/run_dual_review.py --tag <TAG> --note "<what changed + why>"`，直到 Opus+Gemini 同时 READY 方可进入下一阶段

**B4: W_compute → MCP 桥接 (v3.5 重新设计: 模式 A + Outcome Gate)** ✅ DONE (2026-02-09)

> v3.5 重新设计: 从硬编码适配层 (模式 B) 转为“最小基线契约 + 结果验证”(Outcome Gate)。当前实现以 `hep-research-mcp` 为基准：对少量 project/run 管理工具名有**基线依赖**（并由 `hepar doctor` 预检），但桥接质量保证以**结果可读回**为准（Outcome Gate），而非过程步骤。

桥接流程:

```
W_compute 完成 (analysis.json: results.status="completed")
    ↓
`hepar doctor` 预检 MCP server + required tools
    ↓
`hepar bridge` 读取 workspace 产物并注册到 MCP
    (创建 run → stage headline numbers / acceptance / manifest)
    ↓
Outcome Gate 验证桥接结果
    ↓
生成 `bridge_report.json` + `bridge_state.json`
```

**Outcome Gate (结果契约)**:

桥接完成后，验证器检查以下必要条件 (不关心 agent 用了哪些 MCP 工具):

| 验证项 | 条件 | 级别 |
|--------|------|------|
| MCP run 已注册 | `run_id` 在 MCP 中可查询 | REQUIRED |
| headline numbers 已暂存 | MCP run 中包含 headline_numbers artifact | REQUIRED |
| acceptance report 已暂存 | MCP run 中包含 acceptance artifact | REQUIRED |
| run manifest 已暂存 | MCP run 中包含 manifest artifact | REQUIRED |
| phase JSON 结果已暂存 | MCP run 中包含各 phase 的结果 artifact | OPTIONAL (warning) |
| evidence index 已构建 | MCP run 的 evidence 可被写作工具查询 | OPTIONAL (warning) |

**失败策略**:
- REQUIRED 项未通过 → `bridge_report.json` 记录 `"bridge_status": "partial"`；命令退出码为非零
- 发生异常 → `bridge_report.json` 记录 `"bridge_status": "failed"` 且保留 `agent_actions`（已执行工具调用的审计轨迹）
- `bridge_state.json` 在桥接开始即写入（`status="in_progress"`），并在关键步骤更新；用于 crash/中断的审计追溯
- W_compute 计算结果不受影响 (已持久化在 workspace 中)
- 重试策略: 直接重新运行 `hepar bridge ...`（当前不引入 `--retry/--resume` 的额外状态机复杂度）

**bridge_report.json** (桥接审计记录):

```json
{
  "bridge_status": "success|partial|failed",
  "mcp_run_id": "...",
  "outcome_gate": {
    "required_passed": ["run_registered", "headline_numbers", "acceptance", "manifest"],
    "required_failed": [],
    "optional_passed": ["phase_derive_params", "phase_solve_numerics"],
    "optional_warned": ["evidence_index"]
  },
  "agent_actions": [
    {"tool": "(dynamically discovered)", "status": "ok", "timestamp": "..."}
  ],
  "retry_count": 0,
  "timestamp_utc": "..."
}
```

**与模式 B 的对比**:

| 维度 | v3.3-v3.4 模式 B | v3.5 模式 A + Outcome Gate |
|------|-----------------|--------------------------|
| MCP 工具名硬编码 | 是 (全模块依赖) | 是 (最小基线工具集；由 `hepar doctor` 预检) |
| MCP 参数结构硬编码 | 是 (全模块依赖) | 是 (最小基线参数结构；桥接质量由 Outcome Gate 读回验证) |
| MCP 升级时是否 break | 改工具名/参数 → break | 改基线工具名/参数仍会 break；但实现升级/新增工具不影响桥接（只要结果可读回） |
| 质量保证 | 过程正确性 (调了正确的工具) | 结果正确性 (产物在 MCP 中可查) |
| Agent 发现新工具 | 不能 | 当前 bridge v0 不自动利用；后续可扩展为可选动态发现 |
| 唯一硬编码 | `compute_to_evidence.py` 全模块 | 少量基线工具名 + payload schema；质量保证由 Outcome Gate 负责 |

**交付物**:
- CLI:
  - `hepar bridge --run-id <RUN_ID>`
- 代码:
  - `src/hep_autoresearch/toolkit/mcp_stdio_client.py`（stdlib-only MCP stdio client）
  - `src/hep_autoresearch/toolkit/mcp_config.py`（.mcp.json loader + env allowlist）
- 产物:
  - 成功/部分成功: `artifacts/runs/<RUN_ID>/bridge_mcp/{bridge_report.json,bridge_state.json,manifest.json,summary.json,analysis.json,report.md}`
  - 失败(异常): 至少写入 `bridge_state.json`，并尽力写入 `bridge_report.json`（含 `error` 与 `agent_actions`）
- **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M71-b4b6-mcp-bridge-doctor-r9`)

**验收**:
- `python3 -m unittest discover -s tests -p "test_*.py"` 通过（含 stub MCP 的 doctor+bridge 集成测试）
- 对真实 MCP server（hep-research-mcp）:
  - `hepar doctor` 返回 0
  - 完成一次 W_compute 后执行 `hepar bridge --run-id <RUN_ID>`，并在 `bridge_report.json` 中看到 `"bridge_status": "success"` 且 `required_failed=[]`

**B5: Skill 版本锁定 (v3.4 新增)**

- 平台依赖 6 个 skills + 70+ 个 MCP 工具，可复现性要求版本可追踪
- 输出: `skills.lock.json` (锁定 skill 名称 + git SHA/版本 + 验证 hash)
- `hepar run` 启动时检查 lock 文件，若 skill 版本不匹配发出 warning
- 不强制锁定 (避免阻塞开发)，但在 `manifest.json` 中记录实际使用的 skill 版本
- 验收: `manifest.json` 包含 `skill_versions` 字段

**B6: 生态健康检查 (v3.4 新增)** ✅ DONE (2026-02-09)

- 输出:
  - `hepar smoke-test`：仅做 import 健康检查（无 MCP server 交互）
  - `hepar doctor`：MCP server 连通性 + required tools 可用性 + `hep_health` 基础自检
- 当前实现的检查项:
  | 检查 | 方法 | 级别 |
  |------|------|------|
  | MCP server 连通性 | `initialize` + `hep_health` | ERROR (必须) |
  | required MCP tools 存在 | `tools/list` 验证 | ERROR (必须) |
- TODO (后续增强, 非阻塞):
  - Skills 可用性检查（本地 skill 文件存在 / 版本）
  - hep-calc 依赖探测（Mathematica/Julia）
  - Zotero 连接探测（`zotero_local`）
- 验收:
  - `hepar smoke-test` 返回 0
  - `hepar doctor` 在 ERROR 级别失败时返回非零 exit code
  - **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M71-b4b6-mcp-bridge-doctor-r9`)

### Phase C: Agent 研究能力 (v3.2 新增, 对应 P4)

> v3.2 新增。对应 §3.3 中的 P4a-P4d。基于已有 MCP 工具和 Skills 编排，而非从头构建。

**C1: 文献缺口发现 (P4a)** ✅ DONE (2026-02-09)

- 实现 (MVP, 确定性, 无 LLM 调用):
  - CLI: `hepar literature-gap`
  - 编排 MCP INSPIRE 工具链: `inspire_field_survey` → `inspire_topic_analysis` → `inspire_critical_research` → `inspire_network_analysis`
  - 相关性语义 (MVP):
    - seed recids 由 `inspire_field_survey` 输出中的 `recid` 字段提取（可用 `--seed-recid` 强制覆盖）
    - 新增本地 relevance scoring/排序（确定性，无 LLM）: 基于 title/abstract 的词法重叠 + 引用数/年份/section bonus 等可重复信号，生成可审计的 seed ranking（落盘于 `gap_report.json#/results/relevance`）
  - 输出 (SSOT=JSON):
    - `artifacts/runs/<TAG>/literature_gap/{manifest,summary,analysis}.json`
    - `artifacts/runs/<TAG>/literature_gap/gap_report.json`（4 个 MCP 调用的结构化输出 + action log）
    - `artifacts/runs/<TAG>/literature_gap/report.md`（从 JSON 派生的人工可读报告）
  - 失败语义:
    - rc=0: 全部步骤 OK
    - rc=1: 缺少 seed recids（field_survey 未提取到 recid 且无 `--seed-recid` 覆盖；下游步骤 skip；仍写 artifacts 便于审计）
    - rc=2: 其它非致命错误（仍写 artifacts）
- TODO (后续扩展, 非阻塞):
  - 扩展 relevance scoring（仍保持确定性，无 LLM）: 在 metadata 缺失时可选调用额外 INSPIRE 工具补齐 title/abstract，并加入更稳健的 BM25/TF-IDF 排序与阈值校准
  - 基于 `gap_report.json` 生成候选研究问题（rule-based 或 prompt-packet + LLM；可并入 C4 端到端循环）
- 验收:
  - `python3 -m unittest discover -s tests -p "test_*.py"` 通过（离线 stub MCP server；无真实 INSPIRE 网络调用）
  - 具体验收用例: `tests/test_literature_gap_cli.py`（stub MCP + 产物合同）
- 证据:
  - 代码: commit `5339392`
  - **双模型审核**: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M73-c1-literature-gap-r4`)
  - Workflow spec: `workflows/C1_literature_gap.md`
  - Methodology trace: `knowledge_base/methodology_traces/2026-02-09_c1_literature_gap_orchestration.md`

**C2: 方法设计 + run_card 生成 (P4b)** ✅ PARTIAL DONE (MVP-2, 2026-02-09)

- 目标（最终态）:
  - PDG 数据查询 → hep-calc 符号推导 → W_compute run_card 自动生成（并固化验收与审计产物）
- 已实现（MVP-2, 确定性, 无 LLM 调用）:
  - CLI: `hepar method-design`
  - 模板:
    - `minimal_ok`: 生成最小可运行项目（1 个 phase 写 JSON），用于验证生成器与 W_compute 契约
    - `pdg_snapshot`: 通过 MCP `pdg_get_property` 做设计时快照（写入 `inputs/pdg_snapshot.json`），再生成可运行 run_card v2
    - `pdg_runtime`: 在 W_compute phase 内运行时调用 MCP `pdg_get_property`（输出 `results/pdg_property.json`），用于让 compute run 绑定 PDG locator/版本
    - `spec_v1`: 从 `method_spec` v1 结构化输入 materialize 项目（写入 `inputs/method_spec.json` 快照；并强制 run_card v2 严格校验 + DAG check）
  - 输出（生成可运行插件项目）:
    - `artifacts/runs/<TAG>/method_design/{manifest,summary,analysis}.json`
    - `artifacts/runs/<TAG>/method_design/project/`（`project.json` + `run_cards/main.json` + `scripts/*` + `inputs/*`）
  - 生成时强制校验:
    - run_card v2 严格校验 + phase DAG cycle check
  - 离线回归:
    - stub MCP server 增补 `pdg_get_property`
    - `tests/test_method_design_cli.py` 覆盖生成→validate→W_compute 执行（minimal_ok + pdg_snapshot + pdg_runtime + spec_v1）
  - 规范（可选预校验）:
    - `method_spec` v1 JSON Schema: `specs/method_spec_v1.schema.json`（进入运行时前 fail-fast；运行时仍做更严格校验）
    - schema 校验脚本: `specs/tests/validate_method_spec_schema.py`（依赖 `jsonschema`）
- 验收:
  - `python3 -m unittest discover -s tests -p "test_*.py"` 通过
  - `hepar method-design --tag <TAG> --template minimal_ok --project-id <id>` 可生成并跑通 W_compute
  - `hepar method-design --tag <TAG> --template pdg_snapshot --project-id <id> --pdg-particle-name pi0 --pdg-property mass`（stub MCP）可生成并跑通 W_compute
  - `hepar method-design --tag <TAG> --template pdg_runtime --project-id <id> --pdg-particle-name pi0 --pdg-property mass`（stub MCP + project-local `.mcp.json`）可生成并跑通 W_compute
- 证据:
  - 代码: commit `324064e`（MVP-1）, `9f3aeaa`（MVP-2: spec_v1/method_spec）, `ad01140`（schema: method_spec_v1）
  - **双模型审核**:
    - MVP-1: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M75-c2-method-design-r1`)
    - MVP-2: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M77-c2-spec-v1-r2`)
    - Schema: Opus + Gemini-3-pro-preview ✅ 收敛 (artifacts tag `M79-c2-method-spec-schema-r1`)
  - Workflow spec: `workflows/C2_method_design.md`
- TODO（MVP-3+，后续扩展，非阻塞）:
  - hep-calc 接入（符号推导/幅度生成）→ 自动落盘脚本 + audit slice + acceptance checks

**C3: 计算结果 → 论文 (P4c) (v3.5 重新设计)**

> v3.5 修订: MCP 写作工具是可组合工具箱，agent 自主决定写作路径。

- Agent 完成 W_compute 后，通过 B4 Outcome Gate 将产物桥接到 MCP evidence
- Agent 动态发现 MCP 写作工具 (ToolSearch)，根据论文复杂度**自主选择写作路径**:
  - 复杂论文 → 完整路径 (token budget → outline → N-best candidates → judge → integrate)
  - 中等论文 → 简化路径 (直接 `hep_render_latex` 提交 SectionDraft + integrate)
  - 简单报告 → 最小路径 (agent 生成完整内容 → research-writer consume_manifest 验证)
- MCP 写作工具提供 Prompt Packet (结构化 prompt)，agent 自行调用 LLM 生成内容
- research-writer `consume_manifest` 作为最终确定性卫生层 (BibTeX 校验 + citation 验证 + LaTeX 编译)
- 验收: W_compute 完成后，agent 自主完成至少一条写作路径，产出通过 research-writer 验证的可编译论文

**C4: 端到端研究循环 (P4a+P4b+P4c+P4d 集成)**

- 将 C1-C3 + referee-review + review-swarm 组合为完整研究循环
- 验收: 给定 HEP 主题，自主完成 文献调研 → 问题提出 → 方法设计 → 计算执行 → 论文撰写 → 审稿收敛

### Phase C 补充: 代码结构优化 (可选)

**C5: 完整 CLI 拆分 (如需要)**

- 如果 orchestrator_cli.py 在 Phase A 重构后仍然过大，按 `cli/commands/` 结构完整拆分
- 验收: 所有 CLI 命令行为不变; 回归测试全部通过

---

## 附录A: 影响面分析

### 需修改的文件清单

| 文件 | 改动类型 | 改动量 |
|------|---------|--------|
| `src/.../orchestrator_cli.py` | 移除全部领域分支 + 添加 W_compute 分派 + 提取 dispatch.py | 大 (删 ~200 行, 加 ~50 行) |
| `src/.../toolkit/workflow_context.py` | 移除 W2_v1/W4 硬编码上下文 | 中 (删 ~90 行) |
| `src/.../adapters/registry.py` | 扩展为支持声明式项目发现 | 小 (加 ~50 行) |
| `src/.../toolkit/orchestrator_regression.py` | 改造 w2v1 scenario 为 W_compute | 中 (改 ~60 行) |

### 新增文件清单

| 文件 | 用途 |
|------|------|
| `src/.../toolkit/w_compute.py` | 通用计算工作流引擎 (核心新增) |
| `src/.../toolkit/run_card_schema.py` | run_card v2 解析、验证 (严格模式)、参数解析 |
| `src/.../toolkit/bridge_outcome_gate.py` | B4 桥接结果验证器 (Outcome Gate，不硬编码 MCP 工具调用) |
| `src/.../cli/dispatch.py` | 工作流分派逻辑 (从 orchestrator_cli.py 提取) |
| `specs/run_card_v2.schema.json` | run_card v2 JSON Schema |
| `examples/schrodinger_ho/` | 第二个验证项目 (Schrodinger 方程求解) |

### 删除文件清单

| 文件 | 原因 | 删除时机 |
|------|------|---------|
| `src/.../toolkit/w2v1_lec_solve.py` | 物理逻辑移入 examples/ | Phase A6 |
| `src/.../toolkit/w2v1_poles.py` | 物理逻辑移入 examples/ | Phase A6 |
| `src/.../toolkit/w2v1_scattering_lengths.py` | 物理逻辑移入 examples/ | Phase A6 |
| `src/.../toolkit/w4_potential_matrix.py` | 物理逻辑移入 examples/ | Phase A6 |
| `scripts/run_w2v1_*.py` (3 个) | 移入 examples/ | Phase A6 |
| `scripts/run_w4_potential_matrix.py` | 移入 examples/ | Phase A6 |

### 不受影响的模块

以下模块在整个演化过程中**不需要修改**:

- `toolkit/orchestrator_state.py` (状态机)
- `toolkit/context_pack.py` (上下文打包)
- `toolkit/kb_profile.py` (知识库索引)
- `toolkit/run_card.py` (run card 写入 — 注: 新增 run_card_schema.py 不影响此文件)
- `toolkit/artifact_report.py` (产物报告)
- `toolkit/evals.py` (评测框架)
- `toolkit/w1_ingest.py` (文献采集)
- `toolkit/w3_revision.py` (审稿修改)
- `toolkit/literature_survey*.py` (文献综述)
- `toolkit/adapters/base.py` (adapter 接口)
- `toolkit/adapters/shell.py` (shell adapter)
- `toolkit/adapters/artifacts.py` (产物工具)
- `toolkit/ecosystem_bundle.py` (生态捆绑)
- `web/app.py` (Web UI)

---

## 附录B: 审稿历史

### R1: 初始双模型审稿

#### GPT-5.2 xhigh (via Codex CLI) — 判定: REVISE

> The direction is strong and the decomposition (project plugin + generic compute engine) is the right strategy. Before implementation, you need to (1) unify the plugin execution model, (2) specify the execution substrate (state/logs/provenance/resume), and (3) make security + schema compatibility explicit.

关键建议:
1. 选择单一插件模型 (声明式)，移除 `entry/callable/inputs_class`
2. 定义 first-class run state + artifacts contract (workspace + checksums)
3. 形式化 schema 治理 (engine_compat, validate, migrate)
4. 添加显式安全信任控制 (`--trust-project`, 路径约束, hash 记录)
5. 声明 v2 串行执行，预留 resources 字段

#### Gemini — 判定: REVISE

> The proposal is directionally correct and essential for the platform's maturity. However, it needs to address the migration strategy (to prevent breaking CI) and state management (explicit I/O) before implementation begins.

关键建议:
1. 实现 legacy adapter shim，不做 rip-and-replace
2. run_card phase 中添加显式 `inputs`/`outputs` 字段
3. 集成 trust prompt (类似 VS Code "Trust Workspace")
4. 第二个验证项目应与 W_compute 并行开发

#### R1 收敛点 (双方一致)

1. **统一插件模型**: 纯声明式，移除 Python-by-path 字段
2. **Phase 状态机**: 明确的状态转换 + 重试 + resume
3. **安全信任模型**: `--trust-project` + 路径约束 + hash 记录
4. **迁移安全**: 渐进迁移 + legacy shim (后在 R2 中被推翻)
5. **串行执行声明**: v2 为串行，预留 `resources` 字段
6. **Schema 治理**: 兼容性契约 + 未知字段策略

### R2: v2 方案审稿

#### GPT-5.2 xhigh — 判定: REVISE (4 blockers)

四项 Blocker:
1. **路径语义未定义**: 所有路径字段 (inputs, outputs, cwd, argv scripts) 相对于什么目录？phase 间文件传递机制？
2. **DAG 失败语义不完整**: `on_failure="continue"` 时依赖链传播规则？multi-dependency？crash recovery？
3. **信任行为对自动化不友好**: 非交互环境 (CI, cron) 下无 TTY 时行为未定义
4. **Schema 过于宽松**: 次版本号 + 未知字段 warning 导致隐性兼容性问题

其他建议:
- 删除 legacy shim (零外部用户)
- 压缩路线图

#### Gemini — 判定: APPROVE (with modifications)

建议修改:
- 删除所有 backward-compatibility 语言 (未发布工具无需向后兼容)
- 合并 Phase A + B
- 替换 harmonic_oscillator 为更具体的物理项目
- Schema 严格化: 未知字段 ERROR

#### R2 收敛裁决

| 问题 | GPT-5.2 | Gemini | v3 裁决 |
|------|---------|--------|---------|
| Legacy shim | 删除 | 删除 | **删除**: 直接切换 |
| 路径语义 | Blocker，需完整定义 | 同意需明确 | **新增完整路径语义章节** |
| Workspace/执行模型 | Blocker，需完整定义 | 同意需明确 | **新增 Run Workspace 规范 + 输出复制语义** |
| DAG 失败语义 | Blocker，需完整规则 | 同意需补充 | **补充完整失败传播 + crash recovery 规则** |
| 信任模型 | Blocker，需定义非交互行为 | 同意 | **明确 TTY 检测 + --trust-project 强制** |
| Schema 严格性 | 移除次版本号，未知字段 ERROR | 同意 | **仅整数版本，未知字段 ERROR** |
| 路线图 | 压缩 | 合并 A+B | **合并为 Phase A (构建+切换)** |
| 第二项目 | 同意更具体 | 建议替换 | **Schrodinger 方程求解** |

### R3: v3 方案审稿

#### GPT-5.2 xhigh (via Codex CLI) — 判定: APPROVE with minor suggestions

> v3 resolves the R2 blockers well enough to implement immediately; the remaining items are spec-tightening to prevent small but avoidable implementation forks.

4 项 R2 Blocker 全部 RESOLVED。4 项 minor suggestions (非 blocker):
1. Run identity 歧义 (run_card.run_id vs --run-id)
2. Project discovery 规则 (parent.parent vs 查找 project.json)
3. Pointer 格式 (RFC 6901 JSON Pointer)
4. 收敛摘要准确性 (附录B 表格修正)

#### Gemini gemini-3-pro-preview — 判定: APPROVE

> The v3 proposal has successfully converged. It transforms the project from a hardcoded single-paper reproduction script into a generalized, declarative research automation platform.

4 项 R2 Blocker 全部 RESOLVED。无新问题。无 remaining blocker。

#### R3 收敛结论

双方均给出 APPROVE。审稿迭代收敛完成。GPT-5.2 的 4 项 minor suggestions 已纳入 v3.1 修订。

### R4: v3.2/v3.3 工具生态集成审稿

#### R4.1: GPT-5.2 xhigh — 判定: REVISE (3 blockers)

三项 Blocker:
1. **B4/P4c 桥接缺少接口契约**: W_compute workspace → MCP evidence 的映射策略、产物最小集合、适配层形态未定义
2. **MCP "无状态/无副作用"表述与现实不一致**: `zotero_add`、`hep_run_create` 等有副作用
3. **P4 验收标准过宽**: LHCb 示例暗示需私有数据；"双模型 APPROVE"不可控

Non-blocking suggestions:
1. 工具别名/映射表 (概念名 → MCP tool id)
2. 决策框架扩展为二维
3. Reuse-first 可审计流程
4. W_compute 命名建议 (W_exec/W_taskgraph/W_dag_run)

#### R4.1: Gemini — 判定: APPROVE

Non-blocking suggestions:
1. W_compute 命名 (W_flow/W_runner/W_generic)
2. Skill 版本策略 (skills.json lockfile)
3. 生态健康检查命令 (`hepar doctor`)

#### R4.2: v3.3 修订后审稿

v3.3 解决了 GPT-5.2 的 3 个 blocker:
1. B4 桥接接口契约 (run_id 映射 + 产物最小集合 + 适配层 + 时机) — **RESOLVED**
2. MCP 层定义修正 (原子化 + 显式 I/O + 幂等或受控副作用) — **RESOLVED**
3. P4 验收收窄 (公开资料限定 + 可度量 KPI + 失败回退 + 示例替换) — **RESOLVED**

GPT-5.2: **APPROVE** | Gemini: **APPROVE** — 收敛。

#### v3.4: 高价值非阻塞建议纳入

基于 R4 四份审核报告中的非阻塞建议，筛选纳入以下内容:

| 来源 | 建议 | 纳入位置 |
|------|------|---------|
| GPT-5.2 R4.2 | `bridge_report.json` 桥接审计/重试 | B4 接口契约 §5 |
| Gemini R4.1 | Skill 版本锁定 (`skills.lock.json`) | Phase B5 |
| Gemini R4.1 | `hepar doctor` 生态健康检查 | Phase B6 |
| GPT-5.2 R4.1 | Reuse-first methodology trace 审计 | 设计原则 #5 |

暂不纳入: 工具别名/映射表 (实施时按需构建)、决策框架 2D 扩展 (当前一维已够用)、P4a/P4d JSON Schema (实施经验不足)。

#### v3.5: 模式 A + Outcome Gate 架构转型

基于 MCP 写作工具深度代码调研 (hep-research-mcp 写作流水线 TypeScript 源码全面审查) 和 MCP 升级影响分析:

**架构决策**: 将 MCP 集成策略从模式 B (硬编码桥接) 全面转向模式 A (动态发现 + 结果验证)。

| 变更 | v3.3-v3.4 | v3.5 |
|------|----------|------|
| B4 桥接实现 | `compute_to_evidence.py` 硬编码 MCP 工具调用 | Agent 动态发现 + `bridge_outcome_gate.py` 验证结果 |
| P4c 写作流程 | 固定流水线 (build_evidence → scaffold → judge → integrate) | Agent 自主选择写作路径 (完整/简化/最小) |
| MCP 升级影响 | 改工具名/参数 → 代码 break | 仅改结果语义 → break (极罕见) |
| 新增设计原则 | — | #8 动态发现优先、#9 结果契约优先 |

**MCP 写作工具调研关键发现** (影响 P4c 设计):
- MCP 写作工具**不生成内容**——只构建 Prompt Packet 返回给 agent
- Agent 100% 控制内容生成 (调用 LLM)
- 工具可任意顺序调用、可跳步、有多入口 (`hep_render_latex` 直接提交)
- Quality policy 可配置 (soft gate, 非 hard gate)
- 唯一硬约束: citation verifier (学术诚信)

---

*本方案基于 2026-02-08 对全部源代码的完整审查，经三轮独立双模型审稿 (R1-R3) 收敛定稿至 v3.1。v3.2 基于对 70+ 个 MCP 工具和 6 个研究类 skills 的深入调研新增工具生态整合。v3.3 解决 R4 审核 blocker。v3.4 纳入 R4 高价值非阻塞建议。v3.5 基于 MCP 写作工具 TypeScript 源码深度调研，将集成策略从硬编码桥接 (模式 B) 全面转向动态发现 + 结果验证 (模式 A + Outcome Gate)，新增设计原则 #8 (动态发现优先) 和 #9 (结果契约优先)。v3.6 对齐 repo 现状：更新耦合量化统计；修正路径语义 (inputs/outputs) 与 W_compute workspace / artifact contract 的一致性。v3.7 对齐 repo HEAD：标记 Phase A2 已完成，并更新耦合量化分母口径与基准 commit。v3.8 对齐 repo HEAD：标记 Phase A3 已完成；补齐耦合量化可复现命令；并强化“未发布可不兼容 + 新 idea 分支决策（Opus+Gemini 评估；大改先人类审议）”的实施门禁。v3.9 对齐 repo HEAD：标记 Phase A4 已完成并固化其交付物与门禁证据（见 Phase A）。v3.10 对齐 repo HEAD：标记 Phase A5 已完成并固化其验收（见 Phase A）。统计口径见文内；默认以 hep-autoresearch@bb9dbfe 为基准（如后续代码变更需重算）。*
