# HTTP reproducibility（网络可复现模式：record/replay/fail_all）

目标：让 **网络依赖不再成为科研复现与回归评测的随机源**。同一 workflow 在不同时间/不同网络状态下，应该尽可能得到相同的产物（或在失败时以确定性的方式失败）。

本项目的策略是：
- 关键产物以本地 `references/` 快照与 `artifacts/` 三件套为主（优先稳定锚点：INSPIRE/arXiv/DOI）。
- 对“不可避免的 HTTP 请求”，提供 **record/replay** 机制用于离线复现与 CI。
- 提供 **fail_all** 机制用于“禁网运行”与失败路径回归（例如确保失败不会污染已有快照）。

## 1) 环境变量（SSOT）

### `HEPAR_HTTP_MODE`

可选值（大小写不敏感）：
- `live`：正常联网（默认）
- `record`：联网 + 写入 fixtures（可重复运行；若 fixture 已存在则直接复用）
- `replay`：只从 fixtures 读取（禁止触网；缺 fixture 会报错）
- `fail_all`：禁止触网（任何 HTTP 都会直接失败，用于回归失败路径）

> 备注：代码里也接受 `fail` 作为 `fail_all` 的别名（见 `src/hep_autoresearch/toolkit/_http.py`）。

### `HEPAR_HTTP_FIXTURES_DIR`

当 `HEPAR_HTTP_MODE=record|replay` 时必须设置。

推荐路径（项目内、可审计）：
- `references/http_fixtures/`（适合共享/CI；只存公共数据）
- 或者 `artifacts/http_fixtures/`（适合本地临时；不建议提交）

示例：

```bash
export HEPAR_HTTP_MODE=record
export HEPAR_HTTP_FIXTURES_DIR=references/http_fixtures
```

## 2) fixtures 文件布局（确定性）

fixtures 按 URL 做 `sha256(url)`：
- `<sha>.json`：`http_get_json(...)`
- `<sha>.txt`：`http_get_text(...)`
- `<sha>.bin`：`http_download(...)`
- `<sha>.url.txt`：人类可读 sidecar（原始 URL；best-effort）

这意味着 fixtures 是 **URL 级别** 的缓存：同一个 URL 的不同时间响应，如果你想更新，需要删掉旧 fixture 或换 URL（例如增加 query 参数/版本）。

## 3) 什么时候用哪种模式（推荐）

### A) 日常开发：`live`

```bash
export HEPAR_HTTP_MODE=live
python3 scripts/run_ingest.py --arxiv-id 2310.06770 --refkey arxiv-2310.06770-swe-bench --tag M1-r1 --download none
```

### B) 需要可复现回归/CI：`record` → `replay`

1) 首次生成 fixtures（record）：

```bash
export HEPAR_HTTP_MODE=record
export HEPAR_HTTP_FIXTURES_DIR=references/http_fixtures
python3 scripts/run_ingest.py --arxiv-id 2310.06770 --refkey arxiv-2310.06770-swe-bench --tag M1-r1 --download none
```

2) 离线复现（replay；禁止触网）：

```bash
export HEPAR_HTTP_MODE=replay
export HEPAR_HTTP_FIXTURES_DIR=references/http_fixtures
python3 scripts/run_ingest.py --arxiv-id 2310.06770 --refkey arxiv-2310.06770-swe-bench --tag M1-r1 --download none
```

### C) 禁网回归（失败路径 + “不污染快照”）：`fail_all`

```bash
export HEPAR_HTTP_MODE=fail_all
python3 scripts/run_ingest.py --arxiv-id 2310.06770 --refkey arxiv-2310.06770-swe-bench --tag M18-ingest-failall-r1 --download none --no-query-log
```

该模式用于确保：
- 失败被记录在 artifacts（`analysis.json#/results/errors`），而不是静默退化
- 失败 **不会覆盖** 既有的 `references/arxiv/.../metadata.json` 等快照（见回归用例 E14）

## 4) 离线 eval 推荐路径（项目级）

目前 eval suite 主要检查“产物是否存在/字段是否完整/数值是否在容差内”，而不是实时跑网络抓取。

推荐两种离线策略：

1) **无 fixtures 的离线评测**（适合普通用户）  
   - 先在 `live` 下把需要的 `references/` 与 `artifacts/` 产物准备好（一次性）
   - 后续运行 eval suite 不再依赖网络：

```bash
python3 scripts/run_evals.py --tag offline-eval
```

2) **带 fixtures 的离线评测**（适合 CI/严格回归）  
   - 为将来“在 eval 里真正执行 ingestion”做准备
   - 使用 `record` 生成 fixtures，并在 CI 中用 `replay` 运行

## 5) 安全注意事项（必须）

- fixtures 可能包含完整 HTTP 响应；**只允许记录公共信息**（INSPIRE/arXiv/DOI 等公开数据）。
- 不要对需要认证/携带 token 的 URL 使用 `record`（避免泄露到磁盘/仓库）。
- 如果未来新增认证接口，应在工具层默认禁止 record（或对敏感域做 denylist）。
