# Spec — 多 Runtime 圆桌（Roundtable）v1

状态：提案（未实现）
日期：2026-08-19
背景：多 agent 聊天赛道调研见 agentspace knowledge/技术/2026-08-19-multi-agent-landscape.md。
圆桌是 EV 多 agent 能力的第一步：一个任务内多个 runtime 轮流发言、互评，不做并发。

## 目标

- 一个 EV Task 可以由 2-4 个 runtime 参与者共同完成：用户出题，参与者按序发言、看到彼此观点、可互评
- 全程复用现有 runtime adapter（pi/codex/claude/qoder/dsh）与 TaskSession 投影，不新增引擎
- 向后兼容：单 runtime 任务（现有形态）完全不变

## 非目标（v1 不做）

- 并发发言与协调层（轮流制天然无竞争；真出现并发需求再参考 Cumora 的防御层）
- 参与者之间的工具/文件共享工作区（各自 runtime 会话独立）
- 常驻 persona bot（那是第 2 步"频道化"的事）

## 数据模型（contracts/domain.ts 增量）

```ts
// TranscriptItem 增加可选发言人（向后兼容）
speaker?: { participantId: string; runtimeId: RuntimeId; name: string }

// Task 增加圆桌配置
mode: 'single' | 'roundtable'          // 默认 single
roundtable?: {
  participants: RoundtableParticipant[] // 2-4 个
  maxRounds: number                     // 默认 2，上限 5
  status: 'idle' | 'running' | 'stopped' | 'done'
}

interface RoundtableParticipant {
  id: string            // 短 id，如 'pi'、'codex'
  runtimeId: RuntimeId
  model?: string
  persona?: string      // 可选一句话角色设定（P2 才在 UI 暴露）
}
```

## 服务端设计（apps/server）

新增 `roundtable-coordinator.ts`，TaskSession 在 mode=roundtable 时委托给它：

1. **会话持有**：`Map<participantId, RuntimeSession>`，每个参与者经 RuntimeRegistry
   独立创建（独立进程/上下文，互不污染）
2. **回合循环**（严格串行）：
   ```
   for round in 1..maxRounds:
     for participant in participants:
       context = 议题 + 截至目前的发言摘要（每人最近一条 + 轮次标记）
       session.promptAndWait(context)
       捕获该参与者新增 assistant 消息 → 投影进共享 transcript（带 speaker）
       trace 事件带 participantId 前缀
     （P2：每轮末加 synthesizer 汇总发言）
   ```
3. **发言捕获**：promptAndWait 前后 diff 该参与者 transcript，取新增 assistant 条目
4. **停止条件**：maxRounds 到达 / 用户 stop（逐个 session stop，复用现有机制）/
   参与者输出 `[STOP]` 约定标记（表示无新增观点）
5. **上下文组装原则**：只喂"议题 + 他人观点摘要"，不倾倒各 runtime 内部过程；
   每个参与者看到的是圆桌公共记录，不是别人的原始 transcript

## UI（packages/ui）

1. Composer 加模式切换：单 runtime（现状）/ 圆桌
2. 圆桌设置弹层：勾选 2-4 个 runtime（从 RuntimeRegistry descriptor 来，不可用的置灰）
3. Transcript 渲染：带 speaker 的消息显示 runtime 色标 + 名字 chip；
   轮次之间显示细分隔线（复用轨迹视图的轮次边界样式）
4. 轨迹视图：事件按参与者分组着色（trajectory-view-model 已支持轮次分组，加一维）
5. 成本可见：圆桌模式在任务头部显示"参与者数 × 轮数 × 累计 token"（trace 已有 tokens 字段）

## 治理与限制

- 参与者上限 4（进程成本），UI 默认推荐 2-3
- maxRounds 上限 5；每轮 token 预算通过 prompt 约束（"观点不超过 300 字"）
- 圆桌任务锁定后不可改参与者（与现有 task 锁定语义一致）
- 错误隔离：某参与者 runtime 报错 → 该轮跳过并投影 error 条目，圆桌继续

## 实施拆分

| 阶段 | 内容 | 验证 |
| :--- | :--- | :--- |
| P1a | contracts 增量 + coordinator 串行循环 + 发言捕获 | server 单测（fake runtime 双参与者两轮） |
| P1b | TaskSession 委托接线 + stop 传播 | 集成测试：pi+codex 真双 runtime 冒烟 |
| P1c | UI：模式切换 + 参与者选择 + speaker chip | typecheck + desktop/web 手工冒烟 |
| P2 | persona、轮末 synthesizer 汇总、[STOP] 语义 | 按需 |
| P3 | 并发发言 + 协调层（仅在真实需求出现后立项） | — |

## 开放问题

1. 发言摘要策略：简单拼接 vs 每轮压缩——v1 用简单拼接（参与者的最近发言全文），
   观察上下文膨胀再优化
2. qoder/dsh 在圆桌中的可用性：dsh 无 cold resume，圆桌中途失败不能续——
   v1 文档标注"dsh 参与者失败即退出圆桌"
3. 是否允许同一 runtimeId 两个参与者（如两个不同 persona 的 claude）——v1 禁止，P2 评估
