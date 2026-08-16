import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../i18n';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeDescriptor } from '../shared/types';
import { ChatPanel } from './ChatPanel';

const renderMarkup = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const runtimes: RuntimeDescriptor[] = [
  {
    id: 'pi',
    name: 'Pi',
    availability: 'available',
    version: '0.83.0',
    capabilities: {
      models: true,
      thinkingLevels: true,
      tools: true,
      resumeSession: true,
      structuredEvents: true,
      permissionModes: false,
    },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    availability: 'available',
    version: '0.146.0',
    capabilities: {
      models: false,
      thinkingLevels: false,
      tools: true,
      resumeSession: true,
      structuredEvents: true,
      permissionModes: true,
    },
  },
];

const baseProps = {
  task: null,
  providers: [],
  runtimes,
  canSwitch: true,
  selectedModel: '',
  thinkingLevel: 'medium' as const,
  defaultWorkspace: process.cwd(),
  onCreate: vi.fn(),
  onSend: vi.fn(),
  onAbort: vi.fn(),
  onModel: vi.fn(),
  onThinking: vi.fn(),
  onRuntime: vi.fn(),
};

describe('ChatPanel model controls', () => {
  it('shows the model selector before the first task exists', () => {
    const html = renderMarkup(<ChatPanel {...baseProps} runtimeId='pi' />);

    expect(html).toContain('aria-label="选择模型"');
    expect(html).toContain('aria-label="选择 Runtime"');
    expect(html).toContain('思考：');
    // ticket 0007：pi 无可用模型时首跑提示去设置登录
    expect(html).toContain('当前 Runtime 需要先在设置里登录模型 / Provider。');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('window-drag-region');
    expect(html).toContain(`title="${process.cwd()}"`);
    expect(html).toContain('新建任务');
  });

  it('P2：capability=false 显示「暂不支持」禁用态，不静默隐藏', () => {
    const html = renderMarkup(<ChatPanel {...baseProps} runtimeId='codex' />);

    expect(html).toContain('模型：暂不支持');
    expect(html).toContain('思考：暂不支持');
    expect(html).not.toContain('aria-label="选择模型"');
  });

  it('P2：有 modelCatalog 的 runtime 在任务态显示模型菜单', () => {
    const catalogRuntime = {
      id: 'claude-code' as const,
      name: 'Claude Code',
      availability: 'available' as const,
      modelCatalog: [{ id: 'sonnet', name: 'Claude Sonnet' }],
      capabilities: {
        models: true,
        thinkingLevels: true,
        tools: true,
        resumeSession: true,
        structuredEvents: true,
        permissionModes: true,
      },
    };
    const task = {
      id: 't1',
      title: '新任务',
      cwd: process.cwd(),
      status: 'idle' as const,
      createdAt: 1,
      updatedAt: 1,
      thinkingLevel: 'medium' as const,
      messages: [],
      trace: [],
      runtime: { runtimeId: 'claude-code' as const, nativeId: 'n1' },
    };
    const html = renderMarkup(
      <ChatPanel {...baseProps} runtimes={[catalogRuntime]} runtimeId='claude-code' task={task} />
    );

    expect(html).toContain('aria-label="选择模型"');
    // 无 task.model 时 trigger 显示「模型：CLI 默认」，目录项在弹层内。
    expect(html).toContain('模型：CLI 默认');
  });

  it('renders static chips when switching is locked', () => {
    const html = renderMarkup(<ChatPanel {...baseProps} runtimeId='pi' canSwitch={false} />);

    expect(html).not.toContain('aria-label="选择 Runtime"');
    expect(html).toContain('config-chip-static');
  });
});
