---
status: closed
type: grilling
hitl: true
assignee: pi
blocked-by: [0004]
closed: 2026-08-07
---

# 检查器信息结构及其与 transcript 的边界

## Question

- Trace 与 transcript 的分工：工具调用/模型事件的主展示位在哪一边？另一边如何引用？
- 工作区文件变更的阅读体验：列表、diff、按任务过滤？接受/撤销是否属于本规格？
- 检查器的入口语义：右侧面板、抽屉还是独立视图？与聊天主面板的共存关系？

## Resolution（2026-08-07，pi 定案，用户授权收官任务书）

- Trace 与 transcript 分工：主流程=transcript（0004 变体 C：文档流 + Changed Files 卡片 +
  turn 脚注）；过程=检查器 Trace 页。工具调用细节在检查器，结果在聊天。
- 工作区变更阅读：**diff-first**。文件列表=索引（按钮），点选看该文件 diff 段，默认第一个
  有 diff 的文件；整仓大 blob 不再直接铺。实现 `diff-split.ts` + 单测。
- 按任务过滤：不做（工作区级变更展示；per-task 归属延后）。
- 接受/撤销：**不属于本规格**（需要任务级文件归属与快照，另行提案）。
- 入口语义：右侧面板与聊天主面板共存（现状），不改。
