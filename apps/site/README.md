# @ev/site

EV 官网：下载入口、功能介绍与技术文档。

技术栈：Next.js 15（App Router）+ Tailwind CSS v4 + [Fumadocs](https://fumadocs.dev)
（fumadocs-core/ui 15.8.5 + fumadocs-mdx 12.0.3）。深色主题，颜色变量对照
`packages/design-tokens/theme.css`（只读参考，构建不依赖仓内其他包）。

## 命令

```bash
pnpm install          # 在 apps/site 目录内执行（独立 lockfile，不进根工作区）
pnpm run dev          # 开发服务器
pnpm run build        # 生产构建
pnpm run typecheck    # next typegen + tsc --noEmit
pnpm run lint         # eslint
```

根目录也可以用 `pnpm run dev:site` / `pnpm run build:site`。

## 结构

- `app/(home)/`：首页（下载按钮目前为占位链接，见页面内 TODO）与 Features 页
- `content/docs/`：MDX 文档——快速开始、EV CLI 参考、浏览器扩展安装
- `app/docs/`：Fumadocs 文档渲染路由；`app/api/search`：全文搜索
- `source.config.ts`：fumadocs-mdx 收集配置，产物在 `.source/`（不提交）

## 注意

- 本目录使用独立 `pnpm-lock.yaml`；安装时务必在本目录内执行，避免改动根仓 lockfile。
- 下载按钮的真实分发链接、站点域名（`NEXT_PUBLIC_SITE_URL`）上线前需补齐。
