# Spec — 全原生认证 + 设置可视化 v1

> 来源：2026-08-08 用户定案——"EV 跟任何 provider 不关联，全部走原生的认证信息，
> 包括 PI。EV 只是做可视化展示。"
> 定位延续：EV 是表达层。本 spec 解决"认证归属"——EV 零凭据持有，全归 runtime 原生。

## Problem Statement

当前 EV 自己管理 provider 凭据：`providers:loginApiKey/loginOAuth/saveCustom/removeCustom`
一整套登录/存储链路，API key 和 OAuth 状态存在 EV 的 store 里，Pi 运行时由 EV 注入凭据。
后果：

- EV 与 provider 强耦合，违背"表达层不持有状态"的定位
- 与其他三个 runtime（codex/claude/qoder 全走 CLI 原生认证）模式不一致
- 设置页只有 Pi 挂了真实设置，其余三家是空壳卡片，体验割裂（用户实测反馈）
- 凭据安全负担在 EV 侧（safeStorage 降级问题也源于此）

## Solution

**原则：EV 不存、不注入、不管理任何凭据。认证一律 runtime 原生，EV 只读探测 + 可视化。**

### 设置页新形态（四 runtime 同构）

每个 runtime 块统一三段：

1. **原生登录态**（只读探测）：已登录/未登录/无法确定 + 账号信息（能读到就显示）
2. **原生配置位置**：配置文件路径展示
3. **操作**：打开配置文件（系统编辑器）/ 复制登录命令（如 `codex login`）/ 引导文案

不再有 EV 侧的登录表单、API key 输入、OAuth 跳转。

### 原生认证探测（各 runtime）

| Runtime     | 登录态探测                                        | 配置文件                                 |
| ----------- | ------------------------------------------------- | ---------------------------------------- |
| pi          | `~/.pi/agent/auth.json` 存在性与结构有效性        | `~/.pi/agent/auth.json`、`settings.json` |
| codex       | `~/.codex/auth.json`（或 `codex login` 状态探测） | `~/.codex/`                              |
| claude-code | `~/.claude/.credentials.json` 或等价物            | `~/.claude/`                             |
| qoder       | qodercli 原生凭据位置（实测确认）                 | 待实测                                   |

探测一律只读；探测失败显示"无法确定"而非猜测。具体路径以实现时实测为准，
写进代码注释，不靠记忆。

### Pi adapter 认证切换

Pi 运行时改用 `~/.pi` 原生认证启动/连接，EV 不再注入 provider 凭据。
EV 与 pi 的交互只走会话驱动（prompt/事件），认证由 pi 自己解决。

### 保留项（不属于认证，不动）

- 任务级选模型、选思考档：EV 驱动 runtime 的能力，保留
- 模型列表：从 runtime 原生/CLI 只读读出（modelCatalog 现状延续），EV 不维护模型库

## 拆除清单

- registry：`providers` 命名空间的 login/save/remove 类 call 删除或降级（保留 list 只读）
- renderer：ProviderSettings 登录功能移除，改造为原生状态展示组件
- server/store：EV 侧 provider 凭据存储删除（含 safeStorage 降级残留）
- 现有用户数据：EV store 里已存的 provider 凭据不做迁移——提示用户改用原生登录，
  旧数据删除（凭据不留存是原则，不做"导出迁移"）

## 验收标准

- [ ] EV 代码库中无任何凭据存储/注入路径（grep 验证）
- [ ] 设置页四 runtime 同构，各自显示真实原生登录态（本机实测：pi/codex/claude 已登录，
      qoder 按实际状态）
- [ ] Pi 不注入凭据也能正常起任务（原生认证生效）
- [ ] verify / typecheck / golden-path 全绿（golden 旅程含"设置页四块渲染"断言）

## 阶段

1. P1：探测层（四家原生登录态只读探测 + registry 只读化）
2. P2：设置页改造（同构三段式）
3. P3：Pi adapter 切原生认证 + 拆除 EV provider 存储

每阶段收尾 verify + typecheck + golden-path 全绿。不 commit 直到用户验收。

## 实施记录（2026-08-09 完成，P1/P2/P3 全过）

四家原生凭据路径（本机实测，只读探测）：

| Runtime     | 登录态探测                                                 | 配置文件                                 |
| ----------- | ---------------------------------------------------------- | ---------------------------------------- |
| pi          | `~/.pi/agent/auth.json`（provider→凭据 dict，非空=已登录） | `~/.pi/agent/auth.json`、`settings.json` |
| codex       | `~/.codex/auth.json`（tokens/OPENAI_API_KEY 存在=已登录）  | `~/.codex/auth.json`                     |
| claude-code | macOS keychain 条目 `Claude Code-credentials`（acct=账号） | `~/.claude/`                             |
| qoder       | `~/.qoder/.auth/user` 存在且非空=已登录（内容加密不解析）  | `~/.qoder/.auth/`                        |

拆除清单执行：registry login/save/remove/respondToAuth 删除；ProviderSettings 登录 UI 删除；
management provider 方法/models.json 写入删除；supports* 恒 false 不读密钥存在性；
CustomProviderInput/AuthPromptPayload 类型删除。EV store 无凭据（核验 0 个 apiKey）。
写面核验：server 仅写 ~/.ev（launcher/server.json/ev.db），零原生配置触碰。
