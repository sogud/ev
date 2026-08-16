# Spec — 客户端接入统一：发现收敛 + 设备配对 + 在线设备列表 v1

> 状态：proposal（未排期）。不考虑历史兼容，目标形态设计。
> 关联：server-client-split-v1（HTTP+WS 拆分现状）、native-auth-display-v1（runtime 认证）、
> ADR 无新增。

## Problem Statement

EV server 是本地常驻 agent server，五个客户端壳（desktop / web / mobile / extension / CLI）
都要解决同一件事：**发现 server + 认证 + 保持连接**。当前方案的问题：

1. **token 出现在 URL 里**。web 形态要 `?port=..&token=..`，operator 全权凭证进浏览历史、
   日志、Referrer、截屏；每次开页面都要重新提供。
2. **发现逻辑重复三处**：desktop main 读 `~/.ev/server.json` 注入 hash；apps/web dev 用
   vite 插件读同一文件做 302；CLI 再读一遍。各自解析、各自容错。
3. **没有"设备"概念**。token 只是凭证：不知道有几个端接入过、谁在线、无法单独吊销。
   `tokens.json` 已有 operator/observer 分层，但只是静态文件，没有产品表面。
4. **移动端发现靠手输**。手机读不到本机 `server.json`，也没有局域网发现。

## Goals / Non-Goals

Goals：

- 任何客户端**零手动抄写 token** 即可接入；URL 中永不出现凭证。
- 发现逻辑收敛到单一共享模块，所有客户端同一实现。
- server 持有**已配对设备注册表**：每设备独立凭证、权限层、可吊销。
- 用户能在任一 operator 端看到**配对设备列表与实时在线状态**（"App 上看到几个设备在线"）。
- 安全边界全部落在 server：origin 校验、Host 校验、凭证绑定来源。

Non-Goals：

- 不做账号系统 / 云端中继 / 远程 SaaS（保持 local-first）。
- 不做多用户；一台机器一个 EV 实例一个主人。
- 不解决 LAN 暴露的传输加密（见 Open Questions）。

## Solution 总览

三层：

```text
发现层   packages/discovery（新）        认证层  设备配对（server 主导）       呈现层  设备列表 UI
─────────────────────────────          ─────────────────────────────        ──────────────────
server.json（本机）→ mDNS（LAN）→ 手输    pair 流程发放设备 token             设置页 Devices 页签
所有客户端共用一个解析器                  token 存客户端本地，不进 URL         devices:update 实时广播
```

### 1. 发现层：`packages/discovery`

单一模块导出 `resolveEvEndpoint(): Promise<{ baseUrl, token? } | null>`，按优先级：

1. **本机文件**：`$EV_HOME/server.json`（现格式不变：port/token/pid/lanIps/tailscaleIp）。
2. **mDNS/DNS-SD**：server 广播 `_ev._tcp`（port + 指纹），移动端 LAN 发现用。
3. **手动输入**：兜底，移动端跨网段场景。

desktop main、apps/web、CLI 的三处重复读取全部替换为此模块。发现结果只回答"server 在哪、
引导凭证是什么"，不决定最终会话凭证（那是认证层的事）。

### 2. 认证层：设备配对（device pairing）

本地化的 OAuth Device Authorization Grant（RFC 8628，为"输入不便的客户端"设计的标准模式）。

**配对流程（跨源/跨设备场景）**：

```text
新端打开 web/mobile → POST /pair/request { deviceName, kind, origin }
  → server 返回 { pairingCode, pollUrl }，页面显示"等待批准"
已信任表面收到批准请求（desktop 弹窗 / CLI 确认 / 已在线 operator 端点击）
  → POST /pair/approve { pairingCode, tier }
新端轮询 pollUrl → 拿到设备专属 token（含 tier、过期时间）
  → 存入本地（web: IndexedDB；mobile/desktop: Keychain；CLI: 文件 600）
此后每次打开自动连接，URL 无任何凭证
```

**同源免配对**：server 亲自 serve 的页面（打包 web 形态、desktop renderer）首次加载时，
server 往 HTML 注入一次性 nonce，客户端用 nonce 换 `SameSite=Strict` session cookie +
设备 token。本机打开即用，零手动步骤，也不经过 URL。

**本机来源自动批准**：来源为 127.0.0.1/localhost 的配对请求可配置自动批准
（对齐 browser-extension 现有 `pairingMode: 'automatic'` 先例），所以 `ev web` 一条命令
即可完成"起 server → 开浏览器 → 自动配对"。

**凭证模型**：

- `~/.ev/token` 主 token 降级为 **root of trust**：只用于本机引导、CLI 与 disaster
  recovery，不再是日常凭证。
- 每个配对设备一个 token：`{ id, tokenHash, name, kind, tier, origin, createdAt,
expiresAt?, revokedAt? }`，持久化在 server store（sqlite），替换 tokens.json 静态文件。
- 吊销 = 单设备失效，不影响其他端。

### 3. 在线设备列表（presence）

**用户可见效果**："我在 App 上能看到当前有几个设备在线。"

判定规则（server 是唯一事实源）：

- **已配对（paired）**：注册表里有未吊销记录。
- **在线（online）**：该设备 token 当前有活跃 WS 连接，或最近 30s 内有 HTTP 调用。
  WS 是主信号（UI 客户端都挂 enableTaskSync 长连接）；HTTP-only 客户端（CLI one-shot）
  靠 lastSeenAt 宽限窗口。

机制：

- server 已有 per-token 认证点（`tokenTier`），在此挂连接计数：WS open/close、每次
  HTTP 调用更新 `lastSeenAt`。无需客户端心跳协议——重连退避（client.ts 已有
  1s→8s backoff）天然产生上下线事件。
- 状态变化广播 wire 事件 `devices:update`（复用现有 broadcast 通道，同
  `tasks:update` 模式），payload 为全量设备快照列表。
- 客户端契约（`packages/contracts` registry）新增：
  - call `devices.list(): PairedDevice[]`（operator）
  - call `devices.revoke(deviceId)`（operator）
  - call `pair.approve(pairingCode, tier)` / `pair.reject(pairingCode)`（operator）
  - event `devices:update`
  - `pair.request` / `pair.poll` 走未认证 HTTP 端点（返回内容不含任何敏感信息）。

**UI（桌面端设置页新增 Devices 页签）**：

```text
设备                       层级        状态           最近活动        操作
Mac 桌面端（本机）          operator   ● 在线          刚刚           —
Chrome · web               operator   ● 在线          刚刚           吊销
iPhone · EV H5             observer   ○ 离线          2 小时前        吊销
```

- 顶部计数 "3 个设备已配对 · 2 个在线"；`devices:update` 到达即刷新，无需轮询。
- 新设备配对成功时，所有 operator 端弹 toast（复用 error-toast 位置的组件）。
- web/mobile 端自身也能看列表（observer 只读、隐藏吊销）。

## 安全边界（全部在 server）

1. **Origin 白名单 + Host 头校验**：拒绝非白名单 Origin 的跨源请求与异常 Host
   （防 DNS rebinding：公网网页把域名 rebind 到 127.0.0.1 偷调 API。纯 token 方案
   挡不住这个，Host/Origin 校验可以）。现有 DEV_ORIGINS 白名单泛化为配置项。
2. **token 绑定来源**：设备 token 记录首次配对的 origin/device 指纹，跨来源使用降级
   或拒绝。
3. **配对通道防刷**：pairingCode 一次性、60s 过期、限速；poll 端点不泄漏批准方信息。
4. **tier 强制**：observer 调 operator call 仍 403（现状保持）；移动端默认 observer，
   升级需 operator 端显式批准。
5. LAN/Tailscale 暴露默认关闭，仅在有移动端配对需求时按需开启（mDNS 广播随之开启）。

## 客户端接入后的形态（目标态）

| 客户端              | 发现                            | 认证                                    | URL 含凭证                    |
| :------------------ | :------------------------------ | :-------------------------------------- | :---------------------------- |
| desktop             | discovery（本机文件）           | 同源 nonce → session                    | 否（hash 只含 port 亦可去掉） |
| web（server serve） | 无需发现（同源）                | 同源 nonce → session                    | 否                            |
| web（dev/外部）     | discovery 或手输                | 配对流程，token 存 IndexedDB            | 否                            |
| mobile H5           | mDNS → 手输兜底                 | 配对流程（desktop 批准），默认 observer | 否                            |
| extension           | 现有 browserBridge 配对（保持） | 保持                                    | —                             |
| CLI                 | discovery（本机文件）           | root token 引导，可换设备 token         | —                             |

开发体验：`ev web` 一条命令（CLI 编排：确保 server 在跑 → 开浏览器 → 本机来源自动批准）。
apps/web 现有 vite 302 插件保留为无 CLI 时的 dev 兜底。

## 迁移路径（不考虑兼容的拆除项）

1. URL token 入口删除：`createEvClient` 不再接受 URL token；旧 `?token=` 直接报错并
   引导配对。
2. `tokens.json` 静态文件 → sqlite 设备注册表，一次性迁移后删文件。
3. desktop main 的 hash 注入、apps/web vite 重定向插件、CLI 的 server.json 读取
   → 全部换成 packages/discovery。
4. `mainToken` 从 server.json 中移除（只留 port/pid），断掉"读到文件即全权"链路。

## 阶段与验收

- **P0 发现收敛**：packages/discovery 落地，三处重复替换；验收：desktop/web/CLI
  接入同一模块，typecheck + 现有测试全过。
- **P1 配对与注册表**：/pair 端点、设备注册表、devices.list/revoke、URL 去 token；
  验收：全新浏览器从零完成配对；URL/日志中无 token；吊销即时生效。
- **P2 在线列表**：presence 跟踪 + devices:update + Devices 页签；
  验收：开/关一个 web 端，桌面端 3s 内计数变化；双端一致。
- **P3 移动端与体验**：mDNS 发现、`ev web` 命令、配对 toast；
  验收：手机 LAN 内零手输完成配对（observer）。

## Open Questions

1. LAN 暴露后的传输加密：mDNS + 明文 HTTP 在内网是否可接受，还是配对时交换
   公钥走 TLS/Noise？（决定 P3 形态）
2. session cookie 与 WS 的认证统一：WS 目前用 query token，cookie 化后 WS 如何带
   凭证（Sec-WebSocket-Protocol 子协议 or 首帧认证）？
3. 设备命名策略：自动（UA/主机名）还是配对时让用户命名？
4. observer 端能否看到完整设备列表，还是只看到"自己的记录 + 总数"？
