# EV Browser

EV Browser 是 EV 的浏览器应用，基于 WXT、Vite、React、TypeScript 和 Chrome Manifest V3。

当前能力：

- Chrome 书签浏览与搜索
- 简洁的新标签页工作区、常用网站和扁平书签列表
- 本地整页背景图、背景强度和一键清除
- Popup、Options 和替换新标签页
- 与 EV Desktop 共享的紧凑 Design Tokens
- 跟随系统、浅色和深色主题
- 基于 Base UI 的非原生菜单选择器

扩展内置基于 `@ev/contracts` 的本机 Browser Host WebSocket bridge，以及经过类型校验的浏览器操作路由。通信层包含自动发现、配对握手、心跳、自动重连和请求关联。Host 可以来自 EV Desktop，也可以由独立 `ev` CLI 自动启动。

当前支持：

- 标签页列表、打开、关闭和激活
- Chrome CDP attach/release 与能力检查
- Accessibility snapshot 和当前快照 `@eN` 引用
- 可信点击、输入、悬停、按键、滚动、等待和导航
- viewport/full-page 截图与本地文件上传
- 页面图片、视频与 HLS/DASH manifest 清单、`@mN` refs 和 Agent 下载
- frame tree、Console/Network 诊断缓冲区和设备/触摸模拟
- 只连接内置的 `ws://127.0.0.1:43121/browser`，不接受页面或 Agent 提供 endpoint
- 配对成功前拒绝执行 Browser Host 命令
- 普通网页能力使用 optional host permissions；CDP 能力使用明确的 `debugger` permission
- 媒体下载使用 Options 中显式开启的 optional `downloads` permission，默认保存到 `Downloads/EV`
- 不开放任意 `page.eval`，也不支持或绕过 DRM 媒体

Desktop 负责 Pi runtime、任务和应用权限；扩展不保存模型密钥，也不直接执行任意本地命令。扩展不要求用户或 Agent 手填地址和 Pairing token：standalone Browser Host 首次连接会自动批准本机可信扩展；连接 Desktop 时由用户在“设置 → EV Browser”首次批准。Extension Options、Popup 和 Desktop 设置页均可刷新状态或请求重连。

## 开发

从 EV 仓库根目录运行：

```bash
bun install
bun run dev:extension
bun run --cwd apps/browser-extension typecheck
bun run --cwd apps/browser-extension test
bun run --cwd apps/browser-extension build
bun run build:extension:firefox
```

开发模式提供 Vite HMR 和自动扩展重载。Chrome MV3 生产构建位于 `apps/browser-extension/.output/chrome-mv3/`；WXT 也可以生成 Firefox 构建。`bun run package:extension` 和 `bun run package:extension:firefox` 会生成商店上传用 ZIP。
