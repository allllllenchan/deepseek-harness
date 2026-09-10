# Agent Note: session-query reconcile 跳过不可索引日志并在启动时提交一次 reconcile

Status: implemented

[English](2026-09-15-session-query-reconcile-skips-unindexable-logs.md) | 中文

## 问题

读入时校验失败的会话日志会中止整个 SQLite 索引 reconcile。硬杀后的撕裂写在冷读时表现为 `seq gap in committed region`；该错误从 `_observeStable` 的按会话循环中重新抛出，reconcile 什么都没提交；由于 `_serialized` 把所有操作串在同一个队列后，后续每个搜索都会重跑同一个 reconcile 并以 `SESSION_QUERY_INDEX_FAILED` 失败。修复日志是恢复搜索的唯一途径，而索引无法指出是哪个日志出了问题。

在 `openAt: 'startup'` 部署上，同一个 reconcile 换成了与搜索时限赛跑：打开数据库句柄不提交任何东西，第一次全语料观测在第一次搜索的 `searchTimeoutMs` 内运行，超过该时限的语料中止、什么也不提交，并在之后每次搜索中重试。

## 决策

`SqliteSessionQueryEngine` 内两处有界修改：

- **不可索引的日志在单次观测尝试中跳过。** 单个持久会话的冷读、header 兼容检查与观测被包进 try；非中止的失败记日志 `skipping unindexable session log <id>: <reason>`，该会话在本次尝试不入索引。中止仍然传播，取消保持不写索引的性质。跳过按次生效：修复后的日志（新 persistence revision）在之后的 reconcile 中重读并入索引，无额外状态。
- **`openAt: 'startup'` 在句柄打开后提交一次完整 reconcile。** 失败只记日志、不致命；每次搜索仍照旧 reconcile——启动 reconcile 是主动快路径，不是新的失败点。

可见性：被跳过的会话不出现在全文搜索结果里，而 `listSessions` 由 persistence header 直接供给、不经索引——它仍然列出该会话，损坏日志在 header 层面保持可发现、可删除。

## 备选方案

**把失败 id 持久隔离**（用一张表抑制后续读取）。否决：粘性状态需要自己的失效契约（修复工具、revision 变化规则），而按次跳过已经收敛——修复的日志在下次 reconcile 回到索引，零额外状态。

**只让单个搜索失败而非整个 reconcile**（在 `searchSessions` 里 catch `_reconcile`）。否决：部分更新的 generation 会被当成功结果上报，且 `_serialized` 后排队搜索仍会重跑失败的 reconcile。

**把启动 reconcile 失败当致命。** 否决：启动不应依赖语料健康；搜索时的 reconcile 仍是兜底。

## 后果

索引构建与搜索可用性不再依赖每个日志的健康；一个损坏日志的代价只是它自己缺席搜索。失败的日志读以每次尝试一行 console 输出呈现，不再以类型化失败呈现——只看结构化错误的运维不再会看到之前那样指不出肇事者的 reconcile 中止。`openAt: 'startup'` 启动时执行原本发生在首次搜索的全语料读取，把该成本移到激活时；偏好旧时序的部署继续用 `first-search`。测试固定了损坏会话跳过、修复恢复、启动先于首次搜索的预热，以及持久化晚挂载时的启动重试。

## 验证

- `tests/sqlite.spec.ts`：按会话的粘性读故障让损坏会话不入索引、不出现在全文结果里，健康语料保持可搜；清除故障并提升 revision 后，下次 reconcile 重新索引。
- `tests/sqlite.spec.ts`：`openAt: 'startup'` 挂载引擎之后再附加重久化层，第一次搜索仍能索引持久语料。
