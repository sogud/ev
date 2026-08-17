# Context — EV Desktop 域词汇

> 架构评审与模块命名的字典。新词在评审/设计时就近补入。
> 交互决策的历史记录在 `docs/wayfinder/`，规格在 `docs/specs/`；本文件只收稳定域词。

## 域词

- **EV Server** — EV 的本地产品内核，拥有 Task、Runtime、持久化、Trace、Browser 集成和客户端契约；Desktop、Mobile 与 CLI 不拥有这些状态。
- **Client** — 通过 `@ev/contracts` 使用 EV Server 的交互端：Desktop Renderer、Mobile 和 CLI。Client 不直接加载 Runtime 或 Server Plugin。
- **EV Kernel** — Server 中最小的非插件 bootstrap：创建根 Cordis Context、挂载内置插件、报告启动失败并统一 shutdown；不承载业务能力。
- **Server Plugin** — Server 进程内静态导入的受信任生命周期单元，通过 Cordis 提供或消费 Service，并负责撤销自己创建的全部资源。不要简称为 Extension，避免与 Pi/Browser Extension 混用。
- **Task** — 一次用户工作的容器：标题、工作目录、绑定 Runtime、Transcript、Trace。sidebar 平铺展示。
- **Runtime** — 执行引擎（Pi / Codex / Claude Code / Qoder / DSH），经 `AgentRuntimeAdapter` 契约接入；
  用户心智中的「Agent」即 Runtime（2026-08-06 定案，Agent Project 层已退役）。
- **RuntimeSession** — Runtime 的原生会话引用（runtimeId + nativeId + sessionFile），EV 不复制会话正文。
- **Task 会话生命周期** — Task 绑定 RuntimeSession 的替换、锁定与原生会话所有权仲裁规则：
  首条消息前可换引擎（丢弃未起跑会话重建），首条消息后锁定；同一原生会话不能被两个 Task 占用。
  承载模块：`apps/server/src/task-session-lifecycle.ts`（2026-08 深化评审后并入 TaskSession）。
- **TaskSession** — EV 侧每 Task 的深 module（2026-08-10 架构评审定案）：owns RuntimeSession、
  Transcript/Trace 投影与状态机，自持久化（共享 Store），对外同步 snapshot + subscribe；
  所有权仲裁规则在此，跨 Task 的 OwnerIndex 数据留 registry（AgentService）。
  不与 **RuntimeSession**（原生会话引用）混用；旧 `TaskRuntime` interface 退化为它的内部状态。
- **Transcript** — Task 的消息流（user/assistant/thinking/tool/error），由 Runtime 事件投影而来。
- **Trace** — Task 的过程事件流（tool/model/retry/error），检查器（Inspector）消费。
- **BrowserRun** — 一次有界浏览器计划的本地执行：Browser Host 持有顺序、循环、重试、语义定位和失败汇总，只向 Agent 返回最终结果；Extension 仍只执行 typed 原子 action，不执行任意页面 JavaScript。
- **BrowserSession** — Browser Host 内存中的 Agent 浏览器所有权：创建专属非聚焦 Chrome window、持有 owned tabs，并只在显式 adopt 后借用用户 tab；release 只关闭 owned tabs，绝不关闭 borrowed 或未知 tab。
- **SiteRecipe** — 经过显式审批、限定精确域名/路径的站点经验数据；只配置已编译的 typed adapter，draft 永不自动启用，也不能携带脚本、任意 BrowserRun plan 或 Chrome 调用。
- **Client 契约** — Server 与 Client 之间的 call/event 声明和 wire schema，唯一真源位于 `packages/contracts`；Server 通过 HTTP/WebSocket 暴露，Desktop、Mobile 与 CLI 使用同一契约。

## 已退役概念

- **Agent Project**（`.agent/agent.yaml`）— 2026-08-06 退役：工作区/指令/资源不再由 EV 管理。
  未来探索者不要复活；若需 per-project 默认值，重新提案。
- **Evals** — 同日删除的独立自测循环；如需回归能力，重新提案。
