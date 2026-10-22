# Agent Note: 非法的实时工具参数交给工具处理，而不是让回合失败

Status: implemented

[English](2026-10-22-tolerate-malformed-live-tool-arguments.md) | 中文

## Problem

DeepSeek Messages 响应里流式拼出的工具参数不是合法 JSON 时，整个回合会以 `MALFORMED_RESPONSE` 结束。会话日志里有两种形态：长中文参数串里未转义的 ASCII 引号，以及模型在完整 JSON 对象之后追加自己的原生工具标记。连续三个回合都因为同一个工具调用失败，而 `MALFORMED_RESPONSE` 不在默认可重试码集合里。

适配器是生产代码里唯一为"合法性"解析工具参数的地方。下游每个消费者本来就容忍非法文本：agent loop 原样保留它供工具自己的 schema 校验，Messages 序列化对非法或非对象的历史参数发送 `{}`。

## Decision

[translate.ts](../../../../packages/llm/llm-deepseek/src/translate.ts) 不再解析已完成的工具参数。参数逐字节进入组装后的 assistant 消息，工具 schema 校验把不可用的值变成 `INVALID_ARGS` 工具结果，模型在同一回合内读到它并纠正。

协议校验保留：块顺序、块索引、工具身份、停止原因和 SSE 分帧仍以 `MALFORMED_RESPONSE` 失败。`max-tokens` 截断仍由共享组装器丢弃工具调用。

## Alternatives considered

- **像 `max-tokens` 那样丢弃不可执行的调用。** 消息里就没有工具调用了，agent loop 会把回合判为 completed，模型本来要做的事无声消失。
- **把参数修复成 `{}`。** 那是虚构一次模型没发过的调用；参数全 optional 的工具会真的执行它。
- **把 `MALFORMED_RESPONSE` 加进可重试码。** 重试不携带纠错信号，而且该 code 还覆盖重试无法修复的协议损坏。
- **做成默认严格的 Config 开关。** 那是上游可接受的形态；本次部署直接翻转默认值，因为激活开关需要修改 live 的 `~/.dsh` profile。

## Consequences

一次坏调用只花掉一次 `INVALID_ARGS` 往返，而不是整个回合；同一个响应里一个不可用的调用也不再连坐另一个可用的调用。失败不再表现为 `turn/end` 的 error：回合完成，证据是工具结果加上 Session 日志里的原始参数。这些原始参数会留在 assistant 消息、`tool/call` 事件和工具结果里，客户端可能渲染一次很长的不可用参数块。下一个请求序列化时会按既有规则把该历史调用降级成 `{}`，与外来历史的处理一致。

这与上游"新生成的工具参数必须是合法 JSON 对象"的契约相反，上游自己的测试断言了那次拒绝。在 `finish` 之前恢复参数可完成性校验即是回退方式。
