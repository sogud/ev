---
status: closed
type: prototype
hitl: true
blocked-by: []
asset: ../assets/0004-transcript-variants.html
---

# Transcript 信息结构：气泡、工具调用、思考、文件变更

## Question

- 用户/助手气泡、工具调用、思考过程、fileChange 四类内容的展示形态与层次。
- 长会话的密度与折叠策略：哪些默认折叠、按什么粒度展开？
- 产出一个粗糙原型（静态 HTML 或 React stub）给用户反应，再定案。

## Resolution

**定案：变体 C — 文档流 + 过程边栏**（用户 2026-08 选定，原型 `../assets/0004-transcript-variants.html?variant=C`）。

信息结构：

- 主流程 = 结果。用户问题为引用块；助手输出为连续文档流（段落、表格、inline code chip）。
- 本轮文件变更 = Changed Files 卡片，跟在答案后：
  头部 `CHANGED FILES (N) · +a / −d` + `Collapse all` / `View diff`；
  文件树 + 逐文件 ± 统计。`View diff` 进检查器——transcript 只留摘要卡片（与 0005 的边界）。
- turn 脚注：`时间 · 时长`。
- 过程 = 右侧 rail。thinking、工具调用、edit、media、browser 等以 chip 呈现，
  hover/点击出 popover 看详情；主流程永不被过程淹没。
- 折叠策略：结果默认展开；过程详情默认折叠（rail popover）；thinking 只在 rail。

表达层词汇（产品定位：Agent + 工具的 UI 表达层）：

- thinking / process-step / changed-files / media / browser 各是一种 runtime 中立的表达组件；
  新 runtime 或新工具进来 = 加表达组件，不改骨架。

参照证据：Codex app（交互基准）；t3code（Changed Files 卡片、turn 脚注、过程/结果分层的开源实证）。

不做：整体视觉重设计；实现另行交接。
