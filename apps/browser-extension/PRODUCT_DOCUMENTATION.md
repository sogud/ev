# EV Browser 产品说明

## 定位

EV Browser 是 EV 的浏览器应用。它提供本地书签体验、页面上下文采集和经用户授权的浏览器操作，并通过本地通信连接 EV Desktop。

EV Desktop 是任务、Pi runtime、Agent Project、Trace、Evals 和权限确认的唯一宿主。EV Browser 不保存模型服务商密钥，不直接执行本地命令。

## 当前能力

### 浏览器体验

- 浏览和搜索 Chrome 书签
- 常用网站
- 替换新标签页
- Popup 和 Options
- 跟随系统、浅色和深色主题
- 本地整页背景图、背景强度和清除设置；图片只保存在扩展本地存储

### Desktop 通信

- 只允许连接 loopback WebSocket endpoint
- 使用 pairing token 完成握手
- 协议版本检查
- 心跳和指数退避重连
- 请求 ID 与响应关联
- 收到的数据先通过 `@ev/contracts` 校验

### 浏览器操作

- 列出、打开、关闭和激活标签页
- 通过 Chrome `debugger` permission attach CDP，并支持显式 release
- Accessibility Tree snapshot 与短生命周期 `@eN` 引用
- 可信点击、输入、悬停、按键、滚动、等待和导航
- 读取标题、URL、选中文本和页面正文
- viewport/full-page 截图和本地文件上传
- frame tree、Console/Network 诊断缓冲区
- 设备尺寸、DPR、mobile 和 touch 模拟
- App-bundled `ev browser` CLI 与默认 `ev-browser` Skill

## 安全原则

- Desktop bridge 默认关闭，必须由用户完成配对后启用。
- Desktop endpoint 仅允许 `ws://127.0.0.1` 或 `ws://localhost`。
- 配对成功前不执行 Desktop 命令。
- 不提供任意页面脚本执行接口。
- 页面内容、URL、selector、CLI payload 和 Desktop 消息全部视为不可信输入。
- CLI 使用用户级 Socket/Named Pipe、0600 token 和 schema validation，不连接 Extension WebSocket。
- 普通网页能力使用 optional host permissions；CDP 使用明确展示给用户的 `debugger` permission。

## 技术结构

```text
entrypoints/               # WXT Background、Popup、Options 和 New Tab 入口
src/background/
├── background.ts          # Manifest V3 service worker 实现
├── desktop-bridge.ts      # Desktop 连接、握手、心跳与消息路由
└── browser-controller.ts  # 受限 Chrome CDP 操作与诊断缓冲区
src/pages/                 # React 页面
src/components/            # 书签及页面组件
src/contexts/              # 设置状态
src/utils/                 # 搜索、favicon 和设置工具
wxt.config.ts              # Manifest 与构建配置
```

跨应用协议位于仓库根目录的 `packages/contracts/`。

## 下一阶段

1. 将当前全量网页授权细化为逐域授权。
2. 将页面上下文作为明确可检查的附件发送给任务。
3. 在 Desktop 展示每次浏览器操作及其结果。
4. 为 Firefox 保留非 CDP 的降级能力声明。
