# HEPData MCP — 使用指南

HEPData（https://www.hepdata.net）是高能物理实验数据的权威公开数据库，收录来自 LHC、Tevatron、HERA、LEP、低能固定靶实验等的数值测量结果。

本指南同时面向人类用户和 AI agents。

---

## 工具列表

| 工具 | 功能 | 需要 |
|------|------|------|
| `hepdata_search` | 搜索实验记录，返回 `hepdata_id` 列表 | 至少一个搜索条件 |
| `hepdata_get_record` | 获取记录元数据和数据表列表，返回 `table_id` | `hepdata_id` |
| `hepdata_get_table` | 获取数值数据（JSON 或 YAML） | `table_id` |
| `hepdata_download` | 下载完整提交压缩包（zip） | `hepdata_id` + `_confirm: true` |

**典型调用链：**

```
hepdata_search → hepdata_get_record → hepdata_get_table
```

---

## hepdata_search — 搜索参数详解

### 精确 ID 查找（推荐，无歧义）

```json
{ "inspire_recid": 728302 }        // 用 INSPIRE record ID
{ "arxiv_id": "hep-ex/0610021" }   // 用 arXiv ID
{ "doi": "10.1016/j.physletb.2007.01.073" }  // 用 DOI
```

### 关键词搜索

```json
{ "query": "pion form factor CMD-2" }
```

> **注意**：HEPData 的关键词搜索是宽泛文本匹配，精度不如结构化过滤器。建议配合下列过滤器使用。

### 结构化过滤器（可组合）

#### `reactions` — 按反应类型搜索（最有效）

使用 INSPIRE/HEPData 标准反应符号（**全大写，`-->` 分隔**）：

```json
{ "reactions": "E+ E- --> PI+ PI-" }      // e+e- → π+π-（46 条记录）
{ "reactions": "PI- P --> PI- P" }         // π-p 弹性散射（200 条）
{ "reactions": "PI+ P --> PI+ P" }         // π+p 弹性散射（146 条）
{ "reactions": "P P --> P P" }             // pp 弹性（330 条）
{ "reactions": "E+ E- --> HADRONS" }       // e+e- → 强子（296 条）
{ "reactions": "GAMMA P --> PI0 P" }       // 光产生（141 条）
```

粒子名称对照表：

| 粒子 | HEPData 写法 |
|------|-------------|
| π± | `PI+` / `PI-` |
| π⁰ | `PI0` |
| 质子 | `P` |
| 反质子 | `PBAR` |
| e± | `E+` / `E-` |
| γ | `GAMMA` |
| K± | `K+` / `K-` |
| 中子 | `N` |

#### `collaboration` — 按实验组

```json
{ "collaboration": "LHCb" }
{ "collaboration": "CMD-2" }
{ "collaboration": "KLOE" }
{ "collaboration": "BESIII" }
{ "collaboration": "CMS" }
```

> 大小写敏感，与网站显示一致。

#### `observables` — 按可观测量类型

```json
{ "observables": "SIG" }           // 总截面
{ "observables": "DSIG/DOMEGA" }   // 微分截面（角分布）
{ "observables": "DSIG/DPT" }      // pT 微分截面
{ "observables": "POL" }           // 极化度
{ "observables": "ASYM" }          // 不对称度
{ "observables": "F2" }            // 结构函数 F2
{ "observables": "SLOPE" }         // 斜率参数（弹性散射）
{ "observables": "MULT" }          // 多重数
```

#### `phrases` — 按物理主题标签

```json
{ "phrases": "Proton-Proton Scattering" }
{ "phrases": "Pion-Proton Scattering" }
{ "phrases": "Deep Inelastic Scattering" }
{ "phrases": "Elastic" }
{ "phrases": "Cross Section" }
{ "phrases": "Jet Production" }
{ "phrases": "Polarization" }
```

#### `cmenergies` — 按质心系能量范围（GeV）

```json
{ "cmenergies": "0.0,1.0" }         // 低能：√s < 1 GeV
{ "cmenergies": "1.0,10.0" }        // 中能：1–10 GeV
{ "cmenergies": "7000.0,8000.0" }   // LHC 7 TeV
{ "cmenergies": "13000.0,14000.0" } // LHC 13 TeV
```

#### `subject_areas` — 按 arXiv 分类

```json
{ "subject_areas": "hep-ex" }
{ "subject_areas": "nucl-ex" }
{ "subject_areas": "hep-ph" }
```

#### `sort_by` — 排序方式

```json
{ "sort_by": "date" }          // 按发表日期
{ "sort_by": "latest" }        // 按入库时间
{ "sort_by": "relevance" }     // 按相关性（默认）
```

### 组合示例

**搜索所有 e+e- → π+π- 低能测量，按日期排序：**
```json
{
  "reactions": "E+ E- --> PI+ PI-",
  "cmenergies": "0.0,2.0",
  "sort_by": "date"
}
```

**搜索 LHCb 的截面测量：**
```json
{
  "collaboration": "LHCb",
  "observables": "SIG",
  "query": "charm production"
}
```

**搜索 pp 弹性散射微分截面：**
```json
{
  "reactions": "P P --> P P",
  "observables": "DSIG/DT"
}
```

---

## hepdata_get_record — 返回结构

```json
{
  "hepdata_id": 96268,
  "title": "Measurement of σ(e+e- → π+π-)...",
  "inspire_recid": 912841,
  "arxiv_id": "arXiv:1107.4822",
  "doi": "10.1016/j.physletb.2011.04.055",
  "collaborations": ["KLOE"],
  "abstract": "...",
  "data_tables": [
    { "table_id": 1649547, "name": "Differential cross section", "doi": "..." },
    { "table_id": 1649548, "name": "Statistical covariance",     "doi": "..." }
  ]
}
```

> `table_id` 直接用于 `hepdata_get_table`。

---

## hepdata_get_table — 数据格式

### JSON 格式（默认，推荐）

`values` 是逐行数据，每行包含 `x`（自变量）和 `y`（测量量）：

- `x[i].value`：点数据（单点能量、角度等）
- `x[i].low` + `x[i].high`：区间数据（bin 边界，如 pT bin、能量 bin）
- `y[i].value`：测量值
- `y[i].errors[]`：误差列表，每项有 `label`（如 `"stat"`、`"sys"`）和：
  - `symerror`：对称误差（±值）；或
  - `asymerror: { plus, minus }`：非对称误差（正负分开）

```json
{
  "name": "Table 1",
  "description": "Bare cross section for e+e- → π+π-",
  "headers": [
    { "name": "M_ππ² [GeV²]", "colspan": 1 },
    { "name": "σ_ππ [nb]",    "colspan": 1 }
  ],
  "values": [
    {
      "x": [{ "low": "0.100", "high": "0.110" }],
      "y": [{
        "value": 44.0,
        "errors": [
          { "label": "stat", "symerror": 7.0 },
          { "label": "sys",  "symerror": 5.0 }
        ]
      }]
    }
  ]
}
```

### YAML 格式（`format: "yaml"`）

返回 HEPData 原始 YAML，包含完整误差分解（统计、系统、各来源）。适合需要原始格式或详细误差信息的场景。

---

## hepdata_download — 下载完整提交包

将指定记录的所有数据表下载为 zip 压缩包保存到本地磁盘。

**必须传 `_confirm: true`**（写文件操作安全门控）。

```json
{ "hepdata_id": 96268, "_confirm": true }
```

**返回字段：**

```json
{
  "uri": "hepdata://artifacts/submissions/96268/hepdata_submission.zip",
  "file_path": "/path/to/data/artifacts/submissions/96268/hepdata_submission.zip",
  "size_bytes": 48320,
  "tables_count": 15
}
```

- `uri` — artifact 引用，可用于下游 pipeline
- `file_path` — 本地磁盘绝对路径
- `size_bytes` — 压缩包大小（字节）
- `tables_count` — 该提交包含的数据表数量

存储根目录由环境变量 `HEPDATA_DATA_DIR` 控制（默认为平台标准数据目录）。

---

## 外部链接

- HEPData 主页：https://www.hepdata.net
- HEPData 搜索（带 JSON API）：https://www.hepdata.net/search/?format=json
- HEPData 提交格式说明：https://hepdata.net/submission
- HEPData REST API（旧文档，部分已更新）：https://hepdata.readthedocs.io/en/latest/api.html
