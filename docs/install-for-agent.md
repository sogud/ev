# EV Agent Kit 安装说明（给 AI agent 读）

你正在帮助用户安装 EV Browser Kit：让 AI 通过 Chrome 浏览器扩展安全地操作网页。
用户通常不懂技术。**除第 4 步的浏览器点击外，其余全部由你执行**。
每一步执行完立即验证，失败时停下来说明原因，不要猜测继续。

## 产物与版本

- 版本：0.1.0
- Release 页：https://github.com/sogud/ev/releases/tag/agent-kit-v0.1.0
- 资产（下载后与 SHA256SUMS.txt 核对）：
  - `sogud-ev-0.1.0.tgz` — EV CLI（含浏览器 Host）
  - `evbrowser-extension-0.1.0-chrome.zip` — Chrome 扩展
  - `ev-browser-skill-0.1.0.zip` — ev-browser 技能（教你正确使用 CLI）
  - `SHA256SUMS.txt`

资产直链格式：
`https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/<文件名>`

## 第 1 步：环境检查与安装 Node.js

用户几乎肯定没有 Node.js，**由你负责装好，不要让用户自己折腾**：

1. `node --version`：已存在且 ≥ 20 就跳过。
2. 没有则按系统自动安装：
   - macOS：优先 `brew install node`；没有 brew 就下载官方 pkg
     （`curl -Lo /tmp/node.pkg https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg`，
     然后 `sudo installer -pkg /tmp/node.pkg -target /`，需要用户输入开机密码，
     提前告诉他）。
   - Windows：`winget install OpenJS.NodeJS.LTS`；装完重开终端再验证。
   - Linux：发行版包管理器装 nodejs + npm。
3. 装完重新 `node --version` 和 `npm --version` 验证，都成功才进下一步。
4. 确认 Chrome（或 Edge）已安装；没有就提示用户先装浏览器再继续。

macOS/Linux/Windows 均可。

## 第 2 步：安装 EV CLI

```bash
cd <工作目录>   # 例如 ~/ev-install
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/sogud-ev-0.1.0.tgz
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing   # Windows: Get-FileHash 对比
npm install -g ./sogud-ev-0.1.0.tgz
ev --version    # 必须输出版本号才算成功
```

## 第 3 步：安装 ev-browser 技能

```bash
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/ev-browser-skill-0.1.0.zip
mkdir -p ~/.ev && unzip -o ev-browser-skill-0.1.0.zip -d ~/.ev/skills
```

然后按当前 agent 平台链接技能：
- Codex（主要用户）：`ln -s ~/.ev/skills/ev-browser ~/.codex/skills/ev-browser`
  （若目标项目有 `.codex/skills/` 约定则链到项目内）
- pi：`ln -s ~/.ev/skills/ev-browser ~/.pi/agent/skills/ev-browser`
- Claude Code：`ln -s ~/.ev/skills/ev-browser ~/.claude/skills/ev-browser`
- 其他平台或不支持自动加载技能：先完整读取
  `~/.ev/skills/ev-browser/SKILL.md` 再开始工作

**从现在起，所有浏览器操作遵循该 SKILL.md 的规则**（只用 `browser.session.*` /
`browser.oneShot`，不碰用户已有标签页）。每次新会话开始做浏览器任务前，
若技能未自动加载，先重读一遍 SKILL.md。

## 第 4 步：安装浏览器扩展（唯一需要用户动手的步骤）

扩展装在用户自己的 Chrome/Edge 里，以"加载已解压扩展"方式从本地目录加载。
下载、解压、打开设置页都由你做，用户只负责最后三次点击。

你先准备好一切：

```bash
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/evbrowser-extension-0.1.0-chrome.zip
mkdir -p ~/.ev/extension && unzip -o evbrowser-extension-0.1.0-chrome.zip -d ~/.ev/extension
ls ~/.ev/extension/manifest.json   # 必须存在，否则解压有问题
```

能帮用户直接打开扩展管理页就打开（macOS 例：
`open -a "Google Chrome" chrome://extensions`），然后清楚地告诉用户
（一次只给一步，等他确认再做下一步）：

1. 现在应该看到"扩展程序"页面；找到右上角的**"开发者模式"**开关，打开它。
2. 页面左上角会出现三个按钮，点**"加载已解压的扩展程序"**
   （Edge 里叫"加载解压缩的扩展"）。
3. 在弹出的文件选择框里，进入并选择这个文件夹：`~/.ev/extension`
   （把完整路径告诉用户，macOS 可用 Cmd+Shift+G 粘贴路径；
   Windows 对应 `C:\Users\<用户名>\.ev\extension`）。
4. 确认后，扩展列表里出现 **"EV Browser"** 即成功。

提醒用户：`~/.ev/extension` 这个文件夹就是扩展本体，**不能删除、不能移动**，
否则扩展失效；浏览器重启后如果提示重新加载，点一下即可。

## 第 5 步：验证

```bash
ev browser check
```

把输出结果告诉用户。成功则安装完成；失败则按输出提示排查
（通常是扩展未装好或 Chrome 未运行）。

## 安全须知（转述给用户）

- EV 只操作它自己打开的窗口和标签页，不会动用户正在用的页面。
- 扩展不读取账号密码，不上传浏览数据。
- 如需卸载：删除扩展、`npm uninstall -g @sogud/ev`、删除 `~/.ev`。
