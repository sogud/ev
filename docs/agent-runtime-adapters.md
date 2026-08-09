# EV Agent Runtime Adapters

## Status

Pi RPC、Codex app-server、Claude Code 与 Qoder 已实现（后两者共用 claude-family stream-json 适配）。Pi 是默认 Runtime。

改造前的 in-process Pi SDK 版本保存在 Git tag：

```text
archive/sdk-runtime-2026-08-04
```

## 目标与边界

Runtime、Provider 和 Model 是不同概念：

- Runtime 决定实际执行引擎。
- Agent Project 已退役：工作区、指令与资源不再由 EV 管理，任务直接使用当前工作目录与各 CLI 的原生配置。
- Provider/Model 控件只在 Runtime 声明确实支持时显示。
- Pi、Codex 各自拥有原生 session、认证和配置；EV 不复制对话正文或 CLI 凭据。

首条消息前可切换 Runtime（setRuntime 丢弃未起跑会话重建）；对话开始后固定。不同 Runtime 的 session 不能原地互换。

## 插件化分层

- **L1 接口插件化（当前）**：`AgentRuntimeAdapter` 是插件契约（describe/listSessions/createSession/
  resumeSession/dispose），`RuntimeRegistry` 负责注册与去重。UI 只认 descriptor 与 capabilities，
  不认具体 runtime（glyph/名称/版本/能力全部由 adapter 自报）。
- **L2 包插件化（第 3 个 adapter 落地时）**：每个 adapter 独立成包
  （`packages/runtime-pi` / `runtime-codex` / …），独立测试与迭代；registry 仍显式 import。
- **L3 动态加载（暂缓，可能永不需要）**：插件目录发现、版本协商、进程沙箱。个人产品成本大于收益；
  `@ev/contracts` 已固定 wire schema，将来升级不破坏 L1/L2。

### 增加一个 runtime 的清单（L1）

1. 新建 `main/runtime/<id>-adapter.ts`，实现 `AgentRuntimeAdapter`；事件映射成 `@ev/contracts` 的 `RuntimeEvent`。
2. 在 `main/index.ts` 注册一行；descriptor 自报 `name/glyph/version/message/capabilities`。
3. 补 adapter 单测（事件映射、describe、能力降级）。
4. UI 零改动：rail/trigger/设置健康行/能力门控全部由 descriptor 驱动。

## 实际架构

```text
Renderer
  │ typed IPC
  ▼
AgentService / Task orchestration
  │
  ├── RuntimeRegistry
  │     ├── PiRpcAdapter
  │     │     └── pi --mode rpc
  │     └── CodexAppServerAdapter
  │           └── codex app-server --listen stdio://
  │
  └── RuntimeEvent → Transcript / Trace projection
```

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

跨 Renderer/Main 的 RuntimeId、Descriptor、SessionRef 和 Event 由 `@ev/contracts` 使用 Zod 校验。

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

EV Store 只保存 EV-owned task metadata、Trace 和隐藏项，不保存原生会话正文。旧 EV task 缺少 Runtime 时按 Pi 迁移，并通过 session file 与 Pi catalog 对齐。

## Process Host

`JsonlProcess` 是 Pi 与 Codex 的共享进程边界：

1. 只启动已注册的 `pi` 或 `codex`，Renderer 不能传任意 executable。
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
```

## Runtime 差异

| Runtime | Transport                 | 历史目录         | 当前 UI 能力                             |
| ------- | ------------------------- | ---------------- | ---------------------------------------- |
| Pi      | 官方 RPC JSONL            | 全部 Pi sessions | model、thinking、tools、resume、stream   |
| Codex   | app-server JSON-RPC/JSONL | thread/list      | resume、stream、tools、workspace sandbox |

Codex 第一版固定使用 `workspace-write` sandbox 与 `approvalPolicy: never`：不会弹出无法处理的 CLI 交互，也不会绕过 sandbox。Codex model/effort 协议已保留，但在完成原生 model catalog UI 前不显示 Pi 的 Provider/Model 控件。

Pi Skills/Extensions 不自动映射成 Codex Skills。两种 Runtime 都会继承 EV CLI 的 PATH，因此可以调用 `ev browser`；更完整的 Codex browser skill 分发需要单独设计。

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

Fake protocol fixtures覆盖 LF chunk、Unicode 行分隔符、损坏/结构化事件边界和进程退出。真实 smoke 产生的临时 Pi/Codex session 均已清理。

## 下一步

1. 实现 Codex 原生 model/effort catalog 与审批 UI，再开放对应 controls。
2. 加入同一 session 的并发写入检测；活跃于其他 Pi/Codex 客户端时默认只读或 fork。
3. 接入 Claude Code 的稳定 structured protocol。
4. 对 Qoder 先验证 headless、stream、resume 和 cancel；缺少稳定协议时保持 unsupported。

## 明确不做

- Renderer 直接 spawn CLI。
- 用户输入任意 executable、参数或 shell script。
- 把 Codex 强行伪装成 Pi Provider。
- 在活跃任务中无损切换 Runtime。
- 复制 CLI 凭据或对话正文到 EV Store。
- 解析面向人的彩色 TUI 文本。
