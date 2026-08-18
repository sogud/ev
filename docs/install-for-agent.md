# EV Agent Kit 安装说明（给 AI agent 读）

你正在帮助用户安装 EV Browser Kit：让 AI 通过 Chrome 浏览器扩展安全地操作网页。
用户通常不懂技术。**除第 3 步的浏览器点击外，其余全部由你执行**。
每一步执行完立即验证，失败时停下来说明原因，不要猜测继续。

## 产物与版本

- 版本：0.1.0
- Release 页：https://github.com/sogud/ev/releases/tag/agent-kit-v0.1.0
- 资产（下载后必须与 SHA256SUMS.txt 核对）：
  - `ev-0.1.0-darwin-arm64` — EV CLI 单文件可执行程序（内置运行时，**无需安装 Node.js**）
  - `evbrowser-extension-0.1.0-chrome.zip` — Chrome 扩展
  - `ev-browser-skill-0.1.0.zip` — ev-browser 技能（教你正确使用 CLI）
  - `SHA256SUMS.txt`

资产直链格式：
`https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/<文件名>`

**平台限制（先检查，不满足就停下告知用户）**：
当前版本 CLI 只支持 **Apple Silicon Mac（M 系列芯片）**。
用 `uname -sm` 检查，必须输出 `Darwin arm64`。其他系统（Intel Mac、
Windows、Linux）暂时没有对应版本，如实告诉用户，不要尝试强行安装。

## 第 1 步：环境检查

1. `uname -sm` 确认是 `Darwin arm64`（见上方平台限制）。
2. 确认 Chrome（或 Edge）已安装；没有就提示用户先装浏览器再继续。
3. **不需要 Node.js、npm 或任何编程语言环境**，不要安装它们。

## 第 2 步：安装 EV CLI

```bash
mkdir -p ~/.ev/bin && cd ~/.ev
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/ev-0.1.0-darwin-arm64
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
mv ev-0.1.0-darwin-arm64 ~/.ev/bin/ev
chmod +x ~/.ev/bin/ev
~/.ev/bin/ev --version    # 必须输出版本号才算成功
```

如果用户以后想直接输 `ev` 使用，把 `export PATH="$HOME/.ev/bin:$PATH"`
追加到 `~/.zshrc`（追加前检查是否已存在，不要重复加）；当前会话内你直接用
`~/.ev/bin/ev` 绝对路径即可。

macOS 首次运行可能提示安全确认，让用户允许一次即可（程序未公证时：
`xattr -d com.apple.quarantine ~/.ev/bin/ev`）。

## 第 3 步：安装浏览器扩展（唯一需要用户动手的步骤）

扩展装在用户自己的 Chrome/Edge 里，以"开发者模式 + 加载已解压扩展"的方式
从本地目录加载。下载、解压、打开设置页都由你做，用户只负责最后三次点击。

你先准备好一切：

```bash
cd ~/.ev
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/evbrowser-extension-0.1.0-chrome.zip
mkdir -p ~/.ev/extension && unzip -o evbrowser-extension-0.1.0-chrome.zip -d ~/.ev/extension
ls ~/.ev/extension/manifest.json   # 必须存在，否则解压有问题
```

帮用户打开扩展管理页（`open -a "Google Chrome" chrome://extensions`），
然后清楚地告诉用户（一次只给一步，等他确认再做下一步）：

1. 现在应该看到"扩展程序"页面；找到右上角的 **"开发者模式"** 开关，打开它。
2. 页面左上角会出现三个按钮，点 **"加载已解压的扩展程序"**
   （Edge 里叫"加载解压缩的扩展"）。
3. 在弹出的文件选择框里选择这个文件夹：`~/.ev/extension`
   （把完整路径告诉用户，macOS 可在选择框按 Cmd+Shift+G 粘贴路径）。
4. 确认后，扩展列表里出现 **"EV Browser"** 即成功。

提醒用户：
- `~/.ev/extension` 这个文件夹就是扩展本体，**不能删除、不能移动**。
- Chrome 重启后如果提示"开发者模式扩展已停用"之类，点"保留/启用"即可。

## 第 4 步：安装 ev-browser 技能

```bash
cd ~/.ev
curl -LO https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0/ev-browser-skill-0.1.0.zip
mkdir -p ~/.ev/skills && unzip -o ev-browser-skill-0.1.0.zip -d ~/.ev/skills
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

## 第 5 步：验证

```bash
~/.ev/bin/ev browser check
```

把输出结果告诉用户。成功则安装完成；失败则按输出提示排查
（通常是扩展未装好或 Chrome 未运行）。

## 多浏览器（可选，高级）

每个浏览器可以配对到自己独立的 EV Host profile（独立端口、独立配对记录，互不干扰）：

1. 启动 profile Host：`~/.ev/bin/ev browser host serve --profile edge --background`
   （首次自动分配空闲端口，从 43122 起，自动避开被占用的端口）
2. 查看各 profile 的端口与配对状态：`~/.ev/bin/ev browser profile list`
3. 在目标浏览器的 EV Browser 选项页，把"Host 地址"设为
   `ws://127.0.0.1:<profile端口>/browser` 并保存，扩展会自动重连并配对
4. agent 执行命令时加 `--profile edge` 即控制该浏览器；不加则用默认 profile

默认 profile（default）无需任何配置，扩展默认连 43121 端口。

## 安全须知（转述给用户）

- EV 只操作它自己打开的窗口和标签页，不会动用户正在用的页面。
- 扩展不读取账号密码，不上传浏览数据。
- 卸载：在扩展页面移除 EV Browser，然后 `rm -rf ~/.ev` 即可，无其他残留。
