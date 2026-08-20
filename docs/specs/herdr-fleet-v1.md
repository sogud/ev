# Spec — Herdr Fleet 视图（herdr-bridge）v1

状态：提案
日期：2026-08-20
定位：把 Herdr 的"进程监督面"接进 EV——EV 里看到所有 Herdr agent 的实况。
边界原则：Herdr 与 EV 能力互补不重叠。EV 继续用原生协议直连引擎（结构化数据），
Herdr 只贡献它独门的三样：终端窗格、并行监督、人随时 attach。
集成层 = 进程与终端层，不是智能层。

## 目标

- EV desktop/web 新增 Fleet 页：Herdr workspace → tab → pane 树，agent 状态实时可见
  （working/idle/blocked/done 色标）、cwd、按需查看 pane 最近输出
- 只读优先：v1 不改 Herdr 状态（唯一动作：focus pane）
- Herdr 为可选依赖：未安装/未运行时 Fleet 页显示空态提示，EV 其余功能零影响

## 非目标

- 不做终端渲染/TTY 流（终端归 Herdr 所有，EV 只看状态与输出快照）
- 不用 Herdr 跑 EV 的 runtime（EV 原生协议直连引擎，信息质量更高，不降级）
- v1 不做向 agent 发 prompt/按键（v3 再评估，需确认门）

## 架构

```
packages/ui (Fleet 页)
    ▲  client-sync 推送 + 按需拉取
apps/server
    ├── fleet-service.ts      轮询调度 + 快照组装（默认 5s，可配）
    └── herdr/herdr-client.ts CLI 封装：child_process 调 herdr，JSON 解析，超时兜底
            │
            ▼ shell out
        herdr CLI ──▶ Herdr server（本机 socket）
```

### herdr-client（apps/server/src/herdr/herdr-client.ts）

- 探测：`herdr workspace list`（3s 超时）成功 → available；二进制缺失/服务未起 → unavailable，
  指数退避重试探测（不阻塞 EV 启动）
- 封装命令（全部 JSON 输出解析 + 超时）：
  - `listFleet()` = workspace list + 每 workspace 的 tab list + pane list
  - `getAgent(paneId)` = agent get（状态、kind、cwd）
  - `readPane(paneId, lines)` = pane read --source recent-unwrapped（**仅按需**）
  - `focusPane(paneId)` = pane focus（v1 唯一写操作，低风险）
- 所有调用失败只降级不抛：返回 stale 标记或空，Fleet 页显示"数据可能过期"

### contracts（packages/contracts/src/fleet.ts 新增）

```ts
interface FleetAgent { name: string; kind: string; status: 'idle'|'working'|'blocked'|'done'|'unknown' }
interface FleetPane  { paneId: string; title?: string; cwd?: string; agent?: FleetAgent }
interface FleetTab   { tabId: string; label?: string; panes: FleetPane[] }
interface FleetWorkspace { workspaceId: string; name?: string; tabs: FleetTab[] }
interface FleetSnapshot {
  available: boolean
  fetchedAt: number
  stale?: boolean
  workspaces: FleetWorkspace[]
}
```

同步方式：复用现有 client-sync 通道推送 FleetSnapshot（herdr 不可用时只推
`{available:false}` 一次，不重复推）。

### UI（packages/ui → desktop/web 共享）

- Fleet 页：workspace/tab/pane 三级树
  - agent 状态色标：working=蓝、blocked=橙（最显眼）、done/idle=绿/灰、unknown=虚线
  - pane 行：标题 + cwd + agent 名/kind
  - 点 pane → 右侧抽屉懒加载最近 60 行输出（readPane），内容按 EV 惯例视为不可信数据
  - 动作：Focus（v1）；v2 评估：读全屏、打开所在终端
- 空态：未检测到 Herdr → 一句话说明 + 不渲染任何结构

## 安全与限制

- pane 输出可能含密钥/隐私：只按需拉取、不进 transcript、不落盘、UI 标注"终端原始输出"
- v1 只读 + focus；prompt/按键等写操作留到有确认门的 v3
- 轮询成本：tick 只跑 list 类轻命令；readPane 绝不进轮询

## 实施拆分

| 阶段 | 内容 | 验证 |
| :--- | :--- | :--- |
| P1a | herdr-client + 探测/降级 + contracts | server 单测（fake herdr 脚本注入：可用/不可用/超时三态） |
| P1b | fleet-service 轮询 + client-sync 推送 | 集成测试：真 herdr 环境冒烟（本机有） |
| P1c | Fleet 页 UI（树 + 状态色标 + 空态） | typecheck + desktop/web 手工冒烟 |
| P2 | 输出抽屉（懒加载 readPane）+ focus 动作 | 手工冒烟 |
| P3 | blocked 升级提醒（EV 通知）；评估 prompt 发送确认门 | 按需 |

## 开放问题

1. 轮询频率默认 5s 是否够——agent 状态变化密度低，5s 应该够；blocked 升级（P3）才需要更快
2. Herdr 多 server 场景：v1 只认 CLI 默认会话，多 server 需求出现再说
3. Fleet 数据是否进任务系统（"这个任务派给了哪个 herdr agent"）——那是 C 方向
   （agent-chat 受监督模式）的事，v1 不碰
