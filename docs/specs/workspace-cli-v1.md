# Workspace CLI v1

状态：已实现精简版。命令与配置以 [CLI 手册](../../apps/cli/README.md) 为准。

## 目标

用户始终可在根目录与任意 Agent 交流。EV 只负责找到并准备工作环境：
配置工作区和知识库路径、按目录或明确任务返回规则/文档/技能入口、复制技能到目标工作区。

不把已有工具重新包装为 EV 命令：Git 管仓库，QMD 管知识检索和索引，文件工具读写文档，
项目测试负责验证。不迁入 Harness 的 sync/import/status/readiness/doctor/catalog/link-globals。

## 配置与上下文

- 路径可配置，相对路径以配置文件所在目录为基准；知识库可在工作区外部或共享。
- 配置优先级为 --config、EV_WORKSPACE_CONFIG、从 cwd 向上寻找最近的工作区 manifest.json。
- 独立配置使用 workspaces；现有 AgentSpace manifestVersion 1 直接读取 workspace.routes、repos 与 project.json，不复制路由清单。
- context 合并之前的 list/inspect 和任务路由入口，不调用 Git 或执行外部程序。
- 未指定名称按 cwd 最深匹配；已知任务直接指定路由，需要到代码仓执行时加 --target。
- entryDocuments 是必读入口，onDemand 按需读取，skills 是候选，不加载全部技能正文。
- 路由继承检测循环；缺失声明给出告警，不凭旧记忆补全路径。

## 技能与平台边界

- 只保留 skills copy，支持 --dry-run；完整复制 SKILL.md、脚本和引用文件，来源始终保留。
- 同内容再次复制不改文件；目标有差异或为软链则拒绝覆盖。
- 拒绝来源/目的地嵌套、目的地越出工作区及技能内指向外部的软链。
- 失败保留来源和目标部分文件，报告需要检查的位置，不自动删除。
- 移除技能移动及 knowledge search/read/check，原有用户文件不因此改变。
- MCP 只返回关联配置文件路径，不读取凭据、不转换配置、不启动服务。
- 不修改任何 Agent 的全局配置，不接管登录、会话或技能加载；复制文件不保证运行中 Agent 已刷新。

## 协作与验收

简单任务直接改目标仓；同仓多任务并行修改才用 worktree，不增加编排器。
不自动提交、推送、发布、交易或安装服务。

测试验证不同 cwd、配置优先级、外部知识路径、manifest/project 单一事实源、
路由目标及候选隔离、循环与缺失路径、技能完整复制/重复/冲突/越界。
实际 CLI 测试不得启动 Server/Browser Host 或访问真实 EV_HOME。
真实工作区核对投资、创作、小说、开发入口；模型行为效果不由 JSON 测试代替。
