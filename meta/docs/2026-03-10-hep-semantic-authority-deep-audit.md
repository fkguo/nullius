# HEP Semantic Authority Deep Audit

> 日期：2026-03-10
> 目的：确认 `hep-mcp` / `idea-core` 中仍然存活的 semantic authority、worldview leakage、以及哪些内容应删除、哪些应重写、哪些在重写后才有资格提升到 generic/shared 层。

## 1. 结论先行

- 真正的问题不是仓库里出现了 `bootstrap`、`lattice`、`eft`、`toy` 这些词，而是它们以不完整、封闭、难扩展的 enum / lexicon / rubric / template 形式充当了 runtime 或 public output authority。
- `idea-core` 仍然持有 active HEP worldview authority：`hep.bootstrap`、`bootstrap_default`、`HEP_COMPUTE_RUBRIC_RULES`、`toy_laptop` 这类 built-in/default path 还在 generic/core 入口内生效。
- `hep-mcp` 仍然持有 active semantic authority：review/paper classification、critical question generation、assumption categorization、theoretical conflict normalization、topic/method grouping、challenge extraction、survey/deepAnalyze section routing 中都还有闭合集合或 keyword-based authority。
- 已完成的 `NEW-SEM-05` / `NEW-SEM-10` / `NEW-SEM-13` 代表的是一次局部质量改善和模块整理，不应再被表述为“最终 shared/generic authority 已建立”；当前源码并不支持这种说法。
- 有价值的 generic 层内容不是这些 HEP-specific lexicon 本身，而是它们背后的 typed output contracts、abstention/fallback provenance、eval harness、以及 LLM-first multi-stage adjudication pattern。当前具体实现若仍依赖封闭枚举，则应先重写，再决定是否上提。

## 2. 审计方法

- 直接阅读当前源码，而不是根据 tracker 或旧 closeout 文案推断。
- 追踪调用链到 public output、tool behavior、eval fixtures、以及 downstream consumers。
- 对照 2025-2026 primary-source SOTA 文献，而不是沿用 2024 以前的经验判断。
- 明确区分：
  - active authority：当前直接决定 public output / grouping / scoring / gating 的逻辑
  - provider-local fail-open prior：有 provenance、可被上层 override、失败时不冒充 truth 的提示逻辑
  - generic candidate：只在 provider-neutral rewrite 后才可能提升出去的稳定 typed seam

## 3. 当前源码里的 active authority

### 3.1 `idea-core` built-in HEP worldview 仍在 generic path 生效

涉及文件：

- `packages/idea-core/src/idea_core/engine/hep_builtin_domain_packs.json`
- `packages/idea-core/src/idea_core/engine/hep_domain_pack.py`
- `packages/idea-core/src/idea_core/engine/domain_pack.py`
- `packages/idea-core/src/idea_core/engine/hep_constraint_policy.py`

关键现象：

- built-in pack catalog 仍然 shipped `hep.bootstrap`，并通过 `operator_source: "bootstrap_default"` 把 HEP bootstrap path 固化为 generic built-in 入口。
- `hep_constraint_policy.py` 仍以 `HEP_COMPUTE_RUBRIC_RULES`、`HEP_HEAVY_COMPUTE_TOKENS`、`toy_laptop`、`frontier_not_yet_feasible` 等闭合 rubric 直接改写 `minimal_compute_plan` 的 infra / compute-hours 判断。
- `domain_pack.py` 仍把 builtin domain-pack index 的默认实现绑定到 HEP built-ins。

判断：

- 这不是 harmless example，也不是 run-local hint；它是 generic core 的默认行为。
- 这类逻辑会直接污染未来 `idea-engine` Stage 3 的迁移边界。

决策：

- 删除 shipped `hep.bootstrap` / `bootstrap_default` worldview authority。
- 删除 `toy_laptop` 一类方法标签驱动的 HEP rubric authority。
- 若仍需要 feasibility 校验，只能重写成 capability-first / task-first / evidence-first contract，并明确区分 generic invariant 与 provider-local optional validator。
- 不允许把这些 HEP tokens 改名成更抽象的 generic 名字后继续留在 core。

### 3.2 review / paper / critical / assumption 模块仍以 keyword buckets 直接决定 public output

涉及文件：

- `packages/hep-mcp/src/tools/research/reviewClassifier.ts`
- `packages/hep-mcp/src/tools/research/paperClassifier.ts`
- `packages/hep-mcp/src/tools/research/criticalQuestions.ts`
- `packages/hep-mcp/src/tools/research/assumptionTracker.ts`
- 直接 consumers：`criticalResearch.ts`、`criticalAnalysis.ts`、`inspireSearch.ts`、`traceToOriginal.ts`、`seminalPapers.ts`、`emergingPapers.ts`

关键现象：

- `reviewClassifier.ts` 仍用 `CONSENSUS_KEYWORDS` / `CRITICAL_KEYWORDS` / `CATALOG_KEYWORDS`、`AUTHORITATIVE_SOURCES` 直接产出 `review_type`、`authority_score`、`is_authoritative_source`、`recommendation`。
- `paperClassifier.ts` 仍用 closed keyword lists、conference series、category buckets 决定 `paper_type` / `is_review` / `content_type`，并直接影响 `inspireSearch.ts` 的 `review_mode` filtering 以及多个 downstream analysis tools。
- `criticalQuestions.ts` 仍用 closed `PAPER_TYPE_KEYWORDS` + fixed `QUESTION_TEMPLATES` + rule-based red flags/reliability score 直接构造 user-facing questions。
- `assumptionTracker.ts` 仍用 explicit/implicit keyword sets、challenge/validation keyword query、closed assumption categories，并默认回落到 `theoretical`。

判断：

- 这些模块不是“仅内部辅助”。它们会直接影响 tool 输出、paper filtering、question framing、risk/reliability impression。
- 固定 question templates、review authority scores、assumption categories 在 open-world scientific literature 上都明显过窄，且会 silently degrade quality。

决策：

- 当前实现不得继续被视为 semantic authority。
- 若概念本身仍有价值，应重写为：
  - MCP-sampling-first 或 equivalent LLM/agent adjudication
  - strict typed output
  - explicit abstention / unavailable / fallback provenance
  - deterministic logic 仅作 post-guards / metadata priors
- 若暂时无法重写，则必须显式降级为 diagnostics-only，不得再输出 authority-like labels 或 recommendation text 冒充 truth。

### 3.3 theoretical conflict 仍被封闭 HEP lexicon 决定

涉及文件：

- `packages/hep-mcp/src/tools/research/theoreticalConflict/lexicon.ts`
- `packages/hep-mcp/src/tools/research/theoreticalConflicts.ts`

关键现象：

- `AXIS_POSITION_LEXICON` 仍将 debate axis/position 绑定到一组很窄的 HEP/exotic-hadron terms。
- `mutualExclusionRuleHits(...)` 用固定 mutual-exclusion pairs 直接介入 relation 判定。

判断：

- 这不是 generic theoretical-conflict substrate，而是特定子领域的 closed worldview。
- 将这种 lexicon 留作 authority，只会把“以前一个子领域里手工写过的几种争论”误写成系统可识别争论的边界。

决策：

- 不得提升到 generic/shared。
- 若保留，只能作为 provider-local retrieval prior 或 debug signal，且不能直接驱动 final conflict label。
- 真实 conflict adjudication 应基于 claim-pair / assumption-pair / evidence-pair 的 structured reasoning，并保留 `not_comparable` / `uncertain` / `abstained` path。

### 3.4 synthesis / grouping / challenge / survey / deepAnalyze 仍存在封闭 authority

涉及文件：

- `packages/hep-mcp/src/tools/research/synthesis/collectionSemanticLexicon.ts`
- `packages/hep-mcp/src/tools/research/synthesis/collectionSemanticGrouping.ts`
- `packages/hep-mcp/src/tools/research/synthesis/challengeLexicon.ts`
- `packages/hep-mcp/src/tools/research/synthesis/challengeExtraction.ts`
- `packages/hep-mcp/src/tools/research/survey.ts`
- `packages/hep-mcp/src/tools/research/deepAnalyze.ts`
- 直接 consumers：`analyzePapers.ts`、`synthesis/grouping.ts`、`synthesis/narrative.ts`

关键现象：

- topic/method grouping 仍由很小的 `TOPIC_CONCEPTS` / `METHOD_CONCEPTS` alias lists 决定。
- challenge extraction 仍由固定 `CHALLENGE_RULES` / `UNCERTAIN_CUES` / `EXPLICIT_NO_CHALLENGE` 决定 challenge taxonomy。
- `survey.ts` 仍用 title keywords 决定 review paper；`deepAnalyze.ts` 仍用 section-title keyword buckets 找 methodology / conclusions / results / discussion。

判断：

- 这些实现如果作为 utility-only fallback 还勉强可接受；但当前 tracker/plan/closeout 叙事曾把它们描述成“shared semantic authority”或“semanticizer”，这与源码事实不符。
- 它们的真正风险不在于“有 keyword”，而在于“小而封闭的 alias list 被包装成了 semantic grouping authority”。

决策：

- topic/method/challenge 的抽象概念可以保留，但现有 closed HEP lexicon 不应原样保留或上提。
- `deepAnalyze.ts` 的 heading-based utility 可作为 non-semantic convenience path 保留，但不得继续被表述为 semantic understanding 结果。
- `survey.ts` / `deepAnalyze.ts` / grouping/challenge modules 若继续存在，必须把 utility/fallback 性质写明，并加上 unavailable/uncertain/fallback provenance；否则应重写。

## 4. 哪些内容值得保留，哪些应直接清除

### 4.1 应直接删除或重写后替换

- `hep.bootstrap`
- `bootstrap_default`
- `HEP_COMPUTE_RUBRIC_RULES`
- `toy_laptop` / closed HEP compute rubric ids
- `AUTHORITATIVE_SOURCES` / `CONSENSUS_KEYWORDS` 一类直接输出 authority labels 的 closed lists
- `PAPER_TYPE_KEYWORDS` + fixed `QUESTION_TEMPLATES` 这种把 paper semantics 压平为一组模板的 authority
- `AXIS_POSITION_LEXICON` / `MUTUAL_EXCLUSION_RULES` 这类特定子领域争论 taxonomy
- `TOPIC_CONCEPTS` / `METHOD_CONCEPTS` / `CHALLENGE_RULES` 这种 tiny shipped worldview catalogs

### 4.2 可作为 provider-local fail-open prior 暂留，但不得冒充 authority

- collaboration / journal / metadata priors
- heading-based section lookup
- citation-pattern or publication-type heuristics
- stance / claim / quantity 的 heuristic fallback

前提：

- 必须显式记录 `used_fallback`
- 必须有 `unavailable` / `invalid_response` / `abstained` 路径
- 失败时不能 silently 输出高置信 truth-like label

### 4.3 有资格在重写后提升到 generic/shared 的，只是这些“结构”，不是现有 HEP lexicon

- claim / evidence / stance typed contracts
- quantity adjudication typed contracts
- paper assessment / review issue / assumption graph 的 typed output contracts
- topic/method/challenge cluster 的 generic output schema
- abstention / fallback / provenance contract
- eval harness、baseline/holdout contract、drift regression discipline

结论：

- “critical questions”“topic grouping”“challenge extraction” 这些类别本身不局限于 HEP。
- 但当前 HEP 实现不能原样上提；若有保留，也应先在更高层级重写成 provider-neutral typed seam，然后由 `hep-mcp` 作为其中一个 carrier/consumer。

## 5. 方向上更健康的现有模块

以下模块目前更接近正确方向：

- `packages/hep-mcp/src/core/semantics/claimExtraction.ts`
- `packages/hep-mcp/src/core/semantics/evidenceClaimGrading.ts`
- `packages/hep-mcp/src/core/semantics/quantityAdjudicator.ts`

共同特点：

- LLM/MCP-sampling-first
- deterministic logic 主要退居 fallback 或 post-guard
- 输出带有 typed provenance
- invalid response / sampling unavailable 有显式 reason path

注意：

- `packages/hep-mcp/src/core/semantics/citationStanceHeuristics.ts` 仍然只适合作为 fallback prior，不适合作为主 authority。

## 6. 2025-2026 SOTA 对照

以下 primary sources 支持“open-world, evidence-grounded, multi-stage, auditable semantics”方向，而不支持继续维护小而封闭的 keyword authority：

- CiteAudit (2026-02)  
  https://arxiv.org/abs/2602.23452  
  核心信号：citation verification 被分解为 claim extraction、evidence retrieval、passage matching、reasoning、calibrated judgment；说明正确方向是多阶段可审计流水线，而不是 title/keyword authority。

- CIBER (2025-03)  
  https://arxiv.org/abs/2503.07937  
  核心信号：scientific claim verification 依赖 corroborating/refuting evidence retrieval，强调 open-world retrieval 而不是固定 taxonomy。

- CLAIMCHECK (2025-03)  
  https://arxiv.org/abs/2503.21717  
  核心信号：即使 frontier LLM 在 weakness-to-claim grounding 上仍显著弱于专家；既然真正 grounded critique 都很难，闭合 keyword templates 更不应被包装成 authority。

- Unveiling the Merits and Defects of LLMs in Automatic Review Generation for Scientific Papers (2025-09)  
  https://arxiv.org/abs/2509.19326  
  核心信号：自动 review 在 weakness detection、substantive questions、quality sensitivity 上普遍偏弱；因此系统必须避免用简单 lexical heuristics 进一步放大这个短板。

- PRISMM-Bench (2025-10, updated 2026-02)  
  https://arxiv.org/abs/2510.16505  
  核心信号：scientific multimodal inconsistency reasoning 仍然困难；说明 section/figure/table/equation 间的不一致不可能靠小型 keyword catalogs 覆盖。

- FLAWS (2025-11)  
  https://arxiv.org/abs/2511.21843  
  核心信号：error identification/localization 是核心 review task，frontier LLM 仍然困难；这再次说明 closed enums 不该成为 authority。

- APRES (2026-03)  
  https://arxiv.org/abs/2603.03142  
  核心信号：rubric-guided paper revision 可以帮助 stress-test manuscript，但其定位是 augment humans，而不是把一套 static rubric worldviews 固化进 core substrate。

- ODKE+ (2025-09)  
  https://arxiv.org/abs/2509.04696  
  核心信号：production-grade open-domain extraction 依赖 retrieval + extraction + grounding + corroboration + ontology-guided constraints；值得借鉴的是 modular audited pipeline，而不是把当前 HEP alias list 提升为 ontology authority。

### 对本仓的直接含义

- LLM/agent 不是万能，所以要做多阶段、可回放、带 provenance 和 abstention 的语义流程。
- 也正因为 LLM/agent 仍有限，更不能退回到“几个 keyword + 小枚举 = semantic authority”的错误方向。
- 正确策略是：
  - open-world extraction / adjudication
  - deterministic guards only
  - explicit fallback metadata
  - eval-driven regression
  - provider-neutral stable contracts 与 provider-local carriers 分离

## 7. 执行顺序影响

新的顺序应为：

1. `Batch A`: idea-core bootstrap / toy / compute-rubric cleanup
2. `Batch B`: review / paper / critical / assumption authority cleanup
3. `Batch C`: theoretical conflict authority cleanup
4. `Batch D`: synthesis / grouping / challenge / survey / deepAnalyze cleanup
5. `Batch E`: 对 surviving abstractions 做 generic uplift（仅限 provider-neutral rewrite 后）
6. `Batch F`: 恢复 residual `batch2` closeout，再执行 `batch3`

替换掉旧的隐含顺序：

- 旧：formalism cleanup -> 恢复 batch2 -> 直接 batch3
- 新：formalism cleanup -> semantic-authority deep cleanup -> residual batch2 closeout -> batch3

## 8. 会话与审核规则

- 不要把 A-F 塞进一个超长线程。
- 默认一批一个对话。
- 只有当相邻批次共享同一 boundary、同一 acceptance commands、同一 review surface、并且变更文件高度重叠时，才允许合并在一个对话里。
- 若 `Gemini` 继续不可用，本 program 的正式审核可使用用户已明确批准的 `Opus + Kimi K2.5` 双模型收敛；但必须在**每一批**的 review artifact / closeout note 中记录 Gemini 不可用与用户批准，不得静默替换 reviewer。

## 9. 最终判断

- 这次需要清理的，不只是 runtime residue。
- 更需要处理的是：哪些 originally shipped into HEP 的 semantic logic 其实既不够好，也不该卡在 HEP provider 内部，更不该继续误导 future generic layer。
- 对这些内容的原则只有三条：
  - 有害且无长期价值：直接清除
  - 有局部价值但不应充当 authority：降级为 provider-local fail-open prior
  - 有长期价值：重写成 provider-neutral contract 后再提升到 generic/shared，不能把现有 HEP-specific 枚举原样搬上去
