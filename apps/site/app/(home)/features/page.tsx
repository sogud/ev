import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '功能',
  description:
    'EV 的核心功能：多 Runtime 收件箱、本地优先架构、Trace 与 Inspector、浏览器桥接、手机访问与 CLI。',
};

const sections = [
  {
    title: '一个收件箱，管所有 Runtime',
    items: [
      'Pi / Codex / Claude Code / Qoder 四种常规 Runtime，按任务切换；首条消息前可换，之后锁定，保持会话诚实。',
      '每个任务独立选择 Runtime、模型与思考强度；多任务并行，互不干扰。',
      '认证保持各 Runtime 原生：EV 展示认证状态、配置路径与模型目录，但从不写入原生配置，也不存储凭据。',
    ],
  },
  {
    title: '本地优先架构',
    items: [
      '无头本地服务只监听 127.0.0.1；Electron 桌面端、CLI 与手机 Web 都是同一契约的薄客户端。',
      '首次启动自动创建 ~/.ev/workspace，无需 Onboarding；也支持为单个任务指定独立工作目录。',
      '桌面关闭时，CLI 可以自托管服务，任务不中断。',
    ],
  },
  {
    title: '诚实的可观测性',
    items: [
      '流式对话记录：工具调用、变更文件卡片与每轮脚注一目了然。',
      '工作区 diff Inspector：diff-first 设计，agent 改了什么直接看差异。',
      'Runtime 健康抽屉：原生认证状态（只读）、配置路径、模型目录。',
    ],
  },
  {
    title: '浏览器桥接',
    items: [
      '配对浏览器扩展后，每个 BrowserSession 自动创建专属窗口与单一 EV tab group，拒绝操作你已有的标签页。',
      'DOM / Accessibility snapshot、点击、输入、滚动、等待、截图、上传；普通 DOM 操作不触发远程调试，高级诊断按需 attach 受限 CDP。',
      '直链图片/视频与非 DRM HLS/DASH 流媒体发现与下载，统一保存到 Downloads/EV。',
      '只连接内置的 ws://127.0.0.1:43121/browser；配对成功前拒绝执行任何 Browser Host 命令。',
    ],
  },
  {
    title: '手机访问，不经过云',
    items: [
      'ev remote on 可选绑定 LAN 或 Tailscale 地址；不信任的 WiFi 走 Tailscale。',
      'observer（只读）/ operator（可发送）两级 token，创建时打印一次，列表只显示掩码。',
      '手机 Web 入口 /m：任务列表、对话、模型切换——只保留必要的。',
    ],
  },
  {
    title: 'CLI 与 Skill',
    items: [
      'ev 命令行随应用打包（~/.ev/bin/ev），管理任务、Runtime、token、设置与浏览器会话。',
      '默认加载 ev-browser Skill，把浏览器操作流程交给 Agent 复用。',
      '所有命令输出结构化 JSON，方便接入脚本与自动化。',
    ],
  },
];

export default function FeaturesPage() {
  return (
    <div className='mx-auto w-full max-w-4xl flex-1 px-6 pb-24 pt-16'>
      <h1 className='text-3xl font-bold tracking-tight'>功能</h1>
      <p className='mt-4 max-w-2xl leading-relaxed text-ink-secondary'>
        EV 的目标不是自研模型适配层，也不是搭建云端 Agent 平台，而是先把可靠、透明、可检查的
        个人桌面 Agent 做好。
      </p>

      <div className='mt-12 space-y-10'>
        {sections.map(section => (
          <section key={section.title} className='rounded-xl border border-line bg-surface p-6'>
            <h2 className='text-lg font-semibold'>{section.title}</h2>
            <ul className='mt-4 space-y-2.5'>
              {section.items.map(item => (
                <li key={item} className='flex gap-2.5 text-sm leading-relaxed text-ink-secondary'>
                  <span aria-hidden className='mt-[7px] size-1.5 shrink-0 rounded-full bg-brand' />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className='mt-12 flex flex-wrap gap-3'>
        <Link
          href='/docs'
          className='rounded-lg bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-85'>
          开始使用
        </Link>
        <Link
          href='/docs/cli'
          className='rounded-lg border border-line bg-surface px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-raised'>
          EV CLI 参考
        </Link>
      </div>
    </div>
  );
}
