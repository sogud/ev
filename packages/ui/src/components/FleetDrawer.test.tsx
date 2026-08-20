import type { FleetPane } from '@ev/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { FleetDrawer, type FleetPaneLoad } from './FleetDrawer';

const pane: FleetPane = {
  paneId: 'w1:p1',
  title: 'ticket 03',
  cwd: '/tmp/ev',
  agent: { name: 'pi', kind: 'pi', status: 'working' },
};

const render = (load: FleetPaneLoad, paneOverride: Partial<FleetPane> = {}): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <FleetDrawer pane={{ ...pane, ...paneOverride }} load={load} onClose={vi.fn()} />
    </I18nextProvider>
  );

describe('FleetDrawer', () => {
  it('renders the persistent untrusted-data notice in every state', () => {
    for (const load of [
      { status: 'loading' },
      { status: 'ready', output: 'hello' },
      { status: 'error', error: 'boom' },
    ] as FleetPaneLoad[]) {
      const markup = render(load);
      expect(markup).toContain('fleet-drawer-notice');
      // The mission requires an explicit "raw terminal output (untrusted)" label.
      expect(markup).toContain('终端原始输出');
    }
  });

  it('shows the loading state without an output block', () => {
    const markup = render({ status: 'loading' });
    expect(markup).toContain('fleet-drawer-status');
    expect(markup).toContain('正在读取');
    expect(markup).not.toContain('fleet-drawer-output');
  });

  it('renders ready output as monospace pre text preserving newlines', () => {
    const markup = render({ status: 'ready', output: 'line1\nline2' });
    expect(markup).toContain('<pre class="fleet-drawer-output"');
    expect(markup).toContain('line1\nline2');
    expect(markup).not.toContain('fleet-drawer-error');
  });

  it('treats untrusted output as plain text, never markup', () => {
    const markup = render({ status: 'ready', output: '<script>alert(1)</script>' });
    // React escapes text children: the raw tag must not appear, only its escaped form.
    expect(markup).not.toContain('<script>alert(1)</script>');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows the empty state when a ready pane has no output', () => {
    const markup = render({ status: 'ready', output: '   ' });
    expect(markup).toContain('fleet-drawer-status');
    expect(markup).toContain('暂无输出');
    expect(markup).not.toContain('fleet-drawer-output');
  });

  it('shows a clear error message (not blank) when the read fails', () => {
    const markup = render({ status: 'error', error: 'pane closed' });
    expect(markup).toContain('fleet-drawer-error');
    expect(markup).toContain('pane closed');
    expect(markup).not.toContain('fleet-drawer-output');
  });

  it('falls back to a generic error message when none is provided', () => {
    const markup = render({ status: 'error', error: '' });
    expect(markup).toContain('fleet-drawer-error');
    expect(markup).toContain('读取 pane 输出失败');
  });

  it('renders the pane header metadata and a close button', () => {
    const markup = render(
      { status: 'loading' },
      {
        agent: { name: 'pi-agent', kind: 'pi', status: 'working' },
      }
    );
    expect(markup).toContain('ticket 03');
    expect(markup).toContain('/tmp/ev');
    expect(markup).toContain('pi-agent · pi');
    expect(markup).toContain('aria-label="关闭输出抽屉"');
  });

  it('dedupes the agent label when name equals kind', () => {
    // name === kind ('pi'/'pi') renders once, not "pi · pi".
    const markup = render({ status: 'loading' });
    expect(markup).toContain('fleet-drawer-sub');
    expect(markup).not.toContain('pi · pi');
    expect(markup).toContain('pi · /tmp/ev');
  });

  it('falls back to the pane id when the title is empty', () => {
    const markup = render({ status: 'loading' }, { title: '', cwd: undefined, agent: undefined });
    expect(markup).toContain('w1:p1');
    expect(markup).not.toContain('fleet-drawer-sub');
  });
});
