# HEPData MCP — 使用指南

HEPData（https://www.hepdata.net）是高能物理实验数据的权威公开数据库，收录来自 LHC、Tevatron、HERA、LEP、低能固定靶实验等的数值测量结果。

本指南同时面向人类用户和 AI agents。

---

## 工具列表

| 工具 | 功能 | 需要 |
|------|------|------|
| `hepdata_search` | 搜索实验记录，返回 `hepdata_id` 列表 | 至少一个搜索条件 |
| `hepdata_get_record` | 获取记录元数据和数据表列表，返回 `table_id` | `hepdata_id` |
| `hepdata_get_table` | 内联获取数值数据（JSON、YAML 或 CSV） | `table_id` |
| `hepdata_download` | 下载完整提交到本地磁盘（zip / json / 各格式归档） | `hepdata_id` + `_confirm: true` |

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

### 分页与排序（修饰符，不能单独作为搜索条件）

```json
{ "sort_by": "date" }          // 按发表日期
{ "sort_by": "latest" }        // 按入库时间
{ "sort_by": "relevance" }     // 按相关性（默认）
{ "page": 2, "size": 25 }      // 单页；size 最大 25
{ "max_results": 100 }         // 有界自动翻页（见下）
```

`max_results` 启用**有界自动翻页**：搜索会逐页请求（每页一次独立、受限速的请求），
累积结果直到达到该数量，或 HEPData 没有更多匹配为止——以先到者为准。省略时为单页行为
（有效默认值 = `size`）。存在 **硬上限 200**：超过 200 的值会被收敛到 200，因此单次搜索
绝不会触发对 HEPData 的无界爬取。

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

`format` 选择内联返回方式（不写文件）：

- `format: "json"`（默认）— 解析并归一化为下面的结构化对象。
- `format: "yaml"` — 返回 HEPData 原始 YAML 文本，含完整误差分解。
- `format: "csv"` — 返回该表的 HEPData 原始 CSV 文本。

重型/二进制格式（`root`、`yoda`、`yoda1`、`yoda.h5`）**不在此处**——请用 `hepdata_download`
将它们写入磁盘。

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

### YAML / CSV 格式（`format: "yaml"` / `format: "csv"`）

`format: "yaml"` 返回 HEPData 原始 YAML，包含完整误差分解（统计、系统、各来源），适合需要原始格式或详细误差信息的场景；`format: "csv"` 返回该表的原始 CSV 文本。两者均按原文返回，不做解析。

---

## hepdata_download — 下载完整提交包

将指定记录的所有数据表下载到本地磁盘。与 `hepdata_get_table`（内联返回可文本化格式）不同，
这是获取整份提交归档以及重型/二进制格式的路径。

**必须传 `_confirm: true`**（写文件操作安全门控）。

```json
{ "hepdata_id": 96268, "_confirm": true }                  // 原始提交 zip
{ "hepdata_id": 96268, "format": "yoda", "_confirm": true } // 单格式归档
```

### `format` — 下载内容（默认 `original`）

| `format` | HEPData 返回 | 落盘文件名 |
|----------|--------------|-----------|
| `original`（默认） | 完整提交 zip（所有表、所有格式） | `hepdata_submission.zip` |
| `json` | 单个提交 JSON 文件 | `hepdata_submission.json` |
| `csv` | 每张表 CSV 的 `.tar.gz` 归档 | `hepdata_submission_csv.tar.gz` |
| `root` | 每张表 ROOT 的 `.tar.gz` 归档 | `hepdata_submission_root.tar.gz` |
| `yaml` | 每张表 YAML 的 `.tar.gz` 归档 | `hepdata_submission_yaml.tar.gz` |
| `yoda` | 每张表 YODA 的 `.tar.gz` 归档 | `hepdata_submission_yoda.tar.gz` |
| `yoda1` | 每张表 YODA1 的 `.tar.gz` 归档 | `hepdata_submission_yoda1.tar.gz` |
| `yoda.h5` | 每张表 YODA HDF5 的 `.tar.gz` 归档 | `hepdata_submission_yoda_h5.tar.gz` |

每种格式写入提交 artifacts 目录下**各自独立**的文件，因此对同一份提交下载多种格式不会互相覆盖。
返回的 `uri` 与落盘文件名保持一致。

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
