# nds-mcp — Nuclear Data Services MCP Server

## 目标

创建 `packages/nds-mcp/`：一个**独立可用**的本地 SQLite 驱动 MCP server，提供核物理数据查询工具。

架构风格完全对齐 `packages/pdg-mcp/`，复用 `@autoresearch/shared`（sqlite3Cli、错误辅助等），避免代码重复。

如果未来需要独立发布，届时做一次性内联即可——不要为假设性需求预付复制维护成本。

## 前置条件

- 使用 git worktree 隔离开发，避免与 main 上的 Phase 2 工作冲突：
  ```bash
  git worktree add ../autoresearch-nds feat/nds-mcp
  cd ../autoresearch-nds
  ```
- 启动 Claude Code 时使用 worktree 目录：`cd ../autoresearch-nds && claude`
- 该包与 Phase 2 redesign 无依赖关系，可独立开发和合并
- 完成后 PR 合入 main，然后清理 worktree：`git worktree remove ../autoresearch-nds`

## 执行前必读

1. `packages/pdg-mcp/` — 完整参考实现（架构、MCP 注册、SQLite 查询、测试风格）
2. `packages/pdg-mcp/src/db/sqlite3Cli.ts` — sqlite3 CLI 调用封装（通过 `@autoresearch/shared` 复用）
3. `packages/pdg-mcp/src/tools/registry.ts` — ToolSpec 注册模式
4. `packages/pdg-mcp/src/index.ts` — MCP server 入口模式
5. `packages/shared/src/constants.ts` — 工具名常量定义模式（在此添加 `NDS_*` 常量）

## 独立性设计

### 不依赖的替代方案（仅当需要独立发布时）

现阶段依赖 `@autoresearch/shared`。如果未来需要独立发布为 npm 包：
- 将 `sqlite3Cli.ts`、`errors.ts`、工具名常量一次性内联到包内
- 移除 `"@autoresearch/shared": "workspace:*"` 依赖
- 这是一次性操作，不需要提前准备

### package.json 依赖

```json
{
  "dependencies": {
    "@autoresearch/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.25.2",
    "zod": "^4.3.5"
  }
}
```

## 前置工作：sqlite3Cli 提升到 shared

`sqlite3Cli.ts` 目前在 `packages/pdg-mcp/src/db/sqlite3Cli.ts`，是通用的 sqlite3 CLI 封装。为避免复制，**第一步将其提升到 `@autoresearch/shared`**：

1. 将 `packages/pdg-mcp/src/db/sqlite3Cli.ts` 移动到 `packages/shared/src/db/sqlite3Cli.ts`
2. 从 `packages/shared` 导出（添加到 barrel export）
3. 更新 `pdg-mcp` 中所有 `sqlite3Cli` 的 import 指向 `@autoresearch/shared`
4. 确认 `pnpm -r build` + `pnpm -r test` 通过

完成后 nds-mcp 和 pdg-mcp 都从 shared 导入，单一来源。

## 数据源

### Phase 1: 离线主库（本批必须完成）

| 数据源 | 文件 | 内容 | SQLite 表名建议 |
|--------|------|------|----------------|
| AME2020 | `mass_1.mas20` | mass excess, binding energy/A, beta-decay energy, atomic mass | `ame_masses` |
| AME2020 | `rct1.mas20`, `rct2_1.mas20` | S2n, S2p, Sn, Sp, Q values (Qα, Qβ-, Q2β-, Qεp, QEC) | `ame_reactions` |
| NUBASE2020 | `nubase_4.mas20` | half-life, spin/parity, decay modes + branching ratios, isomers | `nubase` |
| IAEA | `charge_radii.csv` | nuclear charge radii (rms charge radius, model-independent) | `charge_radii` |

数据下载方式：
- AME2020 + NUBASE2020: https://www-nds.iaea.org/amdc/ （ASCII 固定宽度格式）
- Charge radii: https://www-nds.iaea.org/radii/ （CSV 格式）

### Phase 2: 在线补充（可选，后续扩展）

| 数据源 | API | 内容 |
|--------|-----|------|
| IAEA LiveChart | `nds.iaea.org/relnsd/v1/data?fields=...` | 能级 (levels), γ 射线 (gammas), 衰变辐射 (decay_rads) |

Phase 2 采用"按需拉取 + 本地缓存表"策略，不全量入库。

## 包结构

```
packages/nds-mcp/
├── package.json          # @autoresearch/nds-mcp (or standalone nds-mcp)
├── tsconfig.json
├── vitest.config.ts
├── bin/
│   └── nds-mcp.js        # #!/usr/bin/env node 入口
├── src/
│   ├── index.ts           # MCP server setup
│   ├── tooling.ts         # re-export for external consumers
│   ├── db/
│   │   ├── ndsDb.ts       # NDS_DB_PATH env, 文件验证, SHA-256
│   │   ├── masses.ts      # AME masses 查询
│   │   ├── reactions.ts   # AME separation energies + Q values 查询
│   │   ├── nubase.ts      # NUBASE 核性质查询
│   │   └── chargeRadii.ts # 电荷半径查询
│   ├── tools/
│   │   ├── registry.ts    # ToolSpec[] 注册
│   │   ├── mcpSchema.ts   # Zod → MCP inputSchema 转换
│   │   └── index.ts       # getTools, handleToolCall
│   ├── data/
│   │   └── dataDir.ts     # 数据目录 + artifacts 目录
│   └── ingest/
│       ├── parseAme.ts      # AME2020 固定宽度格式解析器
│       ├── parseNubase.ts   # NUBASE2020 解析器
│       ├── parseRadii.ts    # charge_radii.csv 解析器
│       └── buildDb.ts       # 主入口: 解析 → 建表 → 插入 → 建索引
├── tests/
│   ├── ingest.test.ts       # 解析器 + DB 构建测试
│   ├── masses.test.ts       # 质量查询测试
│   ├── reactions.test.ts    # 分离能/Q值查询测试
│   ├── nubase.test.ts       # 核性质查询测试
│   ├── chargeRadii.test.ts  # 电荷半径查询测试
│   └── toolContracts.test.ts # MCP 工具注册契约测试
└── fixtures/
    └── sample.sqlite         # 小型测试用 DB (10-20 nuclides)
```

## MCP 工具清单

工具名常量在 `src/constants.ts` 中定义（自包含）。

| 工具名 | 描述 | 输入 | 输出 |
|--------|------|------|------|
| `nds_find_nuclide` | 按 Z/A/符号查找核素 | `{ element?: string, Z?: number, A?: number }` | 匹配核素列表（质量、半衰期、自旋等基本信息） |
| `nds_get_mass` | 获取核素质量数据 | `{ Z: number, A: number }` | mass excess, binding energy, binding energy/A, atomic mass |
| `nds_get_separation_energy` | 获取分离能 | `{ Z: number, A: number, type?: "Sn"\|"Sp"\|"S2n"\|"S2p" }` | 分离能值 + 不确定度 |
| `nds_get_q_value` | 获取 Q 值 | `{ Z: number, A: number, type?: "Qa"\|"Qbm"\|"Q2bm"\|"Qep"\|"QEC" }` | Q 值 + 不确定度 |
| `nds_get_decay` | 获取衰变信息 | `{ Z: number, A: number }` | 半衰期、衰变模式、分支比 |
| `nds_get_charge_radius` | 获取电荷半径 | `{ Z: number, A?: number }` | rms charge radius + 不确定度 (A 省略则返回该元素所有同位素) |
| `nds_search` | 按属性范围搜索核素 | `{ property, min?, max?, Z_min?, Z_max? }` | 满足条件的核素列表 |
| `nds_info` | 返回 DB 元信息 | `{}` | 数据版本、核素数量、DB SHA-256 |

## SQLite Schema 设计

```sql
-- 数据版本跟踪
CREATE TABLE nds_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- e.g. ('ame_version', 'AME2020'), ('nubase_version', 'NUBASE2020'), ('radii_version', '2024'), ('build_date', '...')

-- AME2020 质量表
CREATE TABLE ame_masses (
  Z INTEGER NOT NULL,
  A INTEGER NOT NULL,
  element TEXT NOT NULL,         -- 元素符号
  mass_excess_keV REAL,          -- mass excess (keV)
  mass_excess_unc_keV REAL,      -- uncertainty
  binding_energy_keV REAL,       -- total binding energy (keV)
  binding_energy_unc_keV REAL,
  binding_energy_per_A_keV REAL, -- B/A (keV)
  beta_decay_energy_keV REAL,
  beta_decay_energy_unc_keV REAL,
  atomic_mass_micro_u REAL,      -- atomic mass in micro-u
  atomic_mass_unc_micro_u REAL,
  is_estimated INTEGER DEFAULT 0, -- 1 if value is from systematics (marked # in AME)
  PRIMARY KEY (Z, A)
);

-- AME2020 反应/分离能表
CREATE TABLE ame_reactions (
  Z INTEGER NOT NULL,
  A INTEGER NOT NULL,
  element TEXT NOT NULL,
  S2n_keV REAL, S2n_unc_keV REAL,
  S2p_keV REAL, S2p_unc_keV REAL,
  Sn_keV REAL, Sn_unc_keV REAL,
  Sp_keV REAL, Sp_unc_keV REAL,
  Qa_keV REAL, Qa_unc_keV REAL,       -- Q(alpha)
  Qbm_keV REAL, Qbm_unc_keV REAL,     -- Q(beta-)
  Q2bm_keV REAL, Q2bm_unc_keV REAL,   -- Q(2beta-)
  Qep_keV REAL, Qep_unc_keV REAL,     -- Q(epsilon-p)
  QEC_keV REAL, QEC_unc_keV REAL,      -- Q(EC)
  PRIMARY KEY (Z, A)
);

-- NUBASE2020
CREATE TABLE nubase (
  Z INTEGER NOT NULL,
  A INTEGER NOT NULL,
  element TEXT NOT NULL,
  isomer_index INTEGER DEFAULT 0,  -- 0=ground state, 1=first isomer, ...
  mass_excess_keV REAL,
  mass_excess_unc_keV REAL,
  excitation_energy_keV REAL,      -- isomer excitation energy (0 for g.s.)
  half_life TEXT,                   -- as string (e.g. "stable", "12.32 y", "7.7 ms")
  half_life_seconds REAL,           -- converted to seconds (NULL for stable)
  half_life_unc_seconds REAL,
  spin_parity TEXT,                 -- e.g. "1/2+", "0+", "(3/2-)"
  decay_modes TEXT,                 -- e.g. "B-=100", "a=100;B+=0.0019"
  is_estimated INTEGER DEFAULT 0,
  PRIMARY KEY (Z, A, isomer_index)
);

-- IAEA charge radii
CREATE TABLE charge_radii (
  Z INTEGER NOT NULL,
  A INTEGER NOT NULL,
  element TEXT NOT NULL,
  r_charge_fm REAL,                -- rms charge radius (fm)
  r_charge_unc_fm REAL,            -- uncertainty
  r_charge_04_fm REAL,             -- 2004 evaluation value (if different)
  r_charge_04_unc_fm REAL,
  method TEXT,                     -- measurement method
  PRIMARY KEY (Z, A)
);

-- 索引
CREATE INDEX idx_ame_masses_element ON ame_masses(element);
CREATE INDEX idx_ame_reactions_element ON ame_reactions(element);
CREATE INDEX idx_nubase_element ON nubase(element);
CREATE INDEX idx_nubase_half_life ON nubase(half_life_seconds);
CREATE INDEX idx_charge_radii_element ON charge_radii(element);
```

## AME2020 固定宽度格式解析要点

AME2020 的 `mass_1.mas20` 格式是固定列宽 ASCII（不是 CSV/TSV），解析时需注意：
- 前 39 行是 header，跳过
- 列位置固定（参考 AME2020 文档中的 FORTRAN format 说明）
- `#` 标记表示该值来自 systematics（估计值），不是实验数据 → 设 `is_estimated=1`
- 空白字段或 `*` 表示无数据 → 设 NULL
- 不确定度中的 `#` 也需要特殊处理

建议：先下载数据文件，写解析器时用实际文件验证列位置。

## 数据库构建流程

```
下载原始数据文件
  ↓
ingest/parseAme.ts → 解析 mass_1.mas20, rct1.mas20, rct2_1.mas20
ingest/parseNubase.ts → 解析 nubase_4.mas20
ingest/parseRadii.ts → 解析 charge_radii.csv
  ↓
ingest/buildDb.ts → CREATE TABLE + INSERT + CREATE INDEX
  ↓
nds.sqlite (放在 NDS_DB_PATH 指定路径或 ~/.nds-mcp/nds.sqlite)
```

构建脚本应可通过 `npx nds-mcp build --data-dir /path/to/raw/files --output /path/to/nds.sqlite` 调用。

## 与 pdg-mcp 的关键对齐/差异点

| 方面 | pdg-mcp 做法 | nds-mcp 做法 |
|------|-------------|-------------|
| SQLite 访问 | `sqlite3` CLI (`sqlite3Cli.ts`) via shared | 同，复用 `@autoresearch/shared` |
| 环境变量 | `PDG_DB_PATH` | `NDS_DB_PATH` |
| 工具名常量 | `@autoresearch/shared` 中定义 | 同，在 shared 中添加 `NDS_*` 常量 |
| 错误辅助 | `@autoresearch/shared` | 同，复用 |
| Zod schema | 每个工具的 inputSchema 用 Zod 定义 | 同 |
| MCP server | `@modelcontextprotocol/sdk` + stdio transport | 同 |
| 测试 | vitest, 使用 fixture DB | 同 |

## 执行流程

### Step 0: pdg-mcp Codex 审核（开发前）

pdg-mcp 当时未经双模型审核，作为 nds-mcp 的架构参考，应先审核其实现质量。发现的问题在 nds-mcp 开发中直接规避。

1. 准备 pdg-mcp 审核 system prompt（角色：senior code reviewer，关注 SQL 注入、边界情况、错误处理、MCP 协议合规）
2. 准备完整 review packet：所有 `packages/pdg-mcp/src/` 源文件 + 测试文件的概要
3. 运行 Codex 单模型审核（pdg-mcp 是已稳定的只读工具，Codex 单模型即可）：
   ```bash
   python3 skills/review-swarm/scripts/bin/run_multi_task.py \
     --out-dir /tmp/pdg-mcp-review \
     --system /tmp/pdg-mcp-review-system.md \
     --prompt /tmp/pdg-mcp-review-packet.md \
     --models codex/gpt-5.3-codex
   ```
4. 记录发现的问题 → 分为两类：
   - **pdg-mcp 自身需修复的**：提 issue 或直接修复
   - **nds-mcp 开发时需规避的**：记入开发注意事项

### Step 1: sqlite3Cli 提升到 shared

1. 将 `packages/pdg-mcp/src/db/sqlite3Cli.ts` 移动到 `packages/shared/src/db/sqlite3Cli.ts`
2. 从 `packages/shared` 导出
3. 更新 pdg-mcp 的 import 指向 `@autoresearch/shared`
4. `pnpm -r build` + `pnpm -r test` 通过

### Step 2-9: nds-mcp 开发

1. 创建 worktree：`git worktree add ../autoresearch-nds feat/nds-mcp`
2. 在 worktree 目录启动 Claude Code：`cd ../autoresearch-nds && claude`
3. 下载原始数据文件（AME2020 + NUBASE2020 + charge_radii.csv）
4. 搭建包 scaffold（package.json, tsconfig, vitest.config）
5. 实现解析器（parseAme, parseNubase, parseRadii）+ 测试
6. 实现 DB 构建脚本（buildDb）+ 生成 fixture DB
7. 实现查询层（masses, reactions, nubase, chargeRadii）+ 测试
8. 实现 MCP 工具注册 + server 入口 + 在 shared 中添加 `NDS_*` 常量
9. 冒烟测试（`echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | NDS_DB_PATH=... node dist/index.js`）

### Step 10-11: 双模型收敛审核

10. 双模型收敛审核（review-swarm，规则同 CLAUDE.md §多模型收敛检查）
11. 修复 BLOCKING → 迭代至收敛（最终轮必须用完整 packet）
12. PR → merge to main

## 双模型收敛审核

同 CLAUDE.md 中的多模型收敛检查规则：
- 使用 `review-swarm` skill（Codex + Gemini）
- 每轮必须处理**所有模型**的**所有 BLOCKING**
- 最终收敛轮必须使用**完整 packet**
- Codex 不要提前截断

## 不在范围

- Phase 2 IAEA LiveChart API 在线查询（后续扩展）
- hep-mcp 代码层集成（通过 MCP config 组合即可，不需要代码依赖）
- ENSDF 全量数据入库
- 与 REDESIGN_PLAN 的任何 Phase 2 item 关联
