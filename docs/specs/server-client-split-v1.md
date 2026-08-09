# Spec — Server/客户端拆分 + 多端接入 v1

> 来源：2026-08-08 与用户的架构定案（参考 bb 架构与 herdr 模式）。
> 产品定位延续：EV 是各种 Agent + 各种工具的 UI 表达层；本 spec 解决"表达层长在哪个进程上"。
> 参考：get-bb/bb `docs/system-overview.md`（server/daemon/契约边界）、herdr（常驻 server + 客户端 attach）。

## Problem Statement

当前 desktop main 进程兼任编排服务端：agent-service、生命周期模块、runtime adapters、
ipcRegistry 全在 Electron main 里。后果：

- 关掉桌面窗口，所有运行中的任务随之中断——agent 工作被 UI 生命周期绑架
- CLI、浏览器插件、移动端没有可接入的服务面；每多一个端就要重发明一套通信
- 服务端逻辑与 Electron 耦合，无法脱离 UI 单独测试
- 用户明确要求：手机上也能控制家里电脑上的 agent 工作

## Solution

拆成三层：**ev server（无头常驻）+ contracts（唯一契约）+ 若干薄客户端**。

```
ev server（Mac 常驻，无头）
├── SQLite：任务/会话/事件的唯一事实源（server 自身无状态，bb 纪律）
├── runtime adapters：pi / codex / claude-code / qoder provider 进程全归它管
├── HTTP + WebSocket API：ipcRegistry 的对外形态（同一套 handler）
├── 网络面：localhost（本机客户端）+ Tailscale 网卡 IP（远程客户端）
└── 认证：token；权限分级（见安全节）

客户端（全部薄壳，共享 contracts 包，能力对等）：
├── ev CLI            命令行，人和 agent 都用
├── Desktop           Electron 只剩窗壳 + renderer，本身是客户端
├── Web               浏览器直接访问（桌面浏览器 + 手机浏览器）
├── 浏览器插件        吃同一套 HTTP+WS
└── 移动端            第一阶段 = 响应式 Web + 加主屏幕；第二阶段 = Capacitor 壳
```

**不做的事（明确排除）**：
- 不做 bb 的多机 host/daemon 注册层——单机自用，server 直管 provider 进程
- 不自建云中继——远程可达交给 Tailscale；除非"造中继"本身成为学习目标
- 不保留 Electron IPC 通道——desktop 与 renderer 全部走 HTTP+WS，删掉第二套通信

## 契约与数据

- `packages/contracts` 升级为唯一共享物：ipcRegistry（call/event token + 类型）
  + HTTP 路由映射 + WS 事件协议 + 认证/权限模型。实现代码禁止跨契约 import（bb 纪律）
- CLI 命令树 1:1 镜像 registry 命名空间，由 contracts 类型驱动生成：
  `ev task list|create|prompt|abort|set-runtime|set-model|follow`、
  `ev runtime list`、`ev provider list|login|logout`、`ev inspection get`、
  `ev settings get|set`
- `--json` 为默认输出（机器友好），`--pretty` 人类友好
- `ev task follow <id>` 走 WS 订阅事件流
- `ev --skill` 打印 agent 技能文件（herdr 模式），让任何 agent 可驱动 EV

## 进程生命周期（herdr 模式）

- server 启动后把端口 + token 句柄写入 `~/.ev/server.json`
- `ev server start|stop|status` 管理；所有客户端启动时先读 server.json，
  发现 server 不在则自动拉起（带超时与失败提示）
- server 崩溃恢复：状态在 SQLite，重启后任务记录可恢复；provider 进程存活探测
  沿用生命周期模块的 sessionOwners 语义

## 安全（远程接入后为必选项）

- **认证**：所有请求带 token，本地远程同口径；token 存 `~/.ev/`（600 权限）
- **传输**：本机 localhost 免 TLS；远程走 Tailscale（自带加密），
  server 只绑 localhost + Tailscale 网卡 IP，不开公网端口
- **权限分级**（设计进契约，从第一天实现）：
  - `observer`：只读 + 审批（看进度、批准/拒绝继续）——手机默认档
  - `operator`：发起任务、切换 runtime/模型、改设置
  - 口袋里一块能让家里电脑跑任意指令的屏幕，默认最小权限，防误触即防自己

## 迁移路径

1. 新建 `apps/server`：agent-service、task-session-lifecycle、runtime adapters、
   ipcRegistry handler 整体搬入；Electron 依赖清零（可独立 bun run/测试）
2. contracts 扩展 HTTP+WS 映射；server 挂载；`ev server` 生命周期命令
3. `apps/cli`：薄客户端 + 命令树 + follow + --skill
4. desktop 改造：main 只剩窗口管理 + server 监督（bb desktop 模式）；
   renderer 从 IPC 切到 HTTP+WS，删 Electron IPC 层
5. Web 客户端（desktop renderer 的独立部署形态）→ 移动端响应式 → Capacitor 壳
6. 浏览器插件接入同一 API

## 阶段与验收

| 阶段 | 交付 | 验收 |
|---|---|---|
| P1 | server + CLI | golden-path 增加 CLI 旅程：`ev task create→prompt→follow→set-runtime` 全程 CLI 完成；desktop 关闭状态下任务继续运行并可 CLI 观察 |
| P2 | desktop 瘦身 + Web | 现 desktop 全部 UI 旅程走 HTTP+WS 复验（golden-path 原有项不回归） |
| P3 | Tailscale + 认证分级 + 移动端 Web | 手机（外网）observer 档看进度/审批；operator 档发任务；无 token 请求全拒 |
| P4 | 浏览器插件 + Capacitor 壳 | 插件在真实浏览页调用 EV API；壳应用装到手机可用 |

每阶段收尾必须过：verify + typecheck + golden-path.sh（随阶段扩展旅程）。

## 参考资料

- bb：`~/codes/bb`（clone 中）— `docs/system-overview.md`、`apps/cli`、
  `packages/server-contract`、`packages/agent-runtime`（其 Pi bridge 与本仓 pi-rpc-adapter 对照）
- herdr：常驻 server + 客户端 attach + `--skill` agent 驱动模式
- 本仓既成事实：ipcRegistry（31 call + 4 event）、task-session-lifecycle 深模块、
  RuntimeCapabilities/模型目录映射、golden-path.sh 回归体系

## 附：实施期定案（2026-08-08/09，原只存在于任务书，补录）

- **纯 Node 运行时**：server 不用 bun 运行；Bun.serve 换 node:http+ws；
  sqlite 用 node:sqlite/bun:sqlite 双后端缝（dev/打包各一）；spawn('bun') 清零
- **打包形态**：dist-server/server.mjs + ship-native.mjs 原生依赖链；
  desktop 解析序 EV_SERVER_ENTRY → 打包 resources → dev 兜底；
  node 优先、Electron-as-node（ELECTRON_RUN_AS_NODE）回退
- **SQLite 事实源**：EV 域状态全走 SQLite KV（~/.ev/ev.db）；旧 JSON 一次性迁移、
  旧文件保留可回滚；剩余文件写入均为设计内（server.json/token、launcher、迁移标记）
- **双 UI 不响应式**：桌面 UI 零改动；移动端独立 entry 挂 /m，组件独立写，
  只复用 contracts client + design-tokens
- **移动端最小集**：选任务 / 对话（transcript+发送）/ 切模型；React+tsx；vite 构建
- **远程双链路**：绑 localhost + 所有私网接口（LAN 直连 + Tailscale），不绑 0.0.0.0/公网；
  非 loopback 强制 token；不自建 NAT relay（Tailscale 即穿透+加密）；
  陌生 WiFi 走 Tailscale（LAN 为明文 HTTP）
- **token 分级**：observer（只读+审批）/ operator（全权）；本地 token 视为 operator；
  发放经 `ev token create --tier`
