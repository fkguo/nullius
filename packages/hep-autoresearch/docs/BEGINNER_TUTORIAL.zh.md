# Beginner tutorial（legacy package walkthrough）

English quickstart: `docs/BEGINNER_TUTORIAL.md`。本文件是中文详版。

本教程默认你是在**外部研究项目目录**里使用当前 CLI surfaces。`packages/hep-autoresearch` 所在仓库是开发仓库，不应再被当作日常研究项目根目录；真实研究项目的中间产物也不应再写回这个开发仓。

如果你想先看当前 generic front door，请先读仓库根级 `../../docs/QUICKSTART.md` 与 `../../docs/TESTING_GUIDE.md`。本教程是一个 package-level 的 legacy / maintainer 兼容路径说明，只面向那些确实需要触碰收窄后 Pipeline A shell 的读者。

生命周期说明：generic lifecycle 的 canonical 入口现在是 `autoresearch`，用于 `init/status/approve/pause/resume/export`。`hep-autoresearch`、`hepar` 与 `hep-autopilot` 仍是过渡中的 **Pipeline A** Python surface，但安装态 public shell 现在只保留 `run` 这一个兼容提示层命令；其余 legacy workflow/support commands 都只保留在 internal full parser。public computation、`literature-gap`、direct root lifecycle/approval mutations（`start`、`checkpoint`、`request-approval`、`reject`），以及旧 public support commands 现在都只保留在 internal full parser；legacy internal parser wrappers `doctor` 与 `bridge` 则已删除，不再作为兼容命令保留。因此本教程对 lifecycle verbs 使用 `autoresearch`，而任何 legacy shell 示例都只作为收窄后的兼容路径说明。

## 0）先建立 4 个概念

1) **Agent 不等于模型**：可信度来自 artifacts、审批 gate、可回放命令、独立复核，而不是“提示词写得好”。
2) **Workflow 是入口**：你选择 `ingest`、`reproduce`、`computation`、`draft`、`revision` 等任务类型，编排层负责路由和门禁。
3) **Artifacts 是证据**：关键输出必须落到 `manifest.json` / `summary.json` / `analysis.json`。`report.md` 只是派生的人类可读视图。
4) **Context pack 是护栏**：每个 run 都可以写出 `context.md` 和 `context.json`，把当前工作锚定到项目本地的 charter / plan / notebook / approval contracts。

## 1）安装

```bash
python3 -m venv ~/.venvs/hep-autoresearch
source ~/.venvs/hep-autoresearch/bin/activate
python -m pip install -U pip

# 在 package 开发仓库根目录做开发安装
python -m pip install -e .
autoresearch --help
hep-autoresearch --help
hepar --help
```

可选：
- 如果后面要跑双评审或 skill 工作流，再准备 `claude` CLI、`gemini` CLI。

## 2）先创建一个真正的研究项目根目录

```bash
mkdir my-research-project
cd my-research-project
autoresearch init
autoresearch status
```

这一步会在你的项目目录里生成最小骨架：
- `project_charter.md`
- `project_index.md`
- `research_plan.md`
- `research_notebook.md`
- `research_contract.md`
- `.mcp.json.example`
- `.autoresearch/`
- `docs/`
- `specs/`

之后你可以在任意子目录运行 `autoresearch ...` 处理 lifecycle verbs；CLI 会自动向上寻找 `.autoresearch/`。
安装态 `hep-autoresearch run` 现在只保留兼容壳层命令，不再公开 workflow id；workflow 文档里出现的语义名更多是工作流规范或 internal maintainer 路径，不再代表安装态 public shell 真相。
安装态 public shell 现在只保留 `run` 这一个兼容提示层命令；其余 legacy workflow/support commands 都只保留在 internal full parser。
如果你显式传 `HEP_DATA_DIR`，它也应留在开发仓外；public real-project flow 现在会对 repo 内 override 直接 fail-close。

## 3）先跑一个 legacy compatibility 烟测

这是一条可选的兼容路径烟测，不是推荐的 first-touch 路径。

先确认安装态壳层已经收窄：

```bash
hep-autoresearch --help
hep-autoresearch run --help
```

这一步确认安装态壳层仍然存在，但对外只发布收窄后的 `run` 兼容入口。

## 4）先确认剩余 public `run` 入口

```bash
hep-autoresearch run --help
```

安装态 `hep-autoresearch run` 已不再公开 workflow id；请改用 `autoresearch run --workflow-id ...`。

## 5）其他 workflow 入口

- `computation`：`docs/COMPUTATION.md`，并通过 `autoresearch run --workflow-id computation` 进入（不是 `hep-autoresearch run`）
- `paper_reviser`：`workflows/paper_reviser.zh.md`（internal maintainer/full-parser workflow coverage，不再属于 installable public shell）
- `reproduce`：`workflows/reproduce.md`（workflow 规范 / maintainer coverage，不再是当前 installable public shell）
- `draft`：`workflows/draft.md`
- `revision`：`workflows/revision.md`（workflow 规范 / maintainer coverage，不再是当前 installable public shell）
- `derivation_check`：`workflows/derivation_check.md`

其中 `revision` 的默认语义是：你自己的项目根目录里有一个 `paper/`（或你显式指定的 LaTeX 工程），编排器在 gate 之后对它做可审计修改。

## 6）如果你要用更高层的 skills / team 流程

如果你明确要用 `research-team`、`research-writer` 或其它更高层 skill：
- 把对应 prompts / 资产放在**你的项目根目录**；
- 把它们当作项目本地 workflow 输入；
- 不要再假设本 package 仓库自带 package-root member prompts 或 package-root manuscript tree。

## 7）维护者说明

如果你是在维护 `packages/hep-autoresearch` 这个包本身，才在 package 仓库根目录运行回归：

```bash
python3 scripts/run_evals.py --tag M0-eval-r1
python3 scripts/run_orchestrator_regression.py --tag M0-reg-r1
```

这里的 regression harness 会刻意使用 `init --runtime-only`，避免维护者回归重新生成 package-root 项目文件。

这属于维护者回归流程，不是终端用户默认 quickstart。
