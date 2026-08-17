# Roadmap（未完成项）

> 取代旧 `TODO.md`（2026-08 退役）。已完成历史见 Git。
> 约定：每个条目开工前先写独立 spec（`docs/specs/`），`ready` 的才交接实现。
> 交互类条目先走 wayfinder 地图（`docs/wayfinder/`）。
> 2026-08-09 全量盘点：已完成项退役，决策补录进各 spec 附录。

## 进行中

- [ ] Server Plugin Architecture 后续迁移：Store → Task/AgentService → Management → Browser → HTTP/WS；每步替换旧 composition（spec: server-plugin-architecture-v1，ADR-0001）
- [ ] Claude/Qoder adapter 收尾：resume 链路真实会话验证（effort 映射已完成于 Bug Sprint）
- [ ] DSH productization：等待官方 stdio SDK 提供 per-session cancel 与 cold session list/resume；当前保持 Experimental

## 表达层与开发体验

- [ ] 文件树和 Diff 审查；按文件接受或撤销 Agent 修改（与检查器 spec 联动）
- [ ] 任务检查点、恢复和分支
- [ ] Context 查看器：最终指令、上下文来源和压缩结果
- [ ] Prompt、Skill 和 Extension 内置编辑器
- [ ] 可编辑的项目记忆和长期记忆
- [ ] 模型能力、延迟、费用和 fallback 可视化
- [ ] 图片附件送模型前自动缩放/压缩：provider 网关单消息体积上限
      （DashScope 系 1009 / HTTP 6MB）；发送前降采样 ≤1280px 转 JPEG
- [ ] 浅色主题巡查与定案（深色已巡查；浅色未查——修还是声明 dark-only，待定）
- [ ] tsconfig 严格度渐进收紧（noUncheckedIndexedAccess / exactOptionalPropertyTypes）
- [ ] golden CDP 时序硬化：步骤级 wait/retry/backoff，降低 flaky（2026-08-09 连续两次挂不同步骤）

## 暂缓（用户定案，需要时再启）

- [ ] ⌘K 命令调度器
- [ ] 并行任务板 / worktree-per-task 编排
- [ ] 移动端 observer 审批 UX（最小集已砍掉审批；桌面侧也未做）
- [ ] 移动端 Capacitor 壳（2026-08-09 定案：先只做 H5）
- [ ] 移动端原生应用（2026-08-16 占位：方向暂定 React Native/Expo，暂缓；移动端形态先由 web 响应式承接；原生启动时可复用 @ev/contracts/store/view-model 逻辑层，视图重写）
- [ ] 桌面 app 分发整条线（2026-08-09 定案：桌面未打磨完、不发、先不考虑；
      含 electron-builder 真 pack、better-sqlite3 按 Electron ABI 重编两条债，
      到要分发时再启）

## 安全与隔离

- [ ] 权限模式 UI：per-thread 切换（契约层 PermissionLevel 已就位，UI 未做）
- [ ] Git worktree 或临时目录隔离并行任务
- [ ] Secret 引用和脱敏显示
- [ ] 超时、重试、token 和费用策略
- [ ] 危险命令和越界目录访问提示
- [ ] browser-bridge pairing token 硬化（现仅文件权限保护）

## 分发与硬化（债，未阻塞当前工作；分发线启动时优先）

- [ ] ev task list 在 server.json 缺失时静默 exit 0，应报错
- [ ] 检查并清理 sidebar 历史深处的旧测试条目（可见窗口已清）
- [ ] browser-bridge pairing token 硬化（现仅文件权限保护）

## 浏览器连接

- [ ] 浏览器页面上下文和选中文本发送到 Desktop
- [ ] 网页操作权限从全量授权细化为逐域授权
- [ ] 主 Agent 创建和管理子任务；子 Agent 独立模型/配置/目录；依赖与结果汇总

## 待定决策（fog，能问清楚就开 ticket 或 wayfinder 地图）

（2026-08-09 盘点：分发线与 Capacitor 已移暂缓；原生配置归属已定案——
原生配置归用户、EV 只读展示，见 native-auth-display-v1）

- [ ] 桌面打磨的验收标准：什么状态算“打磨完”可以重新考虑分发

## 已完成（2026-08 盘点退役，细节见 Git 与 spec）

- [x] Cordis Runtime tracer：`apps/server` 精确锁定 upstream Cordis，RuntimeRegistry 成为 Service，五个 Runtime 由静态 plugins 挂载；单 Fiber unload 与 packaged Server DSH smoke 通过（spec: server-plugin-architecture-v1，ADR-0001）
- [x] Experimental DSH Runtime：官方 stdio JSON-RPC、每 Task 独立进程、流式 assistant/thinking/tool/subagent 投影、明确禁用 cold resume，并通过官方源码 + 本地 mock model smoke
- [x] EV Browser 设置修复：English / 简体中文切换、可关闭书签 New Tab、背景图应用与实时同步
- [x] WebMCP 桥 + 操作可视化：页面通过 `navigator.modelContext.registerTool` 注册工具，`page.webmcp.listTools/callTool` 经 session/oneShot 调用（JSON 错误封装、超时）；元素操作前独立 overlay 高亮，设置开关默认开启（spec: webmcp-and-action-visualization）
- [x] Browser Control P0/P1：普通 DOM 操作无 CDP、高级能力按需 attach 且同 tab 并发合并；完整 typed 页面交互、iframe、BrowserRun，以及 window/tab/group/download/history/session/zoom 工作区操作（spec: browser-control-p0-p1）
- [x] SiteRecipe P2：review-token 审批、精确域名/路径、typed adapter、本地 0600 存储、`x.mute-words` 与 `x.read-grok-conversation`（spec: site-recipe-p2）
- [x] BrowserSession P1：每个 Session 新建非聚焦 Chrome window 和单一 EV tab group，只允许 owned tabs，禁止 adopt/borrowed tab，安全 release 与 Host 内存 ownership（spec: browser-session-p1）
- [x] BrowserRun P0：Host 本地顺序/循环/重试、语义目标重新定位、最终汇总输出；不开放 eval（spec: browser-run-p0）
- [x] CLI-first EV Browser：Desktop 可选、extension TOFU 配对、全局 `ev-browser` Skill、typed 书签查询/整理、写操作前自动 JSON 备份、非破坏式恢复
- [x] P3 远程接入+移动端（2026-08-09）：R1 localhost+私网多绑（禁 0.0.0.0）+ token 强制、R2 ev token 分级（observer 只读）、R3 /m 独立移动端（React，选任务/对话/切模型）、R4 双 URL+手机实测步骤

- [x] 架构深化：Task 生命周期深模块 / IPC registry / RuntimeLaunch / Codex 状态机分离
- [x] Bug Sprint：qodercli 启动 / 下拉框 / 切换卡顿（5.4s→370ms）/ 能力全映射 / golden 门禁建立
- [x] Server/客户端拆分：无头 server + contracts 唯一共享 + CLI + desktop 瘦身 + Web 同构
- [x] 硬化：SQLite 事实源 + 打包形态（spec 附录）
- [x] 原生认证：EV 零凭据持有，四家只读探测+设置同构（spec: native-auth-display-v1）
- [x] UI 打磨 + Runtime 设置页重设计（紧凑行+抽屉）
- [x] 本地 API（HTTP+WS，registry 1:1）+ token 认证 + 事件订阅推送
- [x] wayfinder 地图 desktop-ui-interaction-map（tickets 0001-0007 全 closed）

## 暂不做

- 云端账号系统和团队协作
- 复杂可视化工作流编辑器
- 自研模型适配层或自研 Agent 运行时
- 自建 NAT 穿透 relay（Tailscale 即穿透+加密，定案）
- 响应式适配桌面 UI（双 UI 定案：桌面零改动，移动端独立）
