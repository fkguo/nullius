# Formalism Boundary SOTA Memo

> 日期：2026-03-10
> 目的：回答 `formalism` 是否应继续作为 `autoresearch` core / public contract / shipped domain pack authority 的一部分。

## 1. 结论先行

- `formalism` 不应继续作为 `autoresearch` core 的必填公共 contract。
- `candidate_formalisms[]`、`formalism_registry`、`formalism_check` 不应继续作为主干 workflow 的 mandatory gate。
- `domain_pack_id` 可以保留，但它应是稳定的 pack 引用键，而不是具体实例世界观。
- HEP pack 应提供的是 provider / capability / evidence / execution 连接层，而不是 shipped concrete formalism catalog。
- 具体 formalism / approach 名称只应出现在用户输入、project/run-local context、demo fixtures、或 provider-local 非权威模板里。

## 2. 当前仓库里的真实情况

### 2.1 `formalism` 目前并不是真 execution axis

当前 `formalism` 的主要作用是：

- `IdeaCard` 强制要求 `candidate_formalisms[]`
- `campaign.init` 合并 pack 的 `formalism_registry`，并直接取第一项作为默认 formalism
- `search.step` 把这个默认 formalism 注入 seed node、operator context、retrieval packet
- `node.promote` 只检查 candidate 是否出现在 registry 里，然后输出一个 `formalism_check: pass`

但 downstream 真正进入 run 的地方并不消费它：

- `packages/hep-mcp/src/tools/create-from-idea.ts` 只拿 `thesis`、`claims`、`hypotheses`
- 没有任何稳定的 `formalism -> execution backend` 主干消费链

因此，当前 `formalism` 更像：

- 搜索期的默认标签
- promotion 前的 membership gate
- graph / docs 里的一等节点类型

而不是一个真实的 compute / execution / provider 编排轴。

### 2.2 当前 concrete shipped instances 也没有形成真实知识 authority

当前 built-in HEP catalog 里的具体项包括：

- pack ids: `hep.bootstrap`, `hep.operators.v1`
- formalism ids: `hep/toy`, `hep/eft`, `hep/lattice`

它们现在主要只是：

- id
- placeholder `c2_schema_ref`
- placeholder `validator_id`
- placeholder `compiler_id`

这说明它们既不是完整的知识库，也不是成熟的执行抽象，却已经进入 public contract 和 default behavior。这正是边界设计失真的信号。

## 3. SOTA 对照

## 3.1 AI Scientist-v2

论文：

- https://arxiv.org/abs/2504.08066

公开实现：

- https://github.com/SakanaAI/AI-Scientist-v2
- 本地审阅 clone：`<local_review_clone>/AI-Scientist-v2`，commit `96bd51617cfdbb494a9fc283af00fe090edfae48`

观察：

- 用户先提供 topic / workshop description
- 系统产出 idea JSON，再进入 agentic tree search、experiments、writeup、review
- concrete domain content 位于用户提供的问题描述、idea file、实验代码与任务上下文
- core runtime 不携带 canonical formalism registry

结论：

- 问题定义和 runtime substrate 是 core
- 具体方法内容来自 task / idea / experiment context，而不是预装世界观 catalog

## 3.2 PiFlow

论文：

- https://arxiv.org/abs/2505.15047

公开实现：

- https://github.com/amair-lab/PiFlow

观察：

- 用户通过 task config + tools 运行系统
- `PrincipleFlow` 从 hypothesis 和 experiment result 中抽取 principle
- tools 按任务场景适配，强调 plug-and-play
- 没有 shipped concrete formalism authority

结论：

- “principle / approach” 是 runtime 中从探索和证据里形成的结构
- 不是预装在 generic substrate 里的实例目录

## 3.3 Agent Laboratory

论文：

- https://arxiv.org/abs/2501.04227

公开实现：

- https://github.com/SamuelSchmidgall/AgentLaboratory

观察：

- 人类提供 research idea 和 notes
- 系统按 literature review / experimentation / report writing workflow 协作
- specialized agents 是 workflow role，不是 concrete formalism catalog
- 用户问题、实验计划、资源约束才是主输入

结论：

- 研究系统的 core 入口是 research problem + notes + resources
- 不是 “先绑定到某组 canonical formalisms”

## 3.4 AIDE

论文：

- https://arxiv.org/abs/2502.13138

公开实现：

- https://github.com/WecoAI/aideml

观察：

- 输入是 `goal`、`metric`、`data_dir`
- core 是 tree search in code space
- 方法选择体现在生成/修改的代码与实验轨迹里
- 没有任何领域 worldview catalog

结论：

- 对通用研究 substrate 来说，goal / metric / evidence / runtime trace 才是基本面
- concrete method families 不应先于这些成为公共主合同

## 4. 对 autoresearch 的架构含义

应该分成四层：

1. 问题层
   - question
   - thesis / claim / hypothesis
   - required observables / evidence needs

2. 方法层
   - approach options
   - method hints
   - formalism / framework / model family
   - 这些应是可选、可迭代、可回退、可替换的 run-local 内容

3. 执行层
   - method_spec
   - execution_plan
   - capability requirements
   - provider selection

4. provider / pack 层
   - literature providers
   - database providers
   - compute providers
   - validator / compiler / executor / evidence builders

这里真正稳定的核心不变量是：

- core 负责问题、artifact、evidence、approval、runtime/audit
- provider / pack 负责 capability 和外部连接
- LLM / agent 在治理边界内选择和迭代方法

## 5. 对当前仓库的直接建议

### 5.1 应该降级或移除的 public authority

- `IdeaCard.required candidate_formalisms[]`
- `formalism_registry_v1`
- `IdeaHandoffC2.formalism_check`
- `campaign.init` 的 default formalism seeding
- `search.step` 对 campaign default formalism 的强依赖
- graph-viz 中把 formalism 升格为一等 `form:*` 节点的默认语义

### 5.2 可以保留但要改语义的位置

- `domain_pack_id`
  - 作为稳定 audit / replay / explicit selection key
  - 不再表达“这个 pack 自带 canonical concrete formalism authority”

- HEP pack
  - 保留 INSPIRE / PDG / HEPData / Zotero / compute provider 连接能力
  - 不承担 concrete shipped formalism catalog 职责

### 5.3 以后如果还需要 formalism 信息

可以进入以下位置，但必须是 optional / local：

- user-supplied project context
- run-local `approach_hints`
- future `method_spec`
- demo fixtures / test fixtures
- provider-local templates

不应再进入：

- generic core mandatory schema
- promotion gate
- built-in default worldview
- shared/public tool ecology authority

## 6. 对 batch2 / batch3 的影响

- `batch2` 当前代码层清理工作不是白做了，它已经把一部分 HEP default authority 下沉到 seam。
- 但 `batch2` 不应现在 closeout，因为更深层的 public contract 还没有清理。
- `batch3` 当前 prompt 只清理 root/runtime/provider 命名占位，不足以解决 formalism contract leakage。
- 正确顺序应改为：
  1. batch2 partial cleanup
  2. formalism contract de-instancing / demotion follow-up
  3. batch3 runtime/root/provider de-HEP occupancy

## 7. 最终设计判断

对 `autoresearch` 而言：

- research question / evidence / runtime 才是 core
- method / formalism 是 runtime-local、可选、可回退的内容
- provider / domain pack 提供 capability，不提供 canonical concrete instance worldview

因此，`formalism` 应从 core public contract 降级。
