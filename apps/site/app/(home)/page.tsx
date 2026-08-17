import Link from 'next/link';

interface DownloadItem {
  name: string;
  detail: string;
  action: string;
  href: string;
}

const RELEASE_URL = 'https://github.com/sogud/ev/releases/tag/agent-kit-v0.1.0';
const ASSET_URL = 'https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0';
const INSTALL_GUIDE_URL = 'https://raw.githubusercontent.com/sogud/ev/master/docs/install-for-agent.md';

const downloads: DownloadItem[] = [
  {
    name: 'Desktop',
    detail: 'macOS 桌面 App · 打包中，先到 Releases 页查看进度',
    action: '查看 Releases',
    href: 'https://github.com/sogud/ev/releases',
  },
  {
    name: 'Browser Extension',
    detail: 'Chrome Manifest V3 扩展 · 开发者模式加载',
    action: '下载扩展',
    href: `${ASSET_URL}/evbrowser-extension-0.1.0-chrome.zip`,
  },
  {
    name: 'CLI',
    detail: 'ev 命令行 · 单文件可执行，无需 Node.js（Apple Silicon）',
    action: '安装指南',
    href: INSTALL_GUIDE_URL,
  },
];

const features = [
  {
    title: '一个收件箱，管所有 Runtime',
    body: 'Pi / Codex / Claude Code / Qoder 按任务切换。认证保持各 Runtime 原生，EV 从不存储凭据。',
  },
  {
    title: '本地优先架构',
    body: '无头本地服务只监听 127.0.0.1；桌面 App、CLI 与手机 Web 都是同一契约的薄客户端。',
  },
  {
    title: '手机访问，不经过云',
    body: '可选绑定 LAN / Tailscale 地址，observer / operator 两级 token，Agent 跟着你走到沙发。',
  },
  {
    title: '诚实的可观测性',
    body: '实时对话流、每轮 Trace、工作区 diff Inspector——不是 opaque 的「agent did things」。',
  },
  {
    title: '浏览器桥接',
    body: '配对扩展后，每个页面操作都跑在 Agent 自己的 BrowserSession 窗口里，绝不碰你现有的标签页。',
  },
  {
    title: 'CLI 随行',
    body: 'ev 命令行随应用打包，管理任务、Runtime、token 与浏览器会话，桌面不开也能自托管服务。',
  },
];

export default function HomePage() {
  return (
    <div className='flex flex-1 flex-col'>
      {/* Hero */}
      <section className='mx-auto flex w-full max-w-5xl flex-col items-center px-6 pb-20 pt-24 text-center sm:pt-32'>
        <p className='mb-4 rounded-full border border-line px-3 py-1 text-xs text-ink-secondary'>
          Enhanced Vigilance · Apache-2.0
        </p>
        <h1 className='max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl'>
          本地优先的<span className='text-brand'>个人 Agent 工作台</span>
        </h1>
        <p className='mt-6 max-w-2xl text-balance text-base leading-relaxed text-ink-secondary'>
          把你已有的编码 Runtime——Pi、Codex、Claude Code、Qoder——放进一个冷静、透明的界面。 桌面
          App、浏览器扩展与 CLI 共享同一个本地服务，数据始终留在你的机器上。
        </p>
        <div className='mt-10 flex flex-wrap items-center justify-center gap-3'>
          <Link
            href={RELEASE_URL}
            className='rounded-lg bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-85'>
            下载 EV
          </Link>
          <Link
            href='/docs'
            className='rounded-lg border border-line bg-surface px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-raised'>
            阅读文档
          </Link>
        </div>
      </section>

      {/* Downloads */}
      <section className='mx-auto w-full max-w-5xl px-6 pb-20'>
        <div className='grid gap-4 sm:grid-cols-3'>
          {downloads.map(item => (
            <div
              key={item.name}
              className='flex flex-col rounded-xl border border-line bg-surface p-5'>
              <h2 className='text-sm font-semibold'>{item.name}</h2>
              <p className='mt-1 flex-1 text-sm text-ink-tertiary'>{item.detail}</p>
              <Link
                href={item.href}
                className='mt-4 inline-flex w-fit rounded-md border border-line px-3.5 py-1.5 text-sm text-ink transition-colors hover:bg-raised'>
                {item.action}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className='mx-auto w-full max-w-5xl px-6 pb-24'>
        <h2 className='mb-8 text-center text-2xl font-semibold'>为什么是 EV</h2>
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
          {features.map(feature => (
            <div
              key={feature.title}
              className='rounded-xl border border-line-subtle bg-surface/60 p-5'>
              <h3 className='text-sm font-semibold'>{feature.title}</h3>
              <p className='mt-2 text-sm leading-relaxed text-ink-secondary'>{feature.body}</p>
            </div>
          ))}
        </div>
        <div className='mt-10 text-center'>
          <Link href='/features' className='text-sm text-brand hover:underline'>
            了解完整功能 →
          </Link>
        </div>
      </section>

      <footer className='border-t border-line-subtle py-8 text-center text-xs text-ink-tertiary'>
        EV — Enhanced Vigilance · 本地优先，数据留在你的机器上
      </footer>
    </div>
  );
}
