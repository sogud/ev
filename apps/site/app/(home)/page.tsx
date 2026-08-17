import Link from 'next/link';

interface DownloadItem {
  name: string;
  detail: string;
  action: string;
  href: string;
}

const RELEASE_URL = 'https://github.com/sogud/ev/releases/tag/agent-kit-v0.1.0';
const ASSET_URL = 'https://github.com/sogud/ev/releases/download/agent-kit-v0.1.0';
const INSTALL_GUIDE_URL =
  'https://raw.githubusercontent.com/sogud/ev/master/docs/install-for-agent.md';

const downloads: DownloadItem[] = [
  {
    name: 'Agent Kit (recommended)',
    detail: 'CLI + browser extension + agent skill. Hand your AI the install guide and it sets itself up.',
    action: 'Install guide',
    href: INSTALL_GUIDE_URL,
  },
  {
    name: 'Browser Extension',
    detail: 'Chrome Manifest V3 extension. Load it via Developer Mode, or let your agent do it.',
    action: 'Download extension',
    href: `${ASSET_URL}/evbrowser-extension-0.1.0-chrome.zip`,
  },
  {
    name: 'Desktop',
    detail: 'macOS desktop app — packaging in progress. Track it on the Releases page.',
    action: 'View releases',
    href: 'https://github.com/sogud/ev/releases',
  },
];

const features = [
  {
    title: 'One inbox for every runtime',
    body: 'Switch between Pi, Codex, Claude Code and Qoder per task. Auth stays native to each runtime — EV never stores credentials.',
  },
  {
    title: 'Local-first architecture',
    body: 'A headless local service listening only on 127.0.0.1. Desktop, CLI, web and mobile are thin clients of one contract.',
  },
  {
    title: 'Phone access, no cloud',
    body: 'Optionally bind to your LAN or Tailscale address with observer / operator token tiers. Your agent follows you to the couch.',
  },
  {
    title: 'Honest observability',
    body: 'Live transcripts, per-turn traces and a workspace diff inspector — not an opaque “agent did things”.',
  },
  {
    title: 'Browser bridge',
    body: 'Once paired with the extension, every page action runs in the agent’s own BrowserSession window. Your existing tabs are never touched.',
  },
  {
    title: 'WebMCP ready',
    body: 'Pages can register native tools for your agent via navigator.modelContext — structured actions instead of brittle DOM clicking.',
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
          The local-first <span className='text-brand'>agent workspace</span> for your existing
          coding runtimes
        </h1>
        <p className='mt-6 max-w-2xl text-balance text-base leading-relaxed text-ink-secondary'>
          Put the coding runtimes you already use — Pi, Codex, Claude Code, Qoder — behind one
          calm, transparent interface. Desktop app, browser extension and CLI share a single local
          service; your data never leaves your machine.
        </p>
        <div className='mt-10 flex flex-wrap items-center justify-center gap-3'>
          <Link
            href={INSTALL_GUIDE_URL}
            className='rounded-lg bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-85'>
            Get the Agent Kit
          </Link>
          <Link
            href='/docs'
            className='rounded-lg border border-line bg-surface px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-raised'>
            Read the docs
          </Link>
        </div>
        <p className='mt-4 text-xs text-ink-tertiary'>
          中文用户：把安装指南链接发给你正在用的 AI，它会替你装好一切。
        </p>
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
        <h2 className='mb-8 text-center text-2xl font-semibold'>Why EV</h2>
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
            See all features →
          </Link>
        </div>
      </section>

      <footer className='border-t border-line-subtle py-8 text-center text-xs text-ink-tertiary'>
        EV — Enhanced Vigilance · Local-first. Your data stays on your machine.
      </footer>
    </div>
  );
}
