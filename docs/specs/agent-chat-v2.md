# Spec — 多 Agent 聊天室（Agent Chat）v2

状态：提案（取代 v1 圆桌方案）
日期：2026-08-19
变更：v1 是固定轮次的圆桌；v2 改为 @ 路由的持续聊天室，且**不承担向后兼容义务**——
数据模型按聊天室需要自由设计，旧单 runtime 任务只是聊天室的特例（1 个参与者）。
背景：多 agent 赛道调研见 agentspace knowledge/技术/2026-08-19-multi-agent-landscape.md。

## 目标

- EV Task = 一个聊天室：用户 + 2-4 个 agent 参与者共存于同一会话
- 用户消息可 **@ 指定 agent**：被 @ 的才回应；不 @ 则全员按序回应
- agent 发言带身份（runtime 色标 + 名字），全部投影进同一 transcript
- 全程串行执行（v1 无并发），复用现有 runtime adapter，不新增引擎

## 非目标（本期不做）

- 并发发言与协调防御（出现真实需求再参考 Cumora 七层防御）
- agent 之间互相 @（P2；v1 只有用户 @）
- 常驻 persona 频道（第 2 步产品形态）
- 小脑分诊决定"谁该回答"（P2；v1 无 @ 即全员回应）

## 数据模型（contracts/domain.ts，自由重设计）

```ts
// 参与者
interface ChatParticipant {
  id: string              // 'pi' / 'codex' / 'claude' / 'qoder' / 'dsh'
  runtimeId: RuntimeId
  model?: string
  persona?: string        // 可选角色设定，注入该参与者的每轮上下文
}

// 任务即聊天室
Task.mode: 'chat'                          // 单一模式，取代 single/roundtable 之分
Task.participants: ChatParticipant[]       // 1-4 个；1 个 = 传统单 runtime 体验
Task.chatStatus: 'idle' | 'running' | 'stopped'

// 消息：结构化 mention，不做文本解析
TranscriptItem.speaker?: { participantId: string; runtimeId: RuntimeId; name: string }
ChatMessage.mentions: string[]             // UI 组装的 participantId 列表，服务端不做 @ 文本解析
```

设计原则：mention 由 UI 组装成结构化数据（@ 自动补全从参与者列表来），
服务端只认 `mentions: string[]`——不解析自由文本，无歧义。

## 路由规则（服务端 chat-coordinator.ts）

用户消息到达后：

1. `mentions` 非空 → 按参与者顺序，仅被 @ 的依次回应
2. `mentions` 为空 → 全员按序回应（广播）
3. 每个回应者收到的上下文 = persona（若有）+ 聊天室公共记录
   （议题/最近对话，他人发言以"名字: 内容"呈现）；**不暴露他人 runtime 内部过程**
4. 回应捕获：promptAndWait 前后 diff 该参与者 transcript，新增 assistant 条目
   投影进共享 transcript（带 speaker）
5. 错误隔离：某参与者 runtime 报错 → 投影 error 条目（标注谁），聊天室继续
6. 用户 stop → 逐个 session stop；聊天室保持可继续（再发消息即恢复）

## UI（packages/ui）

1. **@ 输入**：Composer 输入 `@` 弹出参与者自动补全；选中的 @ 渲染为 chip；
   发送时组装 `mentions[]`
2. **参与者管理**：任务头部显示参与者列表（runtime 图标 + 名字），
   可增删（任务锁定前）；单参与者 = 现在的单 runtime 体验
3. **发言渲染**：每条 agent 消息带 speaker chip（runtime 色标）；
   广播回合之间显示轮次分隔
4. **轨迹视图**：事件按参与者分组着色（trajectory-view-model 加 participant 维度）
5. **成本可见**：头部显示 token 累计（按参与者分列，trace 已有 tokens 字段）

## 治理与限制

- 参与者上限 4（进程成本）；推荐 2-3
- 每回应者的上下文窗口策略 v1 用"最近 N 条公共记录全文"，膨胀后再压缩
- dsh 无 cold resume：其参与者失败即退出聊天室（投影提示），不阻塞他人
- 同一 runtimeId 多参与者（双 persona claude）v1 禁止，P2 评估

## 实施拆分

| 阶段 | 内容 | 验证 |
| :--- | :--- | :--- |
| P1a | contracts（ChatParticipant/mentions/speaker）+ chat-coordinator 路由与捕获 | server 单测：fake runtime，@ 单人/广播/错误隔离三场景 |
| P1b | TaskSession 接线 + 真双 runtime（pi+codex）@ 冒烟 | 集成冒烟 |
| P1c | UI：@ 补全 + 参与者管理 + speaker chip | typecheck + desktop/web 手工冒烟 |
| P2 | persona UI、agent 互 @、轮末 synthesizer、分诊路由 | 按需 |
| P3 | 并发发言 + 协调防御层 | 仅真实需求出现后 |

## 开放问题

1. 广播全员回应的体验：3 个 agent 抢答可能吵——若实测吵，P2 提前上分诊
2. 公共记录给回应者时的格式（"pi: ..."前缀 vs 结构化块）——v1 用前缀，简单直白
3. @ 全部是否要显式语法（@all）——v1 不加，"不 @ 即广播"已覆盖
