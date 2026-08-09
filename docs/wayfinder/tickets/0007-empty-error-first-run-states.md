---
status: closed
type: grilling
hitl: true
assignee: pi
blocked-by: []
closed: 2026-08-07
---

# 四大块的空态、错误态与首次启动体验

## Question

- 侧边栏、聊天主面板、设置、检查器各自的空态 / 加载态 / 错误态显示什么？
- Runtime 未安装（Pi 或 Codex 缺失）时，分段控件、创建流程、设置面板如何表达？
- 首次启动（无任务、无 Agent Project）的引导边界：不做什么 onboarding 的底线是什么？

## Resolution（2026-08-07，pi 定案，用户授权收官任务书）

- 侧边栏：空「还没有任务」；加载=骨架不成立（启动即全量加载）；错误=全局 toast。
- 聊天主面板：无任务「开始一个任务」；任务工作空间缺失「任务工作空间不可用」+
  「使用默认工作空间新建任务」；0 消息=欢迎态 + composer chip 行。
- 首跑/无模型：pi 等 models 能力 runtime 在无可用模型时，空态与欢迎态显示
  「当前 Runtime 需要先在设置里登录模型 / Provider。」（empty-hint）；非模型 runtime 不适用。
- Runtime 未安装：composer Runtime 菜单项 disabled +「CLI 未安装」；设置 Runtime 页健康行
  err 点 + descriptor message；不自动安装（既有定案）。
- 设置：加载/错误走全局 toast；Browser 页有自身配对状态（既有）。
- 检查器：空 trace「运行任务后…」；非 Git 仓库提示；读取中/错误态既有。
- 首次启动底线：**不做 onboarding**（自动创建 ~/.ev/workspace 即全部引导，既有定案）。
