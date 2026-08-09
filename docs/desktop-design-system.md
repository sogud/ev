# EV Desktop Design System

EV Desktop 使用一套可跟随系统明暗外观、紧凑且内容优先的界面体系。目标不是复刻某个产品的皮肤，而是采用经过验证的桌面交互结构：语义化 Design Tokens、无样式 accessibility primitives、可搜索选择器，以及少量由 EV 自己维护的高层组件。EV Browser 复用同一套基础 token，但保持浏览器场景自己的组件边界。

## 事实来源与证据边界

本设计参考了本机安装的 Codex Desktop 和 ChatWise 包，而不是社区复刻项目：

- Codex bundle：`/Applications/ChatGPT.app/Contents/Resources/app.asar`
- Codex 版本：`26.727.51351`；包标识：`openai-codex-electron`
- ChatWise bundle：`/Applications/ChatWise.app/Contents/Resources/app.asar`
- ChatWise 版本：`26.7.8`；包标识：`chatwise`

| 结论                                          | 证据                                                                    | 置信度 |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| Codex 使用 Electron + React + Vite            | `package.json`、Vite chunks、React JSX runtime                          | 高     |
| Codex 使用 Tailwind CSS                       | `index.html` 明确声明 Tailwind layer order；bundle 中有 utility output  | 高     |
| Codex 使用 Radix primitives 和 cmdk           | `--radix-*` 变量、Radix runtime、`[cmdk-*]` selectors                   | 高     |
| Codex 使用 Floating UI、Framer Motion、Lucide | bundle runtime 和资源命名可识别                                         | 高     |
| Codex 高层控件来自内部 Design System          | 大量产品语义变量和自定义组件行为，而不是通用库默认皮肤                  | 中高   |
| ChatWise 使用 macOS system font stack         | CSS 明确使用 `ui-sans-serif, system-ui`，不以 Inter 覆盖系统字体        | 高     |
| ChatWise 的暗色层级接近系统材质               | CSS 中 main `#181818`、sidebar `#201f21`、popover `#27272a`、8px radius | 高     |
| ChatWise 使用 macOS hidden inset title bar    | main bundle 中 `titleBarStyle: hiddenInset` 和 traffic light position   | 高     |

这些是对已安装二进制的静态观察，不是 OpenAI 或 ChatWise 的官方技术声明。EV 不复制或分发提取出的源代码、资源或品牌资产，只记录技术事实和可迁移的设计原则。

## EV 的设计原则

1. **macOS 原生基线**：优先 system font、`hiddenInset` title bar、系统字重和标签透明度；不以 Web 品牌字体覆盖平台质感。
2. **内容优先**：任务、回复和变更是视觉主体；导航和边框保持安静。
3. **紧凑但不拥挤**：4px spacing scale，常用控件高度 28–36px，默认正文 13–14px。
4. **材质而不是卡片**：main、sidebar、popover 只用少量相邻中性灰；边界主要用半透明 hairline，不堆叠卡片和重阴影。
5. **语义优先**：组件只消费 `--ev-color-*` 等语义 token，不直接依赖灰阶或十六进制颜色。
6. **状态必须可读**：hover、active、selected、focus、disabled、error 不能只靠细微色差。
7. **键盘是一等输入**：弹层、菜单、模型搜索和设置导航必须支持 Tab、方向键、Enter 与 Escape。
8. **少量深模块**：Popover、Model Picker、Menu Picker、Field、Status 等模块隐藏焦点管理和 ARIA 细节；业务页面只传值与回调。
9. **克制的动效**：只对弹层、折叠和状态切换使用 100–220ms 动画，并尊重 `prefers-reduced-motion`。

## 单一事实源

运行时 token 的唯一事实源是：

```text
packages/design-tokens/theme.css
```

Desktop 与 Browser 都直接消费 `@ev/design-tokens/theme.css`。本文记录命名规则、使用边界和逆向结论，不重复维护 token 的具体值。修改颜色、间距、圆角、阴影或动效时，应先改共享 CSS，然后检查两个应用中使用该语义的组件。不增加重复 JSON、Tailwind preset 或第二份主题色表。

`data-theme="light|dark"` 或根节点 `.light|.dark` 表示明确主题；缺省时通过 `prefers-color-scheme` 跟随系统。Desktop 由 main process 持久化偏好并同步 Electron `nativeTheme`，Browser 由 `chrome.storage.sync` 保存偏好。

唯一的跨进程镜像值是 `BrowserWindow.backgroundColor`：它必须在 renderer CSS 加载前生效，因此 main process 不能直接消费 CSS variable。修改 canvas 色时必须同步检查 `apps/desktop/src/main/index.ts`，避免启动闪屏。

## Token 架构

### Primitive tokens

Primitive 只描述材料，不直接表达用途：

- 灰阶：`--ev-gray-*`
- 品牌/状态基础色：`--ev-blue-*`、`--ev-green-*`、`--ev-amber-*`、`--ev-red-*`
- 透明色：`--ev-white-a*`、`--ev-black-a*`
- 字体、字号、字重和行高：`--ev-font-*`、`--ev-line-height-*`
- 4px 间距：`--ev-space-*`
- 圆角和控件高度：`--ev-radius-*`、`--ev-control-height-*`

页面和组件不得直接消费 primitive color。它们只用于构造 semantic tokens。

### Semantic tokens

组件使用下面的语义层：

- Surface：`--ev-color-bg-canvas|sidebar|sunken|surface|raised|overlay|hover|active|selected|input|scrim`
- Foreground：`--ev-color-text-*`、`--ev-color-icon-*`
- Border：`--ev-color-border-subtle|default|strong|focus`
- Action：`--ev-color-action-primary-*`、`--ev-color-action-secondary-*`、`--ev-color-action-ghost-*`
- Status：`--ev-color-status-info|success|warning|danger`
- Elevation：`--ev-shadow-raised|overlay|modal`
- Motion：`--ev-duration-*`、`--ev-ease-*`
- Layer：`--ev-z-*`

当同一个颜色被用于两个含义时，也应保留两个语义 token。视觉值相同不代表语义相同。

## Desktop primitives

### Model Picker

模型选择不是原生 `<select>`：

- Trigger 始终显示当前模型；无任务时表示新任务默认值。
- 弹层提供搜索，匹配 Provider 名、模型显示名和模型 ID。
- 按 Provider 分组，只列出当前可用模型；已选但暂时不可用的模型可以保留显示并明确标记。
- 当前项使用图标和 `aria-selected` 双重表达。
- 支持方向键、Enter、Escape，并在关闭后把焦点还给 Trigger。
- 空状态明确说明“没有可用模型”，而不是显示空白列表。

### Runtime Picker

Runtime 切换不是原生菜单，由 `MenuPicker`（Base UI Menu + EV 视觉层）渲染：

- 唯一切换入口在 composer 下方 chip 行；首消息锁定后由调用方退化为静态 chip。
- 枚举 `RuntimeRegistry` 自报的全部 descriptor；每项展示 glyph、名称与版本/可用性描述。
- CLI 未安装的 runtime 在菜单内 disabled，不隐藏，避免列表缺失造成误解。
- 当前项使用 `aria-selected` 与视觉高亮双重表达；关闭后恢复 Trigger 焦点。

### Composer 与模型/强度选择（参照 Codex app）

证据来源：`/Applications/ChatGPT.app/Contents/Resources/app.asar`（版本 26.727.51351）静态观察，置信度高。

Codex 实现事实：

- composer 内单一 trigger 显示「模型名 + 强度」（如 `5.6 Sol 高`）；弹层向上开（Base UI Menu，`data-side=top`）。
- 强度控件不是原生 `<input type="range">`，而是带 `data-reasoning-slider` 的 Menu Item：离散档位，
  ArrowLeft/Right 增减、Enter 打开详情；`aria-label`「强度」、`aria-keyshortcuts`、
  `aria-valuetext` 形如「高，第 4 项，共 5 项」。
- 视觉：composer 底部为宽灰底圆角 pill trigger（模型名 + 档位居中）+ 麦克风 + 黑色圆形发送键；
  弹层内为厚圆角 track（约 28–34px）+ 离散档位圆点 + 约 30px 白色圆形 thumb，蓝色 fill；
  端点标签「更高效 / 更智能」；右上闪电为 fast mode；「高级」行展开更多选项；
  选 ultra 档显示「更快消耗使用额度」警告。
- 动效约 300ms `cubic-bezier(.23,1,.32,1)`，`prefers-reduced-motion` 下全部关闭。

EV 决策（2026-08-07 现状）：

- 对话框下方 chip 行 = 唯一配置/切换面：[Runtime ▾] [思考：X ▾] [模型 ▾]；sidebar 纯展示，
  聊天头部只留只读 runtime 徽章。首条消息后 chip 锁定为静态只读。
- Runtime chip 用 MenuPicker 列出全部 descriptor（可用性点 + 版本）；模型 chip 仅在 runtime
  声明 models 能力时出现，否则静态「原生模型」chip。
- 思考强度独立弹层，用离散阶梯滑块（用户定案用滑块不用菜单），实现为 `role="slider"` primitive：
  `aria-valuemin/max/now` + `aria-valuetext` + 方向键；不用原生连续 range。
- 弹层复用 EV 的 Base UI Menu/Popover 视觉层；fast mode 与「高级」不默认照搬，按需增加。
- 颜色只消费 semantic tokens；track 用 border 语义，fill 与 thumb 用 focus/raised 语义。

### Menu Picker

有限枚举（例如 reasoning effort 和主题）使用菜单式单选：

- Trigger 直接展示当前值。
- 选项数量少时不提供搜索。
- 使用 radio semantics；上下方向键移动，Enter/Space 选择，Escape 关闭。

### Dialog、Popover 与 Menu

EV 使用 Base UI 处理焦点陷阱、Portal、Escape、outside interaction 和 ARIA wiring；EV 自己维护视觉层。禁止依赖 Base UI 默认样式或把 Base UI 组件直接散落到业务页面。

### Field 与 Status

- Field 负责 label、description、control 和 error 的稳定关系。
- Status 同时提供图标/文字和颜色，不得只显示红点或绿点。
- destructive action 与普通 secondary action 必须有不同语义。

## 视觉层级

从低到高：

1. Canvas：主对话背景
2. Sidebar / Sunken：导航和代码/终端底层
3. Surface：表单、Composer、普通卡片
4. Raised：hover、选中行和内嵌工具面板
5. Overlay：Popover、Menu、Tooltip
6. Modal：设置和需要中断当前流程的操作

这是视觉材质顺序，不等同于 Portal 的 z-index。Modal 内打开的 Menu/Popover 会 Portal 到 `body`，因此 `--ev-z-popover` 必须高于 `--ev-z-modal`，否则弹层会被 Dialog 遮住。

阴影只用于 Overlay 和 Modal；普通列表行通过 surface 和 border 表达层级。

## 可访问性基线

- 正文目标为 WCAG AA 4.5:1；大文本和非文本控件至少 3:1。
- 所有仅图标按钮必须有可本地化的 `aria-label`。
- `:focus-visible` 使用统一 focus token，不移除 outline 后无替代方案。
- Dialog 打开时聚焦第一个可操作元素，关闭后恢复到原 Trigger。
- Popup 的最大高度受 viewport 限制，列表内部滚动。
- `prefers-reduced-motion: reduce` 时禁用非必要动画。

## 迁移规则

1. 新组件不得新增裸十六进制颜色或一次性 spacing 值。
2. 修改旧组件时，把触及区域迁移到 semantic tokens；不做无边界的全文件重写。
3. Renderer 已不使用原生 `<select>`；新增枚举控件使用 `MenuPicker`，模型使用 `ModelPicker`。禁止重新引入原生 select 作为临时实现。
4. 不为一次使用创建 wrapper；只有焦点、键盘、视觉或验证逻辑能够集中时才建立 primitive。
5. 基础 token 由 Desktop 与 Browser 共享；Base UI/cmdk 高层 primitives 仍留在各自应用，不建立只有一个真实消费者的共享 UI package。

## Do / Don’t

- Do：中性灰表面、清晰文字层级、可搜索模型列表、轻量边框、可预测键盘操作。
- Do：蓝色主要用于 focus、链接和运行状态，不作为大面积品牌底色。
- Don’t：原生 select、紫色渐变、过大圆角、卡片网格、重阴影和无意义动画。
- Don’t：根据 Codex 视觉猜测内部业务逻辑，也不要把第三方复刻项目当作官方源码证据。
