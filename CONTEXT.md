# Context — EV Desktop 域词汇

> 架构评审与模块命名的字典。新词在 grilling/设计时就近补入。
> 交互决策的历史记录在 `docs/wayfinder/`，规格在 `docs/specs/`；本文件只收稳定域词。

## 域词

- **Task** — 一次用户工作的容器：标题、工作目录、绑定 Runtime、Transcript、Trace。sidebar 平铺展示。
- **Runtime** — 执行引擎（Pi / Codex / Claude Code / Qoder），经 `AgentRuntimeAdapter` 契约接入；
  用户心智中的「Agent」即 Runtime（2026-08-06 定案，Agent Project 层已退役）。
- **RuntimeSession** — Runtime 的原生会话引用（runtimeId + nativeId + sessionFile），EV 不复制会话正文。
- **Task 会话生命周期** — Task 绑定 RuntimeSession 的替换、锁定与原生会话所有权仲裁规则：
  首条消息前可换引擎（丢弃未起跑会话重建），首条消息后锁定；同一原生会话不能被两个 Task 占用。
  承载模块：`apps/desktop/src/main/task-session-lifecycle.ts`（TaskSessionLifecycle）。
- **Transcript** — Task 的消息流（user/assistant/thinking/tool/error），由 Runtime 事件投影而来。
- **Trace** — Task 的过程事件流（tool/model/retry/error），检查器（Inspector）消费。
- **IPC 契约** — main 与 renderer 之间的通道声明（call/event），唯一处 `shared/ipc-registry.ts`；
  main 按它注册 handler、preload 按它生成 API、emit 按它取通道串。承载模块：TaskSessionLifecycle 等经它暴露。

## 已退役概念

- **Agent Project**（`.agent/agent.yaml`）— 2026-08-06 退役：工作区/指令/资源不再由 EV 管理。
  未来探索者不要复活；若需 per-project 默认值，重新提案。
- **Evals** — 同日删除的独立自测循环；如需回归能力，重新提案。
