# EV Agent Runtime Adapters

## Status

Pi RPC、Codex app-server、Claude Code 与 Qoder 已实现（后两者共用 claude-family stream-json 适配）。DeepSeek Harness 以 Experimental stdio JSON-RPC adapter 接入。五个 adapter 已由 `cordis@4.0.0-rc.8` 的静态 Runtime plugins 挂载；Pi 是默认 Runtime。

改造前的 in-process Pi SDK 版本保存在 Git tag：

```text
archive/sdk-runtime-2026-08-04
```

## 目标与边界

Runtime、Provider 和 Model 是不同概念：

- Runtime 决定实际执行引擎。
- Agent Project 已退役：工作区、指令与资源不再由 EV 管理，任务直接使用当前工作目录与各 CLI 的原生配置。
- Provider/Model 控件只在 Runtime 声明确实支持时显示。
- 各 Runtime 拥有自己的 session、认证和配置；EV 不复制对话正文或 CLI 凭据。

首条消息前可切换 Runtime（setRuntime 丢弃未起跑会话重建）；对话开始后固定。不同 Runtime 的 session 不能原地互换。

## Server 插件架构

[ADR-0001](adr/0001-compose-server-with-static-cordis-plugins.md) 已决定用精确锁定的 upstream Cordis 组合 EV Server。第一阶段仅挂载代码内显式 import 的内置插件；不启用 Cordis Loader、Include、HMR、插件目录扫描、运行时 npm 安装或 Renderer 提供的模块路径。完整约束见 [Server Plugin Architecture v1](specs/server-plugin-architecture-v1.md)。

`AgentRuntimeAdapter` 是第一条已有的真实 seam（describe/listSessions/createSession/resumeSession/dispose），`RuntimeRegistry` 负责注册、查找和释放。Runtime tracer 将 registry 变成 Cordis Service，并把 Pi、Codex、Claude Code、Qoder、DSH 分别挂载为内置 Server Plugin。UI 仍只认 descriptor 与 capabilities，不认具体 Runtime 实现。

### 增加一个 Runtime 的清单

1. 在 Server runtime 目录新增 adapter，实现 `AgentRuntimeAdapter`；事件映射成 `@ev/contracts` 的 `RuntimeEvent`。
2. 新增静态 Runtime plugin，通过 registry Service 的可逆 Effect 注册 adapter。
3. 把 plugin 加入唯一 built-in composition；不创建第二个插件清单。
4. 补 adapter 协议测试和 plugin 注册/卸载测试。
5. UI 零改动：rail、trigger、设置健康行和能力控制全部由 descriptor 驱动。

## 实际架构

```text
Desktop / Mobile / CLI
  │ @ev/contracts over HTTP + WebSocket
  ▼
EV Server
  ├── EV Kernel / Cordis Context
  │     └── RuntimeRegistry Service
  │           ├── Pi Runtime Plugin → PiRpcAdapter → pi --mode rpc
  │           ├── Codex Runtime Plugin → CodexAppServerAdapter → codex app-server
  │           ├── Claude Runtime Plugin ┐
  │           ├── Qoder Runtime Plugin  ┴→ ClaudeFamilyAdapter → stream-json
  │           └── DSH Runtime Plugin → DshRuntimeAdapter → stdio JSON-RPC
  └── AgentService / TaskSession → RuntimeEvent → Transcript / Trace
```

Runtime plugin Fiber 拥有 adapter 注册 Effect。单个 Fiber unload 只移除并释放自己的 adapter；Server shutdown 先释放 TaskSession，再由 EV Kernel 释放 Runtime plugins。Descriptor 顺序取自 `RuntimeIdSchema`，不依赖 Cordis plugin 激活顺序。

公共 seam 保持最小：

```ts
interface AgentRuntimeAdapter {
  describe(): Promise<RuntimeDescriptor>;
  listSessions(): Promise<RuntimeSessionRecord[]>;
  createSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(input: RuntimeSessionInput & { session: RuntimeSessionRef }): Promise<RuntimeSession>;
}

interface RuntimeSession {
  prompt(text: string): Promise<void>;
  promptAndWait(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}
```

跨 Renderer/Server 的 RuntimeId、Descriptor、SessionRef 和 Event 由 `@ev/contracts` 使用 Zod 校验。

## 原生历史是单一事实源

### Pi

- 目录：`~/.pi/agent/sessions/`
- 目录索引：`SessionManager.listAll()`
- 执行与恢复：`pi --mode rpc --session <jsonl>`
- Transcript：RPC `get_messages` 和流式 events

### Codex

- 目录索引：app-server `thread/list`
- 新建与恢复：`thread/start`、`thread/resume`
- 执行与取消：`turn/start`、`turn/interrupt`
- Transcript：`item/*` 与 `turn/*` notifications

### DeepSeek Harness（Experimental）

- 存储：`DSH_SESSION_ROOT` 下的 DSH append-only session log
- 新建与流式事件：SDK `initialize`、`session/prompt`、`session.event`、`session.status`
- 停止：关闭该 Task 独占的 DSH 进程，并把 Task 标记为终态 error；继续工作必须新建 Task
- 冷恢复：官方 SDK 当前不提供 list/resume；EV 明确返回 unavailable，不解析 DSH 私有日志

EV Store 只保存 EV-owned task metadata、Trace 和隐藏项，不保存原生会话正文。旧 EV task 缺少 Runtime 时按 Pi 迁移，并通过 session file 与 Pi catalog 对齐。

## Process Host

`JsonlProcess` 是各 JSONL/JSON-RPC Runtime 的共享进程边界：

1. 只启动已注册 Runtime 的受控 executable；Renderer 不能传 executable 或 argv。
2. 使用参数数组、`shell: false` 和任务固定 cwd。
3. 子进程 PATH 自动检测用户登录 shell（`$SHELL -ilc 'printf %s "$PATH"'`，带超时和进程内缓存），覆盖 nvm、Homebrew、npm prefix 等；检测失败时回退固定目录列表。
4. 严格按 LF (`\n`) 解码 JSONL，不使用 Node `readline`。
5. 单条记录、stderr 和请求等待均有上限。
6. 原生输出视为不可信；进入 UI 前投影为受限 `RuntimeEvent`。
7. 先使用协议取消；进程释放采用 TERM → 有界等待 → KILL。
8. CLI 认证和配置由各 Runtime 自己管理。

可执行文件默认从 PATH 和固定用户级目录发现；开发或受控部署可设置：

```text
EV_PI_CLI=/absolute/path/to/pi
EV_CODEX_CLI=/absolute/path/to/codex
EV_DSH_RUNTIME=/absolute/path/to/dsh-jsonrpc-agent
EV_DSH_CONFIG=/absolute/path/to/cordis.yml
```

## Runtime 差异

| Runtime             | Transport                 | 历史目录                   | 当前 UI 能力                                            |
| ------------------- | ------------------------- | -------------------------- | ------------------------------------------------------- |
| Pi                  | 官方 RPC JSONL            | 全部 Pi sessions           | model、thinking、tools、resume、stream                  |
| Codex               | app-server JSON-RPC/JSONL | thread/list                | resume、stream、tools、workspace sandbox                |
| Claude Code / Qoder | stream-json               | 原生 JSONL                 | stream、tools；resume 仍需真实会话验收                  |
| DSH Experimental    | SDK JSON-RPC/JSONL        | `DSH_SESSION_ROOT`，不扫描 | stream、thinking、tools、subagent Trace；无 cold resume |

Codex 第一版固定使用 `workspace-write` sandbox 与 `approvalPolicy: never`：不会弹出无法处理的 CLI 交互，也不会绕过 sandbox。Codex model/effort 协议已保留，但在完成原生 model catalog UI 前不显示 Pi 的 Provider/Model 控件。

Runtime 之间不自动映射 Skills。Runtime 子进程继承 EV CLI 的 PATH，因此可以调用 `ev browser`；DSH 的 Cordis composition 由 `EV_DSH_CONFIG` 指定，EV 不提供任意 plugin 或 MCP 安装入口。

## UI 规则

- Runtime Picker 与 Model Picker、思考强度 Picker 分开（Agent Project 已退役）。
- Runtime 首条消息前可切换；首条消息后锁定，任务行显示固定 Runtime 标识。
- 设置页保存默认 Runtime。
- Runtime 缺失时显示版本/安装状态，不自动安装。
- 不支持的 Model/Thinking 控件隐藏，而不是伪造统一能力。

## 已验证版本

本地 smoke：

- Pi CLI `0.82.1`：RPC state、catalog、history resume
- Codex CLI `0.145.0`：app-server initialize、thread catalog、resume、real turn
- DeepSeek Harness source `47f943859bef60e4160492346772ded9b24f765a` / SDK server `0.0.1`：两个独立 Runtime 进程、local mock model、stream、stop、shutdown、Zstandard session persistence

Fake protocol fixtures覆盖 LF chunk、Unicode 行分隔符、损坏/结构化事件边界、DSH response 前成功/失败、receipt-before-idle、必需/可忽略事件和进程退出。Server SIGTERM smoke 覆盖 active prompt 与 in-flight initialize，均等待 DSH shutdown 和子进程退出。真实 DSH smoke 的 EV/DSH/HOME/session/workspace 均使用临时目录并已移入 `~/.Trash`。

## 下一步

1. 实现 Codex 原生 model/effort catalog 与审批 UI，再开放对应 controls。
2. 加入同一 session 的并发写入检测；活跃于其他 Pi/Codex 客户端时默认只读或 fork。
3. 完成 Claude Code/Qoder 真实 cold resume 和 cancel 验证。
4. DSH 官方 SDK 提供 per-session cancel 与 cold list/resume 后，重新审查协议并决定是否移除 Experimental 标记。

## 明确不做

- Renderer 直接 spawn CLI。
- 用户输入任意 executable、参数或 shell script。
- 把 Codex 强行伪装成 Pi Provider。
- 在活跃任务中无损切换 Runtime。
- 复制 CLI 凭据或对话正文到 EV Store。
- 解析面向人的彩色 TUI 文本。
