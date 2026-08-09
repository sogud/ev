# EV CLI

`ev` 提供受限的 `ev browser` 浏览器控制能力。它既可随 EV Desktop 使用，也可完全独立运行：

```text
ev CLI → Desktop 或 standalone Browser Host → EV Browser → Chrome CDP
```

CLI 优先复用正在运行的 EV Desktop Browser Host；如果 Desktop 不存在，会自动启动用户级 standalone Browser Host。CLI 不读取或显示 Bridge pairing token，也不直接 attach Chrome。Standalone Host 只会自动接受内置 allowlist 中的 EV Browser extension origin；自定义开发构建可通过 `EV_BROWSER_EXTENSION_ORIGINS` 显式追加 origin。Desktop 仍保留首次显式批准。

## 安装

全局 npm/Bun 包：

```bash
npm install --global @sogud/ev
# 或
bun install --global @sogud/ev
```

也可从 GitHub Release 下载当前平台的单文件程序，例如 `ev-darwin-arm64`，赋予执行权限后放入 `PATH`。EV Desktop 还会自动创建 `~/.ev/bin/ev` launcher，并将其加入内置 Pi Runtime 的 `PATH`。

## 使用

```bash
ev browser check
ev browser tabs.list --compact
ev browser page.snapshot --payload '{"tabId":123,"mode":"interactive"}' --compact
ev browser page.click --payload '{"tabId":123,"selector":"@e1"}' --compact
ev browser page.media --payload '{"tabId":123}' --compact
ev browser page.download --payload '{"tabId":123,"ref":"@m1"}' --compact
ev browser downloads.status --payload '{"downloadId":"local:UUID"}' --compact
ev browser page.screenshot --payload '{"tabId":123,"fullPage":true}' --output /tmp/page.png
```

Standalone Host 正常情况下无需管理；如需停止：

```bash
ev browser host stop
```

参数：

- `--payload <json>`：action 参数。
- `--payload-file <path>`：从 JSON 文件读取 action 参数。
- `--timeout <seconds>`：命令超时，最大 300 秒。
- `--compact`：输出单行 JSON。
- `--output <path>`：保存 `page.screenshot` 图片。

所有 action 都由 `@ev/contracts` 校验。`page.eval` 不可用；`page.upload` 只接受存在的绝对文件路径。下载需要先在 EV Browser Options 显式授权。直链资源使用 Chrome Downloads；非 DRM HLS/DASH 由 Browser Host 使用本地 `yt-dlp` 与 FFmpeg 处理；默认统一保存到 `~/Downloads/EV`。Native helper 的初始 URL、重定向和 playlist 子请求统一经过安全代理，拒绝访问 loopback、private、link-local 和 reserved 网络。

## 开发与打包

```bash
bun run --cwd apps/cli typecheck
bun run --cwd apps/cli test
bun run --cwd apps/cli build
bun run --cwd apps/cli build:standalone
bun run package:cli
```

`package:cli` 同时生成 npm tarball 和当前平台的单文件可执行程序。
