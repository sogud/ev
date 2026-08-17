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

## 第 1 步：环境检查

- Node.js ≥ 20（`node --version`）。没有就指导用户安装（官网下载或 brew）。
- Chrome 或 Edge 已安装。
- macOS/Linux/Windows 均可。

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
- pi：`ln -s ~/.ev/skills/ev-browser ~/.pi/agent/skills/ev-browser`
- Claude Code：`ln -s ~/.ev/skills/ev-browser ~/.claude/skills/ev-browser`
- 其他平台：把 `~/.ev/skills/ev-browser/SKILL.md` 的内容告知你自己，并在本次会话遵循它

**从现在起，所有浏览器操作遵循该 SKILL.md 的规则**（只用 `browser.session.*` /
`browser.oneShot`，不碰用户已有标签页）。

## 第 4 步：安装浏览器扩展（唯一需要用户动手的步骤）

你来下载和解压，用户只需在浏览器里点几下：

```bash
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/evbrowser-extension-0.1.0-chrome.zip
mkdir -p ~/.ev/extension && unzip -o evbrowser-extension-0.1.0-chrome.zip -d ~/.ev/extension
```

然后清楚地告诉用户（一次只给一步，等他确认）：
1. 打开 `chrome://extensions`（Edge 用户打开 `edge://extensions`）
2. 打开右上角"开发者模式"
3. 点"加载已解压的扩展程序"，选择 `~/.ev/extension` 目录
4. 看到 "EV Browser" 扩展出现即成功

提醒用户：这个目录不能删除或移动，否则扩展失效。

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
