# EV CLI

`ev` 提供受限的 `ev browser` 浏览器控制能力。它既可随 EV Desktop 使用，也可完全独立运行：

```text
ev CLI → Desktop 或 standalone Browser Host → EV Browser → Chrome CDP
```

CLI 优先复用正在运行的 EV Desktop Browser Host；如果 Desktop 不存在，会自动启动用户级 standalone Browser Host。CLI 不读取或显示 Bridge pairing token，也不直接 attach Chrome。

Standalone Host 采用**首次批准、之后自动重连**的配对模型：任何本机 `chrome-extension:` origin 都可以发起配对请求，但只有被显式批准后才受信任，批准时下发 pairing token，扩展保存该 token，后续重连（换目录重新加载、Host 重启、重建扩展）都不再需要人工介入。Host 不内置任何扩展 ID 白名单——解压加载的扩展在换机器或换目录时会被 Chrome 分配新的 ID，按 ID 放行会让正常的本地开发构建无法连接。

新浏览器首次连接时：

```bash
ev browser pairing list                 # 查看等待批准的请求，输出里带 approve 命令
ev browser pairing approve <browser-id>
ev browser pairing reject  <browser-id>
```

扩展未批准时执行任何浏览器命令会失败，并在报错里直接给出待批准请求和对应的 approve 命令行；`pairing` 命令支持 `--profile <name>`。

## 安装

全局 npm 包：

```bash
npm install --global @sogud/ev
# 或
npm install --global @sogud/ev
```

也可从 GitHub Release 下载当前平台的单文件程序，例如 `ev-darwin-arm64`，赋予执行权限后放入 `PATH`。EV Desktop 还会自动创建 `~/.ev/bin/ev` launcher，并将其加入内置 Pi Runtime 的 `PATH`。

## 使用

### Workspace（不依赖任何 Agent）

只做三件事：配置路径、返回任务入口、复制技能。不启动 Server、Browser Host 或 MCP，
不修改 Agent 全局配置，不封装 Git、QMD 或项目检查。

```bash
ev workspace context
ev workspace context creator
ev workspace context development --target ev
ev workspace context creator --config /path/to/manifest.json
ev workspace skills copy writing --workspace creator --config ./workspaces.json --dry-run
ev workspace skills copy writing --workspace creator --config ./workspaces.json
```

输出默认 JSON。`context` 未指定名称时按 cwd 选择最深匹配的工作区；指定名称可选任务路由或工作区。
`--config` > `EV_WORKSPACE_CONFIG` > 从 cwd 向上查找最近的工作区 `manifest.json`。
不修改任何全局“当前工作区”。从不属于工作区的目录调用时显式传配置和名称。

独立使用的最小配置如下，文件名、工作区和知识库位置均可自定：

```json
{
  "workspaces": {
    "creator": {
      "root": "./creator",
      "knowledgeRoot": "./knowledge",
      "entries": ["./creator/AGENTS.md"],
      "onDemand": ["./knowledge/Create/index.md"],
      "skillsDir": "./creator/.agents/skills",
      "skills": { "writing": "./library/writing" },
      "mcpFiles": ["./creator/.mcp.json"]
    }
  }
}
```

所有配置路径相对配置文件解析，也支持绝对路径，不支持 `~` 或变量插值。
`root` 必填；`skillsDir` 可自定义但必须在工作区内；知识库可在外部或共享。
`entries` 是必读入口，`onDemand` 只在请求相关时读；结果仅返回路径，不读 MCP 内容或凭据。
缺失入口、技能或目录显示告警并返回 1，不静默创建内容。

已有 AgentSpace 格式的 `manifestVersion: 1` 清单无需再写一份 `workspaces`：

- `repos[].path` 定位代码仓；`workspace.projectRoots` 指定非代码项目或项目父目录，只找本层及下一层的 `project.json`。
- `workspace.entries` 和 `workspace.routes` 继续作为入口和任务路由真源，支持 `base/target/entries/onDemand/knowledgeScope/skills/freshness`。
- `workspace.knowledgeRoot/skillsDir/skillRoots` 配置共享知识、复制目的地及技能来源目录。来源查找限直系技能及一个分类层，按数组顺序优先。
- 项目技能来自该项目 `project.json` 的 `skills.installed/shared`；知识路径来自 `paths.knowledge`，相对项目目录解析。
- 项目本地技能优先于共享来源。缺失声明仍返回候选路径和告警，不把它当已安装。项目路由显式 `skills` 覆盖默认项目候选。
- `context` 只返回所选候选及可选名称，不查询 Git、不输出完整技能和知识目录。`--target` 只用于 context，在保留任务入口的同时选择实际代码仓。

技能复制包含正文、脚本和引用文件，保留来源。同内容重复操作返回 `unchanged`，
目标不同或为软链则报冲突；不自动覆盖。技能内部仅允许仍指向技能内部的相对软链。
失败保留来源和已复制的部分文件，明确报告路径。复制文件不保证运行中 Agent 立即重新加载。

`list/inspect` 合并为 `context`，不提供 `skills move` 或 `ev knowledge`。
搜索与索引直接用 QMD；读取直接用文件工具；仓库操作直接用 Git；验证使用项目测试。
原先的技能来源、笔记、凭据和平台配置不会因命令精简而被修改。

### Browser

```bash
ev browser check

# 单次操作：自动创建专属 window + group，执行后释放
ev browser oneShot --payload '{"url":"https://example.com","command":{"action":"page.context"}}' --compact

# 多步操作：所有 page/workspace action 都放进 session.command
ev browser session.create --payload '{"url":"https://example.com"}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.snapshot","mode":"interactive"}}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.click","selector":"@e1"}}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"tabs.list"}}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.screenshot","fullPage":true}}' --output /tmp/page.png
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.subtitles","operation":"read","language":"zh-Hans","includeAutomatic":true,"format":"vtt","maxChars":100000}}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.subtitles","operation":"download","language":"zh-Hans","includeAutomatic":true,"format":"srt"}}' --compact
ev browser session.release --payload '{"sessionId":"UUID"}' --compact

# Chrome profile 全局 action 仅在用户明确要求时直接调用
ev browser history.search --payload '{"text":"EV","maxResults":20}' --compact
ev browser downloads.status --payload '{"downloadId":"local:UUID"}' --compact
ev browser bookmarks.list --compact
ev browser bookmarks.export --output ~/Documents/ev-bookmarks-backup.json --compact
```

Standalone Host 正常情况下无需管理；如需停止：

```bash
ev browser host stop
```

参数：

- `--payload <json>`：action 参数。
- `--payload-file <path>`：从 JSON 文件读取 action 参数。
- `--timeout <seconds>`：命令超时，最大 300 秒。
- `--compact`：输出单行 JSON。
- `--output <path>`：保存 `page.screenshot` 图片或 `bookmarks.export` JSON。

## P0/P1 浏览器控制

P0 页面 action 包含导航历史、点击/双击/右键、输入、checkbox/radio、原生 select、拖拽、focus、元素状态读取、键盘、坐标 pointer、滚动、iframe、JavaScript dialog，以及 navigation/network-idle/popup/download 等待。普通 navigate/context/snapshot/左键 click/type/check/select/focus/inspect/scroll/target wait/viewport screenshot 使用固定 content script 或 tabs API，不调用 `chrome.debugger.attach`；仅高级底层输入、iframe、Network/Console、emulation、上传、媒体和 full-page screenshot 调用 CDP attach。`page.click.waitFor` 会在点击前注册事件监听，避免错过新页面、popup 或下载事件。

`page.subtitles` 从当前 BrowserSession 的 owned tab 读取页面 URL，再由 Host 中受限的 `yt-dlp` helper 提取字幕。`operation: "read"` 返回去除时间码和重复 cue 的纯文本，最多 200,000 字符；`operation: "download"` 显式保存 VTT/SRT 到 `~/Downloads/EV`。可指定单个语言代码、是否包含自动字幕和格式。B 站登录后才返回的 AI 字幕需要显式传 `cookiesFromBrowser: "chrome"`（也支持 edge/firefox/safari）；Host 只导出临时 Cookie 文件，按 URL 的 `p` 参数选择多 P 视频的 `cid`，B 站 API 不可用时回退到普通 yt-dlp 提取。页面没有字幕时，可在用户明确同意后传 `fallback: "local-asr"` 与 `confirm: "RUN_LOCAL_ASR"`：Host 临时提取 WAV，调用 `PATH` 中的 `whisper-cli` 和 ggml 模型（默认 `~/.ev/models/whisper/ggml-small.bin`，可用 `EV_WHISPER_MODEL` 覆盖），返回 `source: "local-asr"`、纯文本及时间段，随后删除临时音频。页面 URL 通过 stdin 传入 helper；yt-dlp 请求经过 loopback 安全代理，B 站 API 请求固定使用已校验的公网解析地址，两条路径都拒绝 local/private/link-local/reserved 地址。YouTube 本地 ASR 使用匿名 `web_embedded` client，不读取 Cookie、不需要 PO Token 或常驻服务，因此仅支持作者允许嵌入播放的视频；其他站点沿用受限的公开媒体提取。首版覆盖 yt-dlp 支持的公开、非 DRM 页面，不绕过登录或地区限制。

P1 浏览器工作区能力包含 window、tab、tab group、download、history、recent sessions 和 zoom。对外规则是：

- page/window/tab/tab group/zoom/BrowserRun 必须放进 `browser.session.command`，或使用带 URL 的 `browser.oneShot`。
- 每个 Session 自动新建不抢焦点的 window，并把所有 EV-owned tabs 保持在同一个 group。
- 不存在 adopt/borrowed tab；Host 拒绝任何用户 tab/window/group ID。
- 创建第二个 group、ungroup、pin session tab、关闭最后一个 tab 和 `sessions.restore` 均被拒绝。
- bookmarks、downloads、history、`sessions.recent` 是 profile 全局 action，只在用户明确调用时执行。

删除下载或历史必须传入固定确认串：

```bash
ev browser downloads.remove --payload '{"downloadId":"chrome:42","mode":"both","confirm":"REMOVE_DOWNLOAD"}' --compact
ev browser history.remove --payload '{"target":{"type":"url","url":"https://example.com"},"confirm":"REMOVE_BROWSER_HISTORY"}' --compact
```

EV Browser 安装时启用页面、站点和下载能力，Options 只显示“已开启”，不提供权限勾选开关。同一 tab 的并发 CDP attach 合并为一次。EV 不暴露 Cookie、密码、Token、Passkey、调用方 JavaScript、任意 CDP 或任意 Chrome API。

## SiteRecipe 站点经验

SiteRecipe 是经过审批、限定精确域名和路径的 typed data，不是脚本。内置 `x.mute-words` 与 `x.read-grok-conversation` 已审批，可通过 live BrowserSession 运行：

```bash
ev browser recipe.list --compact
ev browser recipe.get --payload '{"recipeId":"x.mute-words"}' --compact

ev browser recipe.run --payload '{"recipeId":"x.mute-words","sessionId":"UUID","input":{"kind":"x.mute-words","words":["福不黑","寻固炮"]}}' --compact

ev browser recipe.run --payload '{"recipeId":"x.read-grok-conversation","sessionId":"UUID","input":{"kind":"x.read-grok-conversation","maxChars":50000}}' --compact
```

`x.mute-words` 先本地读取 snapshot，精确跳过已存在字词，再通过一个 BrowserRun 处理剩余项；结束后重新 snapshot，只有实际出现的字词才计入 `added`，最终只返回 `added/skipped/failed` 和简短统计。`x.read-grok-conversation` 只读取固定 `main` scope，最多返回 100,000 字符。

自定义配置必须先保存为 draft。保存结果会返回规范化定义和 `reviewToken`；draft 永远不能运行：

```bash
ev browser recipe.draft.save --payload-file ./recipe.json --compact
```

检查完整返回内容并获得用户明确同意后，才能审批同一个 token：

```bash
ev browser recipe.approve --payload '{"recipeId":"x.mute-words-english","reviewToken":"64位SHA-256","confirm":"APPROVE_SITE_RECIPE"}' --compact
```

修改 draft 会生成新 token，并使旧审批请求失效。内置 recipe 不可覆盖。用户定义保存在 `$EV_HOME/browser-host/site-recipes.json`，目录 `0700`、文件 `0600`；不保存页面正文、Cookie、Token 或 trace。

## BrowserSession 所有权

多步 Agent 自动化必须创建 BrowserSession。Host 会新建一个不抢焦点的专属 window 和一个 EV tab group，所有 session tabs 都保持在该 group：

```bash
# 创建 session；记下返回的 sessionId、windowId、groupId
ev browser session.create --payload '{"url":"https://example.com"}' --compact

# 在专属 window 新建 owned tab
ev browser session.open --payload '{"sessionId":"UUID","url":"https://example.com/docs","active":true}' --compact

# 缺省操作 activeTabId；也可显式传 session 内的 tabId
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.snapshot","mode":"interactive"}}' --compact

# 结束时释放：只关闭 EV-owned tabs
ev browser session.release --payload '{"sessionId":"UUID"}' --compact
```

EV 不采用用户已有 tab。`session.list` / `session.get` 可检查当前 Host 内存中的 ownership。Host 重启后所有 session 失效，不从 Chrome 猜测恢复。每个 Host 最多 32 个 session，每个 session 最多 32 个 owned tabs。若用户手动把其它 tab 移入 EV window，release 会保留这些未知 tab。

## BrowserRun 批处理

把 `browser.run` 作为 `session.command.command` 运行，可将顺序步骤、语义定位、循环和重试留在 Browser Host 本地，只输出最终汇总，不把中间 snapshot 塞进 Agent 上下文。它支持 `command`、`wait`、非嵌套 `forEach`，以及 P0 的导航、表单、拖拽、focus、inspect、pointer、滚动、条件等待和 dialog actions。语义目标每次执行或重试前都会重新定位，因此不会复用过期的 `@eN`；拖拽的起点和终点在同一份新 snapshot 中解析。

```json
{
  "sessionId": "UUID",
  "command": {
    "action": "browser.run",
    "steps": [
      {
        "kind": "forEach",
        "id": "fill-items",
        "items": ["first", "second"],
        "onError": "continue",
        "steps": [
          {
            "kind": "command",
            "command": {
              "action": "page.type",
              "target": { "role": "textbox", "name": "输入内容" },
              "text": { "from": "item" }
            },
            "retry": { "attempts": 5, "delayMs": 400 }
          }
        ]
      }
    ]
  }
}
```

```bash
ev browser session.command --payload-file ./browser-session-run.json --timeout 120 --compact
```

Host 会给 plan 注入 session tab，并检查每个原子 command 都没有越过 ownership；顶层 `ev browser run` 会被拒绝。

限制：最多 50 个顶层步骤、100 个循环项、2,000 次原子 command；不支持嵌套循环、任意表达式、shell、DOM JavaScript 或 `page.eval`。

## 书签整理与恢复

`bookmarks.create`、`bookmarks.update`、`bookmarks.move`、`bookmarks.remove`、`bookmarks.removeTree` 和 `bookmarks.restore` 执行前，CLI 会先自动导出完整书签树到 `~/.ev/backups/bookmarks/`，成功结果会返回 `backupPath`。可额外做一份指定位置的手动备份：

```bash
ev browser bookmarks.export --output ~/Documents/ev-bookmarks-before-cleanup.json --compact
```

常见整理操作：

```bash
ev browser bookmarks.create --payload '{"parentId":"1","title":"EV","url":"https://example.com"}' --compact
ev browser bookmarks.update --payload '{"id":"42","title":"EV docs"}' --compact
ev browser bookmarks.move --payload '{"id":"42","parentId":"2","index":0}' --compact
ev browser bookmarks.remove --payload '{"id":"42"}' --compact
```

`bookmarks.removeTree` 会递归删除整个文件夹，必须显式传入确认串：

```bash
ev browser bookmarks.removeTree --payload '{"id":"43","confirm":"REMOVE_BOOKMARK_TREE"}' --compact
```

恢复是非破坏式的：导出的 JSON 可直接作为 payload file，EV 会把整棵备份树重建到一个新的 `EV restore …` 文件夹，不清空或覆盖当前书签。也可在备份 JSON 中添加 `parentId` 和 `title` 指定恢复位置与文件夹名。

```bash
ev browser bookmarks.restore --payload-file ~/Documents/ev-bookmarks-before-cleanup.json --compact
```

所有 action 都由 `@ev/contracts` 校验。`page.eval` 不可用；`page.upload` 只接受存在的绝对文件路径。扩展安装后下载能力默认开启。直链资源使用 Chrome Downloads；非 DRM HLS/DASH 由 Browser Host 使用本地 `yt-dlp` 与 FFmpeg 处理；默认统一保存到 `~/Downloads/EV`。Native helper 的初始 URL、重定向和 playlist 子请求统一经过安全代理，拒绝访问 loopback、private、link-local 和 reserved 网络。

## 开发与打包

```bash
pnpm --dir apps/cli run typecheck
pnpm --dir apps/cli run test
pnpm --dir apps/cli run build
pnpm --dir apps/cli run build:standalone
pnpm run package:cli
```

`package:cli` 同时生成 npm tarball 和当前平台的单文件可执行程序。
