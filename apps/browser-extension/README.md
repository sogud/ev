# EV Browser

EV Browser 是 EV 的浏览器应用，基于 WXT、Vite、React、TypeScript 和 Chrome Manifest V3。

当前能力：

- Chrome 书签浏览与搜索
- 简洁的新标签页工作区、常用网站和扁平书签列表
- 可关闭 EV Browser 新标签页内容；关闭后保持空白且不读取书签或历史记录
- 本地整页背景图、背景强度和一键清除
- Popup、Options 和替换新标签页
- 与 EV Desktop 共享的紧凑 Design Tokens
- English / 简体中文切换，以及跟随系统、浅色和深色主题
- 基于 Base UI 的非原生菜单选择器

扩展内置基于 `@ev/contracts` 的本机 Browser Host WebSocket bridge，以及经过类型校验的浏览器操作路由。通信层包含自动发现、配对握手、心跳、自动重连和请求关联。Host 可以来自 EV Desktop，也可以由独立 `ev` CLI 自动启动。

当前支持：

- 每个 BrowserSession 自动创建专属非聚焦 window 和单一 EV tab group；拒绝操作用户已有 tab/window
- 普通 navigate/context/snapshot/click/type/check/select/focus/scroll 使用固定 content script / tabs API，不触发远程调试
- 仅高级拖拽、底层输入、iframe、Network/Console、emulation、上传和媒体发现使用 Chrome CDP；同一 tab 并发 attach 只执行一次
- DOM/Accessibility snapshot、iframe frameId 和当前快照 `@eN` 引用
- 点击/双击/右键、输入、checkbox/radio、原生 select、拖拽、focus、元素检查、键盘、pointer、滚动、条件等待、导航历史和 JavaScript dialog
- 下载查询/暂停/继续/取消/打开/定位/删除，以及受确认保护的历史记录查询和删除
- viewport/full-page 截图与本地文件上传
- 页面图片、视频与 HLS/DASH manifest 清单、`@mN` refs 和 Agent 下载
- frame tree、Console/Network 诊断缓冲区和设备/触摸模拟
- 只连接内置的 `ws://127.0.0.1:43121/browser`，不接受页面或 Agent 提供 endpoint
- 配对成功前拒绝执行 Browser Host 命令
- 普通网页、CDP 和下载能力作为安装权限默认开启；Options 只显示能力状态，不提供权限勾选开关
- 页面、window、tab、tab group 和 zoom 操作只接受 Host 内 BrowserSession 所有权；书签、历史和下载保持显式 profile 全局 action，文件默认保存到 `Downloads/EV`
- 不开放任意 `page.eval`，也不支持或绕过 DRM 媒体

Desktop 负责 Pi runtime、任务和应用权限；扩展不保存模型密钥，也不直接执行任意本地命令。扩展不要求用户或 Agent 手填地址和 Pairing token：standalone Browser Host 首次连接会自动批准本机可信扩展；连接 Desktop 时由用户在“设置 → EV Browser”首次批准。连接与重连由扩展后台自动完成；Popup 只显示状态，Extension Options 只刷新状态，不提供手动连接开关。Desktop 设置页可请求 Host 断开后自动重连。

## 开发

从 EV 仓库根目录运行：

```bash
pnpm install
pnpm run dev:extension
pnpm --dir apps/browser-extension run typecheck
pnpm --dir apps/browser-extension run test
pnpm --dir apps/browser-extension run build
pnpm run build:extension:firefox
```

开发模式提供 Vite HMR 和自动扩展重载。Chrome MV3 生产构建位于 `apps/browser-extension/.output/chrome-mv3/`；WXT 也可以生成 Firefox 构建。`pnpm run package:extension` 和 `pnpm run package:extension:firefox` 会生成商店上传用 ZIP。
