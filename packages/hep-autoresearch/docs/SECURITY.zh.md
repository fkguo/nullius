# Security（安全、权限与执行策略）

科研自动化必然涉及“能跑代码、能改文件、能上网”，安全与权限必须内置，而不是事后补丁。

## 1) 目录与权限（建议默认策略）

- 默认只读：除非用户明确允许，代理不应修改项目外的任何目录。
- 项目内分区（建议）：
  - `references/`：外部来源快照（可读写，但写入必须可追溯）
  - `artifacts/`：运行产物（可写；可清理但要留 manifest）
  - `team/`：审阅/复核产物（可写）
  - `paper/`：写作工程（可写）
  - `knowledge_base/`：知识库（可写，但要求链接/证据卫生）
- 破坏性操作（删除/覆盖/卸载）默认要求显式确认或在配置中允许。

## 2) 网络策略

- 优先稳定锚点：INSPIRE/arXiv/DOI/GitHub/Zenodo/官方文档。
- 所有检索与选择必须记录在 `knowledge_base/methodology_traces/literature_queries.md`（append-only）。
- 下载的代码/脚本默认不执行；执行前需要最小安全审查（来源、版本、checksum/签名、最小权限）。
- 可复现网络访问：需要离线/CI 时使用 record/replay/fail_all（见 [HTTP reproducibility](HTTP_REPRODUCIBILITY.md)）。

## 3) 机密与凭据

- 不读取/不外泄任何 token/密钥/密码（即使本地可见）。
- 需要访问外部服务时，优先使用无密钥接口；必须用密钥时，采用最小权限并隔离在本地环境变量/密钥管理器中，禁止写入仓库与产物。

## 4) 可追溯执行

- 每个 run 必须落盘：命令、cwd、参数、版本、输出、时间戳、关键日志。
- 任何自动改稿必须生成 diff，并保留可回滚路径。
