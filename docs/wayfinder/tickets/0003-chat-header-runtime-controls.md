---
status: closed
type: grilling
hitl: true
assignee: pi
blocked-by: []
closed: 2026-08-07
---

# 聊天头部控件与徽章的按 runtime 语义

## Question

已定（地图 Notes）：模型 / 思考（effort）选择器进 composer，参照 Codex app；头部不再放这两个控件。

待定：

- composer 内选择器的形态（pill / 下拉、与发送按钮的排布），Pi 与 Codex 各自的选项集。
- Runtime 徽章是只读标签，还是可点击（点击去哪：设置对应面板？）？
- 检查器入口的位置与命名（「任务检查器」是否改名、图标还是文字）？
- 头部最终保留什么：标题、工作区、徽章、检查器入口？

## Resolution（2026-08-07，pi 定案，用户授权收官任务书）

- composer 选择器形态：chip 行 [Runtime ▾][思考:滑块 ▾][模型 ]（2026-08-07 定案：思考用离散阶梯
  滑块独立弹层；Runtime 用 MenuPicker 列全部 descriptor）。首条消息后整行锁定为静态 chip。
- Runtime 徽章：**只读标签**（SPAN），不可点击；切换唯一入口在 composer chip 行（2026-08-06 定案）。
- 检查器入口：头部右侧图标按钮，aria「任务检查器」，不改名。
- 头部最终保留：标题 + 工作区按钮 + 只读 runtime 徽章 +「在编辑器中打开」+ 检查器入口。
- CDP 断言（2026-08-07）：badge tagName=SPAN；header buttons=[工作区, 在编辑器中打开, 任务检查器]；
  composer chips=[思考强度, 选择模型(, 选择 Runtime 当可切换)]。
