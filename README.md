# EV — Enhanced Vigilance

EV 是各种 Agent 与各种工具的 **UI 表达层**：不自研 Agent 运行时，为可插拔的 runtime（Pi、Codex，后续 Claude Code / Qoder 等）与通用工具（浏览器控制、媒体下载，后续 git / terminal 等）提供统一、精致的交互表达。个人拥有、本地优先；桌面端通过 CLI 进程适配 runtime，浏览器扩展负责书签、页面上下文和浏览器内交互。

## Monorepo

```text
apps/
├── desktop/             # Electron 桌面端与 Pi runtime host
├── browser-extension/   # Chrome Manifest V3 扩展与 CDP 执行端
└── cli/                 # Desktop bundled / npm / standalone `ev` CLI
packages/
├── browser-host/        # Desktop 与 standalone CLI 共享的 Bridge、Socket 和下载宿主
├── contracts/           # 跨应用消息与数据契约
└── design-tokens/       # Desktop 与 Browser 共享主题、密度和语义 token
skills/
└── ev-browser/          # 默认加载的浏览器操作 Skill
```

Desktop 是任务编排、Trace 和 CLI Runtime Process Host；Pi、Codex、Claude Code 与 Qoder 分别拥有自己的原生会话历史、认证和执行语义。Browser Extension 不保存模型密钥，也不直接执行任意本地命令。浏览器能力由共享的 `@ev/browser-host` 提供：Desktop 运行时 CLI 复用其 Host，没有 Desktop 时 CLI 自动启动 standalone Host。两种模式都只监听 `127.0.0.1`，Extension 地址固定且凭据不暴露给 Agent；Desktop 首次配对需要用户批准，standalone 模式自动接受本机可信扩展。浏览器页面动作由扩展通过 Chrome CDP 执行；Pi 和其他 Agent Runtime 统一使用 `ev browser` CLI 与 `ev-browser` Skill。Agent 可先取得页面资源 `@mN` refs，再把明确选择的直链图片/视频或非 DRM HLS/DASH 流下载到 `Downloads/EV`。Desktop 与 Browser 共同使用 `@ev/design-tokens`，支持跟随系统、浅色和深色主题。

## 开发

要求：Bun 1.x、Node.js 22.19+。

```bash
bun install
bun run dev:desktop
bun run dev:extension

# Desktop 可选；不存在时 CLI 自动启动 standalone Browser Host
bun run --cwd apps/cli build:standalone
apps/cli/dist/ev-$(node -p "process.platform+'-'+process.arch") browser check
```

完整验证：

```bash
bun run verify
```

## 远程与手机

- `ev remote on|off|status`：开启后 server 绑定 localhost + 本机私网地址（LAN/ Tailscale，永不 0.0.0.0），`ev server status` 给出 lanUrl/tailscaleUrl 与安全提示。
- `ev token create --tier observer|operator` / `ev token list` / `ev token revoke <id>`：非 localhost 一律要 token；observer 只读，mutation 403。
- 手机访问 `http://<host>:<port>/m/?port=<port>&token=<token>`：独立 React entry，仅任务列表/对话/切模型；桌面 UI 零改动。

## 发布

根 `package.json` 是版本号的单一事实源，正式发布时 Desktop 和 Browser Extension 使用同一版本。

```bash
# 只查看下一版本和操作计划
bun run release --dry-run patch

# 验证、更新版本、创建提交和 Tag，并原子推送
bun run release patch
```

发布脚本要求 `master` 工作树干净且与 `origin/master` 同步。推送 `v*` Tag 后，GitHub Actions 会重新验证项目，生成 Desktop DMG/ZIP、Chrome/Firefox Extension ZIP、npm CLI tarball、当前平台 standalone CLI、SHA-256 checksums 和 GitHub Release。可使用 `--no-push` 只创建本地提交与 Tag。

当前 macOS 产物尚未配置 Apple Developer 签名和 notarization。

应用说明：

- [Desktop](./apps/desktop/README.md)
- [Browser Extension](./apps/browser-extension/README.md)
- [CLI](./apps/cli/README.md)

Desktop 会自动读取 `~/.pi/agent/sessions/` 中的 Pi 历史和 Codex app-server 的原生 threads。新任务可选择 Pi、Codex CLI、Claude Code 或 Qoder；首条消息前可切换 Runtime，之后固定。

改造前的 in-process Pi SDK 源码可从 Git tag `archive/sdk-runtime-2026-08-04` 查看。

产品与工程知识：

- [Desktop Design System](./docs/desktop-design-system.md)
- [Agent Runtime Adapters](./docs/agent-runtime-adapters.md)

后续功能和优先级见 [docs/specs/roadmap.md](./docs/specs/roadmap.md)。
