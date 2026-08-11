# Spec — Desktop 交互表达层 v1

> 来源：wayfinder 地图（`docs/wayfinder/desktop-ui-interaction-map.md`）已定案决策的交接规格。
> 产品定位：EV 是各种 Agent + 各种工具的 UI 表达层；runtime 与工具实现可插拔，表达层是资产。
>
> v1.1 修订（精简原则）：右侧 process rail 与 sidebar 的 Agent 切换器/目录新建/runtime 分段/runtime 筛选
> 已删除；runtime 选择只留 composer rail 弹层；过程信息留给检查器。功能只保留当前必要。

## Problem Statement

EV Desktop 同时驱动 Pi 与 Codex 两类 runtime，后续还会接入更多 runtime 与通用工具
（浏览器、媒体下载、git 等）。当前 UI 是按「单 runtime 聊天器」长出来的：
transcript 把思考、工具调用、文件变更和答案混成一列气泡，过程淹没结果；
模型/思考等控制件位置随意；任务列表随历史增长失控；每接一个新 runtime 或新工具，
UI 都要重新发明一遍展示方式。用户要的是一个「不管底下跑什么 agent、什么工具，
信息都以统一、克制、macOS 原生的方式表达出来」的桌面端。

## Solution

把 Desktop 主界面重构成一个 runtime 中立的表达层：

- **主流程只表达结果**：助手输出为连续文档流；本轮文件变更以 Changed Files 卡片摘要；
  每个 turn 有时间·时长脚注。
- **过程去右侧 rail**：thinking、工具调用、edit、media、browser 等以 chip 呈现，
  hover/点击出 popover 看详情，主流程永不被过程淹没。
- **控制件归位 composer**：模型 + 思考档位统一为 composer 内单一 trigger，
  弹层内用离散阶梯滑块；头部不放这两个控件。
- **任务列表默认收敛**：runtime 筛选 + 默认只看最近/活跃，「显示更多」展开完整历史。
- **设置顶层按 runtime 分**：通用 / Pi / Codex / Agent / Browser。
- 新 runtime / 新工具 = 加表达组件，不改骨架。

## User Stories

1. 作为一个 EV 用户，我想让主流程只显示答案和结果产物， so that 我扫一眼就知道这轮做了什么。
2. 作为一个 EV 用户，我想把思考过程默认折叠到右侧 rail， so that 长会话不被推理文本淹没。
3. 作为一个 EV 用户，我想用 rail 上的 chip 逐个查看工具调用详情， so that 需要审计过程时一步可达。
4. 作为一个 EV 用户，我想在答案后看到 Changed Files 卡片（文件树 + 逐文件 ±统计）， so that 我不用打开 diff 就能评估改动规模。
5. 作为一个 EV 用户，想点「View diff」进检查器看完整 diff， so that 摘要与详情各司其职。
6. 作为一个 EV 用户，我想点「Collapse all」一键收起文件树， so that 大改动的卡片不撑爆主流程。
7. 作为一个 EV 用户，我想在每个 turn 末尾看到「时间 · 时长」脚注， so that 我能感知成本与速度。
8. 作为一个 EV 用户，我想在 composer 里一个 trigger 看到当前模型和思考档位， so that 控制件位置可预期。
9. 作为一个 EV 用户，想用阶梯滑块（≤5 档）调思考强度， so that 离散档位比连续滑杆更可控。
10. 作为一个 EV 用户，想用 ←/→ 方向键调整强度档位， so that 键盘流不离开 composer。
11. 作为一个 EV 用户，想让屏幕阅读器读出「高，第 4 项，共 5 项」， so that 滑块是可访问的。
12. 作为一个 EV 用户，想让聊天头部只保留标题、runtime 徽章和检查器入口， so that 头部不堆控制件。
13. 作为一个 Pi 用户，想按「全部 / Pi / Codex」筛选任务列表， so that 多 runtime 历史不互相干扰。
14. 作为一个 EV 用户，想默认只看到最近/活跃任务， so that 列表不随历史失控。
15. 作为一个 EV 用户，想用「显示更多」展开完整历史， so that 收敛不等于丢失。
16. 作为一个 EV 用户，想在设置顶层看到 通用 / Pi / Codex / Agent / Browser， so that 设置按责任域分组。
17. 作为一个 EV 用户，想新任务 = 当前分段 runtime + 当前 Agent + 默认工作区， so that 创建流程一步完成。
18. 作为一个 EV 用户，想用目录图标按钮另选工作目录， so that 默认与例外分离。
19. 作为一个 EV 用户，想让 media / browser 工具的结果也以既有表达组件出现， so that 工具增多不带来新的 UI 方言。
20. 作为一个 EV 用户，想在浅色/深色主题下得到一致的语义配色， so that 主题切换不破坏信息层次。
21. 作为一个 EV 用户，想在 `prefers-reduced-motion` 下关闭弹层动效， so that 动画不造成干扰。
22. 作为一个 EV 用户，想让历史会话只读打开时不改动原文件， so that Pi/Codex 原生历史保持单一事实源。
23. 作为一个 Codex 用户，想看到能力差异以降级提示表达而非报错， so that 跨 runtime 体验可预期。
24. 作为一个 EV 用户，想让 thinking 只在 rail 出现、不在主流程重复， so that 同一信息只有一个家。
25. 作为一个 EV 用户，想让 turn 的进行态（running）在 rail 与脚注上可见， so that 我知道 agent 还在工作。
26. 作为一个 EV 用户，想让长文档流内的代码以 inline code chip 表达、长代码块可折叠， so that 密度可控。
27. 作为一个 EV 用户，想让检查器入口固定在头部右侧， so that transcript 与检查器的边界稳定。
28. 作为一个未来接入 Claude Code / Qoder 的用户，想让新 runtime 复用现有表达组件， so that 接入成本是适配器而不是新 UI。
29. 作为一个 EV 用户，想让键盘焦点在弹层打开时有可见 ring， so that 键盘导航可追踪。
30. 作为一个 EV 用户，想让空 transcript 不显示 rail， so that 无过程时不出现空栏。

## Implementation Decisions

- **表达层词汇（runtime 中立）**：`thinking` / `process-step` / `changed-files` / `media` /
  `browser` 各是一种表达组件；新工具 = 加组件，不改骨架。这是本规格的架构核心。
- **单一新 seam：transcript view-model mapper**。纯函数，把 `@ev/contracts` 的 runtime 事件
  映射为表达结构；所有逻辑测试落在这一层。表达组件只消费 view-model，不碰 runtime 事件。
- **Transcript = 变体 C**（wayfinder ticket「Transcript 信息结构」定案）：
  主流程 = 引用块用户问题 + 文档流答案 + Changed Files 卡片 + turn 脚注；
  过程 = 右侧 rail chips + hover/点击 popover；thinking 只在 rail。
- **Changed Files 卡片结构**（来自原型 `docs/wayfinder/assets/0004-transcript-variants.html`）：

  ```text
  CHANGED FILES (N) · +adds / −dels      [Collapse all] [View diff]
  ▾ <common prefix>
      <relative path>        +a −d
  turn 脚注: HH:MM · 时长
  ```

  `View diff` 导航到检查器——transcript 只留摘要，检查器持有详情（与 ticket
  「检查器信息结构及其与 transcript 的边界」的既定边界）。
- **Composer 模型/强度**（参照 Codex app，见 `docs/desktop-design-system.md`
  「Composer 与模型/强度选择」）：单一 trigger「模型名 + 档位」居中灰底 pill；
  弹层向上开；强度为离散阶梯滑块（≤5 档），a11y 契约：

  ```text
  role="slider" aria-label="强度" aria-valuemin=1 aria-valuemax=N
  aria-valuenow=k aria-valuetext="<档位名>，第 k 项，共 N 项"
  键盘: ArrowLeft/Right 增减（Base UI Menu Item 承载，非原生 range）
  ```

- **聊天头部**：标题 + runtime 徽章 + 检查器入口；模型/思考不进头部。
- **任务列表**：runtime 分段筛选（全部/Pi/Codex）；默认收敛最近/活跃；「显示更多」展开。
- **设置顶层**：通用 / Pi / Codex / Agent / Browser；现有 tab 按此映射迁移
  （迁移表留待 ticket「设置顶层重组」细化，本规格只定顶层）。
- **创建流程**：新任务 = 当前分段 runtime + 当前 Agent + 默认工作区；目录图标 = 另选目录。
- **视觉**：只消费 `@ev/design-tokens` 语义 token；`light-dark()` 双主题；
  弹层动效 ≤300ms，`prefers-reduced-motion` 全关。不做整体视觉重设计。
- **历史只读**：Pi/Codex 原生会话为单一事实源；只读打开不得写文件。

## Testing Decisions

- 好测试 = 只测外部行为：view-model mapper 测「给定 contracts 事件序列 → 表达结构」；
  表达组件测「给定 view-model → 渲染结构/交互」（不测内部 state 命名）。
- **Seam 1（新，最高逻辑点）**：view-model mapper 纯函数单测。
- **Seam 2（现有）**：renderer 组件测试，先例 `ChatPanel.test.tsx`、`ModelPicker.test.tsx`、
  `AgentPicker.test.tsx`；store 行为先例 `useAppStore.test.ts`。
- **Seam 3（现有）**：contracts schema 测试，先例 `packages/contracts/src/index.test.ts`，
  保证新表达结构的 wire format 校验。
- 交互细节（滑块键盘、popover 折叠）用组件级测试覆盖外部可观察行为
  （aria 属性、DOM 结构、回调），不快照样式。

## Out of Scope

- 检查器内部信息结构（ticket「检查器信息结构及其与 transcript 的边界」）。
- 权限模式 / 头部按 runtime 的徽章语义细节（ticket「聊天头部控件与徽章的按 runtime 语义」）。
- Agent 概念定位（ticket「Agent 概念定位及其与 runtime 的关系」）。
- 空态 / 错误态 / 首次启动（ticket「四大块的空态、错误态与首次启动体验」）。
- 设置顶层以下的详细迁移表。
- 整体视觉重设计；Evals 流程；Browser 配对流程。
- 远程 / mobile（TODO 第五阶段，远期）。
- 实现本身之外的 runtime 适配器新增。

## Further Notes

- 参照基准：Codex app（用户指定交互基准）；次级参照 t3code（Changed Files 卡片、
  turn 脚注、过程/结果分层的开源实证）。证据与模式清单见 wayfinder 地图 Notes。
- 原型：`docs/wayfinder/assets/0004-transcript-variants.html?variant=C`。
- 本规格是 wayfinder 已定案决策的交接物；未定案部分以地图「Not yet specified」为准。
- 实现交接后，按 EV 仓自身验证命令跑 `pnpm run verify`。
