import { RootProvider } from 'fumadocs-ui/provider';
import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  // TODO: 部署后替换为正式站点域名
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'EV — Enhanced Vigilance',
    template: '%s · EV',
  },
  description: '本地优先的个人 Agent 工作台：桌面 App、浏览器扩展与 CLI。',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang='zh-CN' suppressHydrationWarning>
      <body className='flex flex-col min-h-screen'>
        <RootProvider theme={{ attribute: 'class', defaultTheme: 'dark', forcedTheme: 'dark' }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
