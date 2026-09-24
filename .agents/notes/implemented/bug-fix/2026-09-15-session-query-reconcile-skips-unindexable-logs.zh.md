# Agent Note: session-query reconcile 跳过不可索引日志并在启动时提交一次 reconcile

Status: implemented

[English](2026-09-15-session-query-reconcile-skips-unindexable-logs.md) | 中文

## 问题

读入时校验失败的会话日志会中止整个 SQLite 索引 reconcile。硬杀后的撕裂写在冷读时表现为 `seq gap in committed region`；该错误从 `_observeStable` 的按会话循环中重新抛出，reconcile 什么都没提交；由于 `_serialized` 把所有操作串在同一个队列后，后续每个搜索都会重跑同一个 reconcile 并以 `SESSION_QUERY_INDEX_FAILED` 失败。修复日志是恢复搜索的唯一途径，而索引无法指出是哪个日志出了问题。

在 `openAt: 'startup'` 部署上，同一个 reconcile 换成了与搜索时限赛跑：打开数据库句柄不提交任何东西，第一次全语料观测在第一次搜索的 `searchTimeoutMs` 内运行，超过该时限的语料中止、什么也不提交，并在之后每次搜索中重试。

## 决策

`SqliteSessionQueryEngine` 内两处有界修改：

- **不可索引的日志按 revision 跳过。** 单个持久会话的冷读、header 兼容检查与观测被包进 try；非中止的失败把 `(sessionId, revision, reason)` 记进引擎进程内的不可索引表，该会话不入索引。中止仍然传播，取消保持不写索引的性质。之后的 reconcile 在该产物保持同一 revision 时跳过读取——同样的字节不可能得出不同判定，而带不可读历史的语料库否则会在**每次搜索**上重复付出这些失败读取。修复或追加过的日志带新 revision，会被重读，并清掉自己那条记录。
- **`openAt: 'startup'` 把一次完整 reconcile 排到串行队列尾部。** 激活只打开句柄（那才是就绪边界），把全语料回填排进 `_serialized` 而不在激活里等它：进程启动不再为一次全语料读取买单，而回填期间到达的搜索会排在这次 reconcile 之后，而不是在自己的时限内自行建索引。reconcile 失败只记日志、不致命；每次搜索仍照旧 reconcile——启动那次是主动快路径，不是新的失败点。

被跳过的日志以**每轮 reconcile 一行告警**报告（计数、至多三个 id、第一条原因）：语料里有几百个不可读日志时，启动付出一行、之后保持安静。

可见性：被跳过的会话不出现在全文搜索结果里，而 `listSessions` 由 persistence header 直接供给、不经索引——它仍然列出该会话，损坏日志在 header 层面保持可发现、可删除。

## 备选方案

**把失败 id 持久隔离**（用一张表抑制后续读取）。否决：持久状态需要自己的失效契约（修复工具、revision 变化规则、schema 迁移），而进程内按 revision 的记忆已经消除了同一进程内的重复成本、并在重启间收敛——修复的日志在下次 reconcile 回到索引。该记忆的代价是：由同一份未变字节上的瞬时故障造成的失败，要等到下一个进程才会重试。

**只让单个搜索失败而非整个 reconcile**（在 `searchSessions` 里 catch `_reconcile`）。否决：部分更新的 generation 会被当成功结果上报，且 `_serialized` 后排队搜索仍会重跑失败的 reconcile。

**把启动 reconcile 失败当致命。** 否决：启动不应依赖语料健康；搜索时的 reconcile 仍是兜底。

## 后果

索引构建与搜索可用性不再依赖每个日志的健康；一个损坏日志的代价只是它自己缺席搜索，外加首次尝试它的那一轮里的一行输出。失败的日志读以一行聚合告警呈现，不再以类型化失败呈现——只看结构化错误的运维不再会看到之前那样指不出肇事者的 reconcile 中止。`openAt: 'startup'` 把全语料读取移成激活时排队的一次回填：启动立即继续，索引在排在它之后的第一次搜索之前提交，而偏好旧时序的部署继续用 `first-search`。测试固定了损坏会话跳过、被拒 revision 不重读、修复恢复、启动先于首次搜索的预热，以及持久化晚挂载时的启动重试。

## 验证

- `tests/sqlite.spec.ts`：按会话的粘性读故障让损坏会话不入索引、不出现在全文结果里，健康语料保持可搜；被拒的 revision 只读一次，之后的搜索不再读它；清除故障并提升 revision 后，下次 reconcile 重新索引。
- `tests/sqlite.spec.ts`：`openAt: 'startup'` 挂载引擎之后再附加持久化层，第一次搜索仍能索引持久语料；而在挂载前就附加持久化层时，同一次搜索复用已提交的行，日志恰好只被读一次。
