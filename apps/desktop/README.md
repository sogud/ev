# EV — Enhanced Vigilance

EV 是一个个人拥有、本地优先的桌面 Agent。它通过受控 CLI Process Host 使用 Pi RPC、Codex app-server 与 Claude/Qoder stream-json 协议，并负责统一的任务体验、Trace 和 Inspector。

当前目标不是自研模型适配层，也不是搭建云端 Agent 平台，而是先把可靠、透明、可检查的个人桌面 Agent 做好。

## 当前能力

- macOS Electron 桌面端
- Pi / Codex / Claude Code / Qoder 四种 Runtime，对话框下方 chip 行切换（首条消息前可换，之后锁定）
- 自动列出各 Runtime 的原生历史会话
- 多任务并行和独立 Runtime session
- OpenAI、Anthropic、Google 等模型与服务商认证
- 自定义 OpenAI、Anthropic 和 Google 兼容服务商
- Trace、工作区变更 Inspector
- 首次启动自动创建并使用 `~/.ev/workspace`，无需 Onboarding
- 默认工作目录和每任务独立目录
- 仅监听 `127.0.0.1` 的 EV Browser WebSocket Bridge
- 用户级本地 Socket 与随 App 打包的 `ev browser` CLI
- 直链图片/视频与非 DRM HLS/DASH 流媒体下载，统一保存到 `Downloads/EV`
- 默认加载的 `ev-browser` Skill
- 可视化配对、凭据撤销和实时连接状态
- 基于共享 semantic tokens、Base UI primitives 和 cmdk 的 Desktop Design System
- 跟随系统、浅色和深色主题，并同步 macOS 原生窗口外观
- 紧凑的 Runtime / 模型 / 思考强度选择器（Base UI + cmdk）

设计规范、组件行为与 Codex 静态分析证据见 [Desktop Design System](../../docs/desktop-design-system.md)。

## 开发

要求：pnpm ≥ 10、Node.js 22.19+。运行 Pi/Codex 任务时，相应 CLI 需已安装并完成自身登录；也可通过 `EV_PI_CLI` 或 `EV_CODEX_CLI` 指定受信任的可执行文件。

```bash
pnpm install
pnpm run dev
```

常用命令：

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack
```

`pnpm run pack` 会在 `release/<version>/mac-arm64/EV.app` 生成本地 macOS 应用，并把 CLI 与 Browser Skill 放入 App Resources。Desktop 启动时会在 `~/.ev/bin/ev` 创建只供当前用户使用的 launcher，并把该目录加入内置 Pi Runtime 的 `PATH`。

完成 EV Browser 配对后可以直接检查浏览器控制链路：

```bash
~/.ev/bin/ev browser check
~/.ev/bin/ev browser tabs.list --compact
```

## 数据

- Pi 对话正文保存在 `~/.pi/agent/sessions/`，Codex 对话正文由 Codex 原生 thread/session 存储管理；EV 不复制会话正文。
- EV 用户数据目录只保存 Runtime/session 关联、Trace、隐藏项和 Browser 配对凭据。
- 图形应用没有可靠的启动 CWD，因此默认工作空间固定为 `~/.ev/workspace`；可在“设置 → 通用”中修改。
- 历史任务引用的目录被移动或删除时，任务会标记为不可用，但不会阻断应用启动。
- 首次批准 EV Browser 时由 Desktop 自动生成 Pairing token；token 不显示给用户或 Agent，也不写入仓库或日志，系统安全存储可用时以加密形式持久化。
- Pi 与 Codex 的模型配置和认证继续由各自 CLI 管理，EV 不复制 API Key。

## 开发方向

后续功能和优先级见仓库根目录的 [roadmap](../../docs/specs/roadmap.md)。Pi 继续作为默认 Runtime；Codex CLI、Claude Code 和 Qoder CLI 的接入边界见 [Agent Runtime Adapters](../../docs/agent-runtime-adapters.md)。通用本地 API、复杂权限和多 Agent 协作暂不属于第一版。
