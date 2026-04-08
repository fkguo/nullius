# Review Health Metrics

> 目的：为 `review-swarm` + `self-review` 提供一套最小、可持续、可回溯的健康度监测规范，避免只凭“最近大多是 0 blocking”做主观判断。

## 1. 适用范围

本规范适用于所有需要正式 `review-swarm` 的实现 closeout 与重大治理文档变更。

它只定义：

- 每个 batch / closeout 需要记录的最小审查遥测字段
- 从这些字段派生出的窗口级健康度指标
- 触发复盘/加严审查的红线

它**不**改变既有 closeout gate：

- `review-swarm` 三审 `blocking_issues = 0`
- `self-review` 通过
- acceptance commands 通过
- tracker / `AGENTS.md` / 必需 SSOT 同步

## 2. 设计原则

1. 不把 `0 blocking` 当作单独健康信号。
2. 优先记录 **per-batch 原始事实**，窗口指标由这些事实派生，而不是手工主观汇总。
3. 指标只服务于治理校准，不替代源码级 judgment。
4. 若指标与实际 reopen/escape 事实冲突，以后者为准。
5. 指标定义应稳定，但阈值可按实践复盘小幅调整。

## 3. Canonical 记录粒度

每个完成 formal `review-swarm` 的 batch，都应在持久 SSOT 中记录一段最小结构化遥测。

优先记录位置：

1. 对应的 checked-in closeout 文档（例如 `meta/docs/*` 或受影响 package 的 closeout 文档）
2. 若存在 run-level approval artifacts，则同步写入对应 `packet.md` / `packet_short.md`，并在 closeout 文档中给出引用锚点

临时 `meta/.review/` 产物可以承载原始 reviewer 输出，但**不能**作为唯一持久记录位置。

推荐嵌入方式：

```text
Review health telemetry:
{"review_rounds":1,"first_round_blocking":false,"final_zero_blocking":true,"reviewer_disagreement":true,"amendments_total":4,"amendments_adopted":2,"amendments_deferred":1,"amendments_declined_closed":1,"packet_assumption_breach":false,"self_review_caught_new_issue":true,"reopened_later":false,"post_closeout_escape":false}
```

要求：

- 可以作为 closeout 文档中的一段紧凑 JSON 出现
- 不要求它成为额外顶层 schema 字段
- 但字段名与语义必须与本文件保持一致

## 4. Required Per-Batch Fields

每个 batch 至少记录以下字段：

```json
{
  "review_rounds": 1,
  "first_round_blocking": false,
  "final_zero_blocking": true,
  "reviewer_disagreement": true,
  "amendments_total": 4,
  "amendments_adopted": 2,
  "amendments_deferred": 1,
  "amendments_declined_closed": 1,
  "packet_assumption_breach": false,
  "self_review_caught_new_issue": true,
  "reopened_later": false,
  "post_closeout_escape": false
}
```

字段定义：

- `review_rounds`
  - formal `review-swarm` 实际经历的轮次
- `first_round_blocking`
  - 第一轮 formal review 中，是否有任一 reviewer 给出 blocking issue
- `final_zero_blocking`
  - 最终收敛轮中，三审是否都为 `blocking_issues = 0`
- `reviewer_disagreement`
  - 第一轮中，reviewer 对 `blocking / non-blocking / converged` 判断是否存在实质分歧
- `amendments_total`
  - 所有 formal reviewer 在最终 closeout 前提出的 non-blocking amendments 总数
- `amendments_adopted`
  - 本轮被吸收的 amendment 数
- `amendments_deferred`
  - 被明确 deferred 且仍有后续价值的 amendment 数
- `amendments_declined_closed`
  - 被明确判定为低价值、非适用或已解决的 amendment 数
  - 要求满足：`amendments_adopted + amendments_deferred + amendments_declined_closed = amendments_total`
- `packet_assumption_breach`
  - formal review 或 self-review 是否明确推翻了 packet 的核心前提，例如“已收口”“lane 外 debt”“authority completeness 已满足”等
- `self_review_caught_new_issue`
  - `self-review` 是否捕获了 external review 未明确指出、但最终促成修复或 disposition 变化的新问题
- `reopened_later`
  - 该 batch closeout 后是否因源码级问题被正式 reopened
- `post_closeout_escape`
  - 该 batch 是否在后续 batch / retro-closeout / shared entrypoint 验收中暴露出“原 batch 本应发现”的漏检问题，即使未正式 reopen

## 5. Optional Per-Batch Fields

若当轮出现 reviewer 运行故障，建议一并记录：

```json
{
  "reviewer_failures": [
    {
      "reviewer": "Gemini-3.1-Pro-Preview",
      "round": 1,
      "failure_reason": "exit_code_1_after_mcp_startup",
      "resolved_by": "same_model_direct_rerun"
    }
  ]
}
```

用途：

- 区分“reviewer 真的 0 blocking”与“reviewer 实际未完成”
- 避免把 reviewer infra 问题误读成审查健康度

判定约束：

- 只有“无可用 verdict”“无 source-grounded judgment”“或 reviewer backend 无法完成源码级判断”才计入 `reviewer_failures`。
- MCP/discovery/runner/SSE 噪音若未阻止该 reviewer 最终给出可用 verdict，则不应记为 failure。
- 恢复策略默认优先 same-model rerun；若 agentic/live file-read 路径不稳定，可改用更宽的 embedded-source rerun packet，但不应缩回 diff-only 审查。
- reviewer 仍在正常运行且有望产出 verdict 时，不应因中间噪音而主动终止。

若本轮触及 public/package/CLI/workflow/default-entry surface，也可记录一项额外预防遥测：

```json
{
  "front_door_audit_performed": true
}
```

用途：

- 区分“front-door widening 只写在规则里”与“packet 准备时真的做了系统 audit”
- 为后续抽样审查提供最小证据，判断 packet omission 是偶发疏漏还是 audit 根本没执行

## 6. Derived Window Metrics

所有窗口指标都由第 4 节的 batch-level 字段派生。

推荐同时维护两个窗口：

- `短窗`：最近 10 个已完成 formal review 的 batch
- `长窗`：最近 30 个 batch，或最近 60 天

低样本说明：

- 当窗口内 batch 数 `< 3` 时，所有窗口 rate 默认只作信息性参考，不触发第 8 节红线
- 当窗口内 batch 数 `< 10` 时，应避免对单次尖峰做过度治理反应，优先做人工抽样复核

### 6.1 Final Zero-Blocking Rate

定义：

- `final_zero_blocking = true` 的 batch 数 / 已完成 formal review 的 batch 数

用途：

- 观察最终 closeout 是否大多稳定收敛

### 6.2 First-Round Blocking Rate

定义：

- `first_round_blocking = true` 的 batch 数 / 已完成 formal review 的 batch 数

用途：

- 观察 reviewer 对“初始提交版本”是否仍有真实拦截力

### 6.3 Amendment Yield

定义：

- `sum(amendments_total) / batch_count`

配套子指标：

- `Adopted Amendment Rate = sum(amendments_adopted) / sum(amendments_total)`

用途：

- 观察 reviewer 是否仍在提供有信息量的改进，而不是机械放行

### 6.4 Reopen Rate

定义：

- `reopened_later = true` 的 batch 数 / 已 closeout batch 数

用途：

- 这是最重要的事后真相指标之一

### 6.5 Post-Closeout Escape Rate

定义：

- `post_closeout_escape = true` 的 batch 数 / 已 closeout batch 数

用途：

- 捕捉“没有正式 reopen，但事实上原 batch 漏掉了”的情况

### 6.6 Reviewer Disagreement Rate

定义：

- `reviewer_disagreement = true` 的 batch 数 / 已完成 formal review 的 batch 数

用途：

- 观察多模型是否真的在独立审查，而不是都顺着 packet 叙事走

### 6.7 Packet Assumption Breach Rate

定义：

- `packet_assumption_breach = true` 的 batch 数 / 已完成 formal review 的 batch 数

用途：

- 观察 reviewer / self-review 是否真的会推翻 packet 前提

### 6.8 Self-Review Catch Rate

定义：

- `self_review_caught_new_issue = true` 的 batch 数 / 已完成 formal review 的 batch 数

用途：

- 观察 `self-review` 是否仍是实质门禁，而非形式总结

## 7. Interpretation Heuristics

### 7.1 健康信号

以下组合通常表示流程健康：

- `Final Zero-Blocking Rate` 高
- `Amendment Yield` 不低
- `Adopted Amendment Rate` 中高
- `Reopen Rate` 低
- `Post-Closeout Escape Rate` 低

含义：

- reviewer 常能提出有价值的 non-blocking amendments
- 但 closeout 后的真实逃逸仍然低

### 7.2 可疑偏松信号

以下组合需要复盘：

- `Final Zero-Blocking Rate` 很高
- `First-Round Blocking Rate` 很低
- `Amendment Yield` 很低
- `Reviewer Disagreement Rate` 很低
- 同时 `Reopen Rate` 或 `Post-Closeout Escape Rate` 上升

含义：

- formal review 可能过度接受 packet 叙事，或 tests/packet 过窄

### 7.3 可疑偏严信号

以下组合需要复盘：

- `First-Round Blocking Rate` 很高
- 许多 blocking 最终只是 comment-level / scope-level 小修
- `Reopen Rate` 和 `Post-Closeout Escape Rate` 仍然很低

含义：

- reviewer 可能把非阻塞问题过度升级为 blocking

## 8. Initial Red Lines

初始阈值采用保守、粗粒度标准：

- `Reopen Rate > 10%`
  - 必须复盘 formal review 是否失真
- `Post-Closeout Escape Rate > 15%`
  - 必须复盘 packet assumptions、tests、holdout、authority completeness 检查
- `Final Zero-Blocking Rate > 85%` 且 `Amendment Yield < 0.5 / batch`
  - 触发随机抽样源码审计，检查 formal review 是否“过于顺滑”
- `Reviewer Disagreement Rate < 10%` 连续两个长窗
  - 检查 reviewer 是否共享了过强先验，或 packet 是否喂入过满
- `Self-Review Catch Rate = 0` 连续两个长窗
  - 抽查 `self-review` 是否退化成复述 closeout

说明：

- 这里的 red line 是初始阈值，不是永久冻结阈值
- 若长窗复盘显示阈值过严或过松，可按第 2 节原则做小幅校准，但应在 checked-in 文档中更新

## 9. Operational Response

任一红线触发后，下一步不是立刻改 reviewer lineup，而是先做最小治理复盘：

1. 抽样最近 5 个 batch 的 review packet、review outputs、self-review、tracker note
2. 判断问题更像是：
   - packet assumptions 过强
   - tests / holdout / negative paths 过弱
   - reviewer 深度不足
   - self-review 退化
   - infra 故障被误读为审查结果
3. 只对真正失真的环节加严；避免全流程一刀切加重

## 10. Recording Guidance

最佳实践：

- 在 tracker note 中放一小段紧凑 JSON，便于后续程序化汇总
- 在 `self-review` 中解释 adopted / deferred / declined/closed 的原因
- 在 reviewer 故障时，明确记录失败原因与是否使用 fallback / rerun

不推荐做法：

- 只在聊天中说明这些指标
- 只在 `meta/.review/` 临时目录保留 reviewer 结果
- 手工维护窗口 rate，而不保留 per-batch 原始字段

## 11. Scope Boundary

本规范只定义“如何观察 review 健康度”，不改变：

- reviewer trio 的默认规则
- `CONVERGED` / `CONVERGED_WITH_AMENDMENTS` / `NOT_CONVERGED` 的收敛语义
- adopted / deferred / declined/closed 的处置逻辑
- 任何 acceptance、GitNexus、tracker、memory、版本控制门禁
