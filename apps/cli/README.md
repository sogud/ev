# EV CLI

`ev` 提供受限的 `ev browser` 浏览器控制能力。它既可随 EV Desktop 使用，也可完全独立运行：

```text
ev CLI → Desktop 或 standalone Browser Host → EV Browser → Chrome CDP
```

CLI 优先复用正在运行的 EV Desktop Browser Host；如果 Desktop 不存在，会自动启动用户级 standalone Browser Host。CLI 不读取或显示 Bridge pairing token，也不直接 attach Chrome。Standalone Host 只会自动接受内置 allowlist 中的 EV Browser extension origin；自定义开发构建可通过 `EV_BROWSER_EXTENSION_ORIGINS` 显式追加 origin。Desktop 仍保留首次显式批准。

## 安装

全局 npm 包：

```bash
npm install --global @sogud/ev
# 或
npm install --global @sogud/ev
```

也可从 GitHub Release 下载当前平台的单文件程序，例如 `ev-darwin-arm64`，赋予执行权限后放入 `PATH`。EV Desktop 还会自动创建 `~/.ev/bin/ev` launcher，并将其加入内置 Pi Runtime 的 `PATH`。

## 使用

```bash
ev browser check
ev browser tabs.list --compact
ev browser page.snapshot --payload '{"tabId":123,"mode":"interactive"}' --compact
ev browser page.click --payload '{"tabId":123,"selector":"@e1"}' --compact
ev browser page.media --payload '{"tabId":123}' --compact
ev browser page.download --payload '{"tabId":123,"ref":"@m1"}' --compact
ev browser downloads.status --payload '{"downloadId":"local:UUID"}' --compact
ev browser page.screenshot --payload '{"tabId":123,"fullPage":true}' --output /tmp/page.png
ev browser run --payload-file ./browser-plan.json --timeout 120 --compact

ev browser session.create --payload '{"url":"https://example.com"}' --compact
ev browser session.list --compact
ev browser recipe.list --compact

ev browser bookmarks.list --compact
ev browser bookmarks.search --payload '{"query":"EV"}' --compact
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

多步 Agent 自动化优先创建 BrowserSession。Host 会在用户现有 Chrome 中创建一个不抢焦点的专属 window，只有 session 创建的 tab 才是 owned tab：

```bash
# 创建 session；记下返回的 sessionId
ev browser session.create --payload '{"url":"https://example.com"}' --compact

# 在专属 window 新建 owned tab
ev browser session.open --payload '{"sessionId":"UUID","url":"https://example.com/docs","active":true}' --compact

# 缺省操作 activeTabId；也可显式传 session 内的 tabId
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.snapshot","mode":"interactive"}}' --compact

# 结束时释放：只关闭 owned tabs
ev browser session.release --payload '{"sessionId":"UUID"}' --compact
```

只有任务明确需要用户现有 tab 时才显式 adopt。adopt 不移动、不聚焦、不关闭用户 tab；一个 tab 不能同时属于两个 BrowserSession：

```bash
ev browser session.adoptTab --payload '{"sessionId":"UUID","tabId":123}' --compact
```

`session.list` / `session.get` 可检查当前 Host 内存中的 ownership。Host 重启后所有 session 失效，不从 Chrome 猜测恢复。每个 Host 最多 32 个 session，每个 session 最多 32 个 owned/borrowed tabs。

## BrowserRun 批处理

`ev browser run` 把顺序步骤、语义定位、循环和重试留在 Browser Host 本地，只输出最终汇总，不把中间 snapshot 塞进 Agent 上下文。P0 支持 `command`、`wait`、非嵌套 `forEach`，以及 `page.navigate/click/type/press`。语义目标每次执行或重试前都会重新定位，因此不会复用过期的 `@eN`。

```json
{
  "tabId": 123,
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
```

```bash
ev browser run --payload-file ./browser-plan.json --timeout 120 --compact
```

BrowserRun 也可作为 `session.command.command` 运行；Host 会给 plan 注入 session tab，并检查每个原子 command 都没有越过 ownership。

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

所有 action 都由 `@ev/contracts` 校验。`page.eval` 不可用；`page.upload` 只接受存在的绝对文件路径。下载需要先在 EV Browser Options 显式授权。直链资源使用 Chrome Downloads；非 DRM HLS/DASH 由 Browser Host 使用本地 `yt-dlp` 与 FFmpeg 处理；默认统一保存到 `~/Downloads/EV`。Native helper 的初始 URL、重定向和 playlist 子请求统一经过安全代理，拒绝访问 loopback、private、link-local 和 reserved 网络。

## 开发与打包

```bash
pnpm --dir apps/cli run typecheck
pnpm --dir apps/cli run test
pnpm --dir apps/cli run build
pnpm --dir apps/cli run build:standalone
pnpm run package:cli
```

`package:cli` 同时生成 npm tarball 和当前平台的单文件可执行程序。
