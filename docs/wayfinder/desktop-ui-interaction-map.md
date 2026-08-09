# EV Desktop 交互决策规格地图（wayfinder:map）

## Destination

产出可交接的 EV Desktop 交互决策规格：侧边栏、聊天主面板、设置、检查器四大块的
信息架构与交互决策全部定案。实现不属于本地图。

## Notes

- 领域：EV Desktop（Electron + React + design tokens）。每个 session 先读
  `docs/desktop-design-system.md` 与 `docs/agent-runtime-adapters.md`；涉及实现现状时读
  `apps/desktop/src/renderer/src/components/`。
- 需要时咨询 frontend-ui-engineering / ui-ux-pro-max 技能；HITL ticket 必须与用户实时对话。
- 与用户用中文沟通。
- **产品定位（用户确认，2026-08）：EV 是各种 Agent + 各种工具的 UI 表达层**（见 README）。
  runtime 与工具实现可插拔；表达层组件（transcript / composer / 检查器 / sidebar）与通用工具是资产。
  本地图的每个决策先问：新 runtime / 新工具能否复用现有表达组件？
- **参照基准：Codex app 是交互参照基准（用户指定）。** 任何新决策先对照 Codex app 是否已有范式；
  对照结论必须沉淀回本 Notes，不允许只留在会话里。
- **次级参照：pingdotgg/t3code**（开源同类 control surface；证据：repo docs + 官方截图，2026-08）。
  可借鉴模式（按 ticket）：
  - 0001：sidebar 按 project 分组 + 状态点（Completed/Working）+ 相对时间 + 组内「Show more」收敛。
  - 0003：权限模式是 composer 内 per-thread 控件（Supervised / Auto-accept edits / Auto / Full access）；
    composer 底行可并排「模型 ▾｜思考·verbosity ▾｜环境 ▾｜权限 」；发送键旁 context 用量环；
    composer 下方环境/分支工具条（Local checkout + branch picker），环境首条消息后锁定、分支随时可换。
  - 0004/0005：结果 inline、过程折叠为 Changed Files 卡片（文件树 + 逐文件 ±统计 + Collapse all / View diff）；
    turn 脚注「时间 · 时长」；diff 从头部/卡片进右侧检查器。
  - 远程 / mobile 是已确认的远期目标（用户，2026-08）：该阶段以 t3code 的 RPC 边界、
    per-method scope 授权、connection supervisor 为主参照；见 `../specs/roadmap.md`。
    当前阶段保持 local-first，但保住 seam：contracts 同构、IPC ⇄ RPC 可换。
  - 不照搬：event-sourced orchestration、worktree-per-thread 默认。
- Charting 访谈立下的 standing decisions：
  - 范围限四大块；Evals、Browser 配对只在与主线直接相关时触及。
  - 任务列表：runtime 筛选（全部/Pi/Codex）+ 默认收敛最近/活跃，「显示更多」展开完整历史。
  - 设置顶层按 runtime 分：通用 / Pi / Codex / Agent / Browser。
  - 创建流程保持现状三件套并语义化：新任务 = 当前分段 runtime + 当前 Agent + 默认工作区；
    目录图标 = 另选目录。
  - 模型 / 思考（effort）选择器放进 composer：统一 trigger「模型 + 档位」+ 离散阶梯滑块弹层。
    实现参照与 EV 决策见 `../desktop-design-system.md`「Composer 与模型/强度选择」。
  - 聊天主面板与检查器做完整一轮决策。
  - 视觉边界：交互 + 局部视觉整理，不做整体视觉重设计。
- Tracker 约定见 `README.md`；ticket 用名字引用，不用裸编号。
- 参照层级 v2（2026-08-05，用户定案）：
  - **t3code = 总体交互骨架参照**：sidebar 按项目分组（可折叠、状态点、相对时间、Show more）、
    composer 底行控件组（模型 · 强度 · 环境 · 权限 · context 环）、细节进侧 panel、
    Changed Files 卡片与 turn 脚注。**视觉风格细节不抄 t3code**（EV 自有 light 主题与 tokens）。
  - **Codex app = 具体范式参照**：composer 内模型/强度 trigger、离散阶梯滑块等细节范式。
  - Gap 审计与采纳：
    - ✅ Changed Files 卡片 / turn 脚注 / 过程-结果分层（已采纳，变体 C）。
    - ✅ 任务列表收敛 → 本轮再采纳项目分组：按 Agent Project 分组、组头可折叠、行内相对时间；
      runtime 筛选保留为二级过滤。
    - ⏳ composer 底行：环境/分支/权限/context 环对应 EV 的 workspace/runtime/token 跟踪，随
      ticket 0003/0005 讨论，不单独抄。
    - ⏳ 细节进 panel：rail chip / View diff → inspector，ticket 0005。
    - ✗ 不采纳：顶栏 git 动作组（Add action / Commit & push），超出当前产品边界。
- t3code provider rail 模式采纳（2026-08-06 实现）：
  - composer 弹层左 = runtime 图标栏（π/Cx monogram + 可用性点 + 选中指示条），
    右 = Pi 可搜索模型列表 / Codex 原生说明卡；底部思考阶梯滑块（仅 thinkingLevels 能力）。
  - 续跑会话锁定 runtime（等价 t3code lockedProvider）：rail 其它项 disabled + tooltip；
    新任务自由切换，并同步 sidebar 的 runtime 分段。
  - 设置 Pi/Codex 页顶 = runtime 健康行（状态点 + 版本 + message/原生认证），
    对照 t3code Providers 页；contracts `RuntimeDescriptor` 增加可选 `message`。
  - 不采纳：provider 多实例（custom instance）、favorites、⌘ 快捷键、accent color——
    EV v1 的 runtime 即实例，保持单一事实源。
- 套壳/控制面景观（2026-08 调研，ticket 0006 证据）：
  - 纯套壳（不拥有 runtime，驱动已装 CLI）已成拥挤类别：t3code、CloudCLI/Claude Code UI、
    CyDo、Clideck、HolyClaude、Agent Cockpit、OpenLobby、TermHive、Tide Commander、
    ClauBoard 等；编排向：Superset（并行 CLI agent + worktree + PR）；
    编辑器向：Zed ACP（Gemini CLI/Claude Code/Codex/OpenCode/Copilot/Cursor/Pi）；
    平台向：GitHub Agent HQ（repo/PR 原生，Claude+Codex）。
  - 驱动力：官方 runtime 开放协议（Codex app-server、Claude Code SDK、ACP），套壳门槛低。
  - 竞争轴：多 runtime 聚合、并行编排、form factor、diff/review、团队功能。
  - EV 差异化保持：浏览器一等公民（CDP+媒体下载，同类几乎没有）、原生历史单一事实源、
    local-first 隐私边界、表达层组件资产；官方 app 迭代快，纯壳功能易被吸收，不投同质功能。
- EV 价值三层（2026-08 用户访谈定调）：学习（协议/适配器/安全模型/CDP 的系统设计练场）、
  包装（runtime-neutral 表达层 + local-first 安全模型的叙事与可开源资产）、
  赋能（个人并行任务控制台：多仓/多需求并行、worktree 隔离、diff 审查、合并——日常工作驱动器）。
- Superset 参照点（并行编排）：worktree-per-task 为隔离单元（分支+终端+端口）；
  任务卡 live 状态；agent 暂停提问/内联权限批准；Auto-run vs stage 开关（记住偏好）；
  跨 workspace 比较结果合并最优；Settings→Agents 命令模板化。
- 控制面质量范式（job-first not chat-first）：任务板/收件箱（状态+changed files+测试+风险）、
  Plan→Execute→Review→Ship、diff-first 逐文件/块 accept-reject、⌘K 调度器、
  顶栏上下文动作（Open in editor / Commit & push）、composer 下分支/环境条、完成通知。
- “low” 感两源：视觉密度/层级不足 + 缺 job-first 表面（全 chat-first）。
- Agent 选择规则（2026-08 用户定案）：默认第一个 Agent Project；会话开始前（空态 + 0 消息 welcome）可切，
  开始后锁定不渲染入口；入口 = composer trigger 旁的 MenuPicker；`tasks:setAgent` 同步 agentId/agentName/cwd。
- 精简 pass（2026-08，用户定案：功能越少越好、模块化、好维护）：
  删除 sidebar 四区（Agent 切换器头、从目录新建、runtime 分段、runtime 筛选）与右侧 process rail；
  runtime 选择只留 composer rail 弹层；过程信息 v1 不展示，留给检查器（0005）；
  AgentPicker 组件与 rail 相关 CSS/view-model 死代码同删。sidebar = 新任务 + 分组列表 + 页脚。
- 视觉质量 pass v1（2026-08，用户定案纯 UI 轻量集）：状态色统一走 semantic tokens
  （status-dot/rail-dot/health-dot/task-remove）、composer 下只读 branch 徽章（Local checkout）、
  顶栏「在编辑器中打开」。**⌘K 调度器与并行编排明确暂缓**（用户：现在不需要编排，纯 UI 层不加过多）。

## Decisions so far

<!-- 每个 closed ticket 一行：名字 — gist + 链接 -->

- Transcript 信息结构 — 变体 C：主流程=结果（文档流 + Changed Files 卡片 + turn 脚注），过程=右侧 rail chips；[tickets/0004](tickets/0004-transcript-structure.md)
- 任务列表收敛 — 7 天窗口 + running/error 永见 + 原位展开/收起；不加筛选控件（sidebar 纯展示定案优先）；标题标记/URL 回退规则；[tickets/0001](tickets/0001-task-list-filter-collapse.md)
- 聊天头部控件 — 徽章只读不可点；头部=标题+工作区+只读徽章+编辑器入口+检查器入口；模型/思考/Runtime 全在 composer chip 行；[tickets/0003](tickets/0003-chat-header-runtime-controls.md)
- 检查器结构 — transcript 主结果 / 检查器主过程；变更页 diff-first（文件索引+按文件 diff）；接受/撤销与 per-task 过滤不属本规格；[tickets/0005](tickets/0005-inspector-structure.md)
- 空/错/首跑态 — 四块状态矩阵定案；无模型首跑提示 empty-hint；不做 onboarding 底线不变；[tickets/0007](tickets/0007-empty-error-first-run-states.md)
- Agent=runtime，删 Agent Project 层（2026-08-06 用户定案）：用户心智中「Agent」即执行引擎
  （π/Codex/Claude Code/Qoder），.agent/agent.yaml、指令文件、Evals、设置里 Agent 管理入口全部删除。
  Runtime 唯一切换入口在对话框下方 chip 行（[Runtime][思考][模型]），首条消息前可换、之后锁定静态 chip；
  sidebar 纯展示（平铺任务列表 + 只读 glyph），不放任何切换交互。
- 思考强度用离散阶梯滑块、独立弹层（2026-08-07 用户定案：用滑块不用菜单）。
- 设置 Runtime 页改 descriptor 驱动（2026-08-07）：runtimes:list 几个就渲染几行健康行，
  Pi 行下挂 provider/资源管理；不再硬编码 Pi/Codex 两页。

## Not yet specified

- Codex 设置面板在 sandbox/approval 之外的内容（model catalog、effort 等），随 Codex adapter 能力演进再定。
- 任务列表是否引入置顶/收藏；标题是否允许自动摘要。

## Out of scope

- 实现/重构代码——destination 只要规格，实现另行交接。
- 整体视觉重设计。
- Browser 配对流程重设计。
