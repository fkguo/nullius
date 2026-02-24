# 生态圈打包发布（v0）

目标：发布一个 `hep-autoresearch` 生态圈的 **核心容器 bundle**，要求：
- 版本可追溯（记录组件 commit/pin）
- 离线可审阅（打包包含源码快照；安装依赖仍可能需要包管理器）
- 默认安全（bundle 内不允许包含 secrets；bootstrap 必须能检测并 fail-fast）
- 可审计（证据落在 `artifacts/runs/<tag>/...`）

注意：这不是“研究 run bundle”（`export` 的那类），而是 **发布/分发** 用的环境快照。

核心 bundle 打包内容：
- 本仓库（`hep-autoresearch`）
- `hep-research-mcp`（package 快照 + lockfiles）
- 一组通用 skills（Codex skills，tracked files only）

## 包含内容

核心 bundle 默认包含：
- `hep-autoresearch` 源码快照（只打包 allowlist 的 tracked files）
- `hep-research-mcp` 快照：
  - `packages/hep-research-mcp/`（tracked files）
  - 根目录 lockfiles：`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`package.json`
- skills 快照（tracked files only），默认集合：
  - `review-swarm`
  - `claude-cli-runner`
  - `gemini-cli-runner`
  - `hepar`
  - `research-team`
  - `research-writer`
  - `referee-review`
  - `md-toc-latex-unescape`

所有 pin 信息都在 bundle zip 内的 `bundle_manifest.json`。

## 不包含内容（add-ons）

核心 bundle v0 有意不包含：
- 大体积/重依赖（例如 `hep-calc`）
- 特定领域实验脚手架（例如 `deep-learning-lab`）
- 已弃用/将移除的 skills（例如 `research-team-audit`）
- 仓库维护类工具（例如 `hep-mcp-*`）

这些可以在后续以 add-on 形式单独发布。

## 如何构建（维护者）

将 bundle 构建为 evidence artifacts：

```bash
python3 scripts/run_ecosystem_bundle.py --tag Mxx-t37-r1
```

输出：
- `artifacts/runs/<tag>/ecosystem_bundle/core_bundle.zip`
- `artifacts/runs/<tag>/ecosystem_bundle/bundle_manifest.json`
- `artifacts/runs/<tag>/ecosystem_bundle/{manifest,summary,analysis}.json`

## 如何 bootstrap（用户）

解压 bundle zip 后运行 bootstrap 检查：

```bash
python3 bootstrap.py --check
```

该步骤会执行 **secrets-like 文件扫描**，发现可疑项会 fail-fast。

## 在新机器上安装（alpha 测试）

前置条件：
- Python 3.11+（自带 `venv`）
- Node.js（用于运行 bundle 内 `hep-research-mcp` 的 `dist/` 入口）
- （可选）Codex CLI（如果你希望使用 bundle 内的 skills）

步骤：

1) 解压并 bootstrap（在 bundle 根目录执行）：

```bash
unzip core_bundle.zip
cd hep-autoresearch-ecosystem-bundle-v0
python3 bootstrap.py --check
```

2) 设置指向 bundle 内组件的环境变量（在 bundle 根目录执行）：

```bash
export HEP_MCP_PACKAGE_DIR="$PWD/components/hep-research-mcp/packages/hep-research-mcp"
# 可选：让 Codex 通过 $CODEX_HOME/skills 发现 bundle 内的 skills。
export CODEX_HOME="$PWD/components"
```

3) 安装 `hep-autoresearch`（editable）并跑一次 smoke check：

```bash
cd components/hep-autoresearch
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -U pip
python3 -m pip install -e .
python3 -c "import hep_autoresearch; print('import ok')"
# 可选（更强 smoke）：在已解压的 bundle 源码上重建一次 ecosystem bundle。
python3 scripts/run_ecosystem_bundle.py --tag ALPHA-smoke-bundle-r1
```

备注：
- API key 等 secrets 只能在运行时通过环境变量提供。请不要把 secrets 放到 bundle 目录树里（bootstrap 会 fail-fast）。
- 本仓库的大多数脚本默认 `cwd` 是仓库根目录（bundle 中即 `components/hep-autoresearch`）。
- `scripts/run_evals.py` 面向完整 dev repo 运行；核心 bundle v0 有意不打包 `knowledge_base/`、`references/`、以及历史 `artifacts/runs/*`，因此在最小 bundle 环境下全量 eval suite 会失败。

## secrets 策略（硬要求）

- secrets **禁止**打包进 bundle。
- bootstrap 必须在检测到 secrets-like 文件时拒绝继续（例如私钥、API key 赋值、可疑文件名/后缀）。
- secrets 只能在运行时提供（环境变量 / 挂载卷），并且必须避免写入 git 与 release bundle。

## 许可证说明（v0）

本仓库当前不会为所有外部组件自动 vendoring 许可证全文。
bundle manifest 会记录组件 remotes/commits，便于下游自行核验许可证与依赖信息。
