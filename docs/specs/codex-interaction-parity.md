# Codex Interaction Parity

EV Desktop 与 OpenAI Codex app 的交互对齐规范。事实源：本文件 + `/tmp/codex-app-strings.txt`
（从 ChatGPT.app 提取的 Codex 真实 CSS/i18n，临时素材）。样式 token 单一来源
`packages/design-tokens/theme.css`；UI primitives 只用 Base UI。

## A. ThinkingPicker（思考档位）

| Codex 交互                                                                             | EV 实现                                                                                                    | 涉及文件                                                  |
| :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- |
| 档位 label 固定英文原词 Off/Minimal/Low/Medium/High/XHigh/Max                          | `thinking.*` 各档 value 一律英文原词，不随 locale 翻译；trigger 只显示当前档英文词                         | `packages/locales/src/{en,zh}.json`、`ThinkingPicker.tsx` |
| Power slider：24px 胶囊 track、28px 白 thumb、拖拽吸附 tick、键盘 ←→/Home/End          | `EffortSlider`：pointer 拖拽 + 吸附 + 键盘控制，tick hover scale(1.6)+brightness(.85)、selected 白 32%     | `ThinkingPicker.tsx`、`styles/index.css` effort-slider 段 |
| Max 档蓝→紫渐变 fill + shimmer reveal（`_Mask_1lz3t` / `_Reveal_1lz3t`，2s mask 扫描） | `[data-max] .fill` 渐变 + `::after` mask 层，`@property --ev-effort-reveal` 驱动 `effort-reveal` keyframes | `styles/index.css`                                        |
| SliderEndpoints 端点词 Faster / Smarter                                                | popover 底部左右端点固定英文 Faster / Smarter                                                              | locales `thinking.endpointFast/Deep`                      |
| UltraUsageWarning（ultra/high 档一行警告）                                             | xhigh/max 时 popover 内一行 costWarning 文案                                                               | `ThinkingPicker.tsx`                                      |
| 高档位触发器警示                                                                       | xhigh/max 时 trigger 前置 amber dot（`[data-high]::before`）                                               | `ThinkingPicker.tsx`、`styles/index.css`                  |
| ⌘↑/⌘↓ 增减 reasoning effort（codexMicro.keycaps）                                      | Composer 聚焦时 ⌘↑/⌘↓ 循环增减档位，不开 popover                                                           | `Composer.tsx`                                            |

## B. 全局交互

| Codex 交互                                    | EV 实现                                                                              | 涉及文件                            |
| :-------------------------------------------- | :----------------------------------------------------------------------------------- | :---------------------------------- |
| Transcript 智能滚动：接近底部才跟随，上翻即停 | ≤80px 视为底部自动跟随；否则暂停并显示右下角浮钮回到底部                             | `Transcript.tsx`、`.jump-bottom`    |
| 回复 hover 出现复制按钮                       | turn hover 显示复制按钮，拷贝 Markdown 原文，1.5s 后恢复                             | `Transcript.tsx`、`.turn-copy`      |
| Composer 空输入 ↑ 召回上一条已发送 prompt     | 本地历史（最近 100 条），↑ 逐条回溯、↓ 返回，编辑即退出召回                          | `Composer.tsx`                      |
| 删除两段式确认：首点变红再点确认，超时复位    | 侧栏删除按钮首点进入 armed 红色态（文案"再点一次"），2.5s 未动复位                   | `Sidebar.tsx`、`.task-remove.armed` |
| ChangedFilesCard 头部 chevron+标题整行折叠    | 头部改为整行可点的 chevron+标题 toggle；移除 Expand all/Collapse all，保留 View diff | `Transcript.tsx`、`.cf-toggle`      |

## D. 设置面板与对话框统一行为

| Codex 交互                                             | EV 实现                                                                                                    | 涉及文件                                                                                  |
| :----------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| 设置面板左侧分区导航，键盘上下可选、选中态明确         | settings-nav roving tabindex + ArrowUp/ArrowDown 移动选中与焦点，`.active` 选中态                          | `SettingsModal.tsx`                                                                       |
| Esc 关闭、点击 scrim 关闭、焦点圈定与归还              | Modal 类由 Base UI Dialog 统一承担；InspectorPanel/FleetDrawer 等内联面板用 `useEscapeToClose` 补 Esc 路径 | `SettingsModal.tsx`、`hooks/useEscapeToClose.ts`、`InspectorPanel.tsx`、`FleetDrawer.tsx` |
| 开合动画统一 token 时长与缓动                          | backdrop/modal 动画一律 `--ev-duration-*` + `--ev-ease-*`                                                  | `styles/index.css` modal 段                                                               |
| 按钮语义：主按钮 accent 实心、次按钮 ghost、危险操作红 | `.primary-button` / `.ghost-button` / `.danger-button` 三件套                                              | `styles/index.css`                                                                        |
| 表单控件 focus 态统一 focus ring、错误态 status-danger | 全局 `:focus-visible` 走 `--ev-focus-ring`；错误态用 `--ev-color-status-danger(-surface)`                  | `styles/index.css`                                                                        |

## 已有的 accent 主题决策

design-tokens accent 化后，所有强调色（滑块 fill、primary 按钮、focus ring）统一引用
`--ev-color-accent` 及其 color-mix 派生，不再硬编码品牌色；max 渐变中的紫色为 Codex
chart-purple 对应物，以字面量 `#bf7af0` 与 accent 混用。
