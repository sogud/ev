import { Folder, GitBranch, Plus, Settings2, Sparkles, SquareArrowOutUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  ProviderSummary,
  RuntimeDescriptor,
  RuntimeId,
  TaskDetail,
  ThinkingLevel,
} from '../../../shared/types';
import { Composer } from './Composer';
import { InspectorPanel } from './InspectorPanel';
import { MenuPicker } from './ui/MenuPicker';
import { ModelPicker } from './ui/ModelPicker';
import { RuntimePicker } from './ui/RuntimePicker';
import { ThinkingPicker } from './ui/ThinkingPicker';
import { Transcript } from './Transcript';

interface ChatPanelProps {
  task: TaskDetail | null;
  providers: ProviderSummary[];
  runtimes: RuntimeDescriptor[];
  canSwitch: boolean;
  selectedModel: string;
  runtimeId: RuntimeId;
  thinkingLevel: ThinkingLevel;
  defaultWorkspace: string;
  onCreate(): void;
  onSend(prompt: string): void;
  onAbort(): void;
  onModel(provider: string, model: string): void;
  onThinking(level: ThinkingLevel): void;
  onRuntime(id: RuntimeId): void;
}

export function ChatPanel({
  task,
  providers,
  runtimes,
  canSwitch,
  selectedModel,
  runtimeId,
  thinkingLevel,
  defaultWorkspace,
  onCreate,
  onSend,
  onAbort,
  onModel,
  onThinking,
  onRuntime,
}: ChatPanelProps): React.JSX.Element {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const workspace = task?.cwd ?? defaultWorkspace;
  // capabilities 来自 main 侧 RuntimeDescriptor（runtimes:list）；
  // pi 兜底 true 是因为 pi 永远注册，descriptor 缺失时按最全能力渲染。
  const activeRuntime = runtimes.find(runtime => runtime.id === runtimeId);
  const supportsModels = activeRuntime?.capabilities.models ?? runtimeId === 'pi';
  const supportsThinking = activeRuntime?.capabilities.thinkingLevels ?? runtimeId === 'pi';
  const catalog = activeRuntime?.modelCatalog;

  useEffect(() => {
    if (!task) {
      setBranch(null);
      return;
    }
    let stale = false;
    void window.agentDesktop.workspace.gitBranch(task.cwd).then(value => {
      if (!stale) setBranch(value);
    });
    return () => {
      stale = true;
    };
  }, [task?.id, task?.cwd]);

  // Runtime 的唯一切换入口在对话框下方这一行（sidebar 纯展示）；
  // 对话开始后（canSwitch=false）退化为静态 chip。
  // 同一组 chip 复用于 composer 前导与未建任务空态两处；
  // 顺序：Runtime、思考强度、模型。
  const configChips = (
    <>
      {canSwitch ? (
        <RuntimePicker runtimes={runtimes} value={runtimeId} onValueChange={onRuntime} />
      ) : (
        <span className='config-chip-static'>{activeRuntime?.name ?? runtimeId}</span>
      )}
      {/* P2：capability=false 显示「暂不支持」禁用态，不再静默隐藏 */}
      {supportsThinking ? (
        <ThinkingPicker value={thinkingLevel} onValueChange={onThinking} />
      ) : (
        <span className='config-chip-static'>思考：暂不支持</span>
      )}
      {runtimeId === 'pi' ? (
        <ModelPicker providers={providers} value={selectedModel} onValueChange={onModel} />
      ) : supportsModels && catalog && catalog.length > 0 ? (
        task ? (
          <MenuPicker
            value={task.model?.id ?? ''}
            options={catalog.map(item => ({ value: item.id, label: item.name }))}
            ariaLabel='选择模型'
            triggerLabel={task.model?.name ?? '模型：CLI 默认'}
            align='start'
            onValueChange={id => onModel(runtimeId, id)}
          />
        ) : (
          <span className='config-chip-static'>模型：CLI 默认</span>
        )
      ) : (
        <span className='config-chip-static'>模型：暂不支持</span>
      )}
    </>
  );

  return (
    <main className='chat-panel'>
      <header className='chat-header'>
        <div className='header-title'>
          <strong>{task?.title ?? '新任务默认设置'}</strong>
          <button
            type='button'
            title={workspace}
            onClick={() => void window.agentDesktop.settings.openPath(workspace)}>
            <Folder size={13} /> {workspace.split('/').pop() || workspace}
          </button>
        </div>
        <div className='header-controls'>
          <span className='runtime-badge'>
            {runtimes.find(runtime => runtime.id === runtimeId)?.name ?? runtimeId}
          </span>
          {task && (
            <button
              className='icon-button'
              type='button'
              title='在编辑器中打开'
              aria-label='在编辑器中打开'
              onClick={() => void window.agentDesktop.workspace.openInEditor(workspace)}>
              <SquareArrowOutUpRight size={15} />
            </button>
          )}
          {task && (
            <button
              className='icon-button'
              type='button'
              aria-label='任务检查器'
              onClick={() => setInspectorOpen(value => !value)}>
              <Settings2 size={16} />
            </button>
          )}
        </div>
      </header>
      {task ? (
        <div className='chat-workspace'>
          <div className='conversation-column'>
            {task.messages.length === 0 ? (
              <div className='task-welcome'>
                <div className='empty-icon'>
                  <Sparkles size={22} />
                </div>
                <h1>{task.status === 'error' ? '任务工作空间不可用' : '你想做什么？'}</h1>
                <p>
                  {task.error ??
                    'EV 可以读取当前目录、修改文件、运行命令，并使用已启用的 Skills 和 Extensions。'}
                </p>
                {task.status !== 'error' && runtimeId === 'pi' && !task.model && (
                  <p className='empty-hint'>当前 Runtime 需要先在设置里登录模型 / Provider。</p>
                )}
                {task.status === 'error' && (
                  <button
                    className='primary-button empty-create-button'
                    type='button'
                    onClick={onCreate}>
                    <Plus size={16} /> 使用默认工作空间新建任务
                  </button>
                )}
              </div>
            ) : (
              <Transcript
                items={task.messages}
                running={task.status === 'running'}
                onViewDiff={() => setInspectorOpen(true)}
              />
            )}
            <Composer
              running={task.status === 'running'}
              // 无模型目录的 runtime（codex/claude/qoder）不以缺 model 禁用输入。
              disabled={(runtimeId === 'pi' && !task.model) || task.status === 'error'}
              leading={configChips}
              onSend={onSend}
              onAbort={onAbort}
            />
            {branch && (
              <div className='branch-bar'>
                <span className='branch-chip'>
                  <GitBranch size={11} aria-hidden='true' />
                  {branch}
                </span>
                <span>Local checkout</span>
              </div>
            )}
          </div>
          {inspectorOpen && (
            <InspectorPanel
              taskId={task.id}
              liveTrace={task.trace}
              onClose={() => setInspectorOpen(false)}
            />
          )}
        </div>
      ) : (
        <div className='chat-workspace'>
          <div className='empty-state'>
            <div className='empty-icon'>
              <Sparkles size={23} />
            </div>
            <h1>开始一个任务</h1>
            <p>使用下方模型和默认工作空间创建任务，之后也可以为每个任务单独调整。</p>
            <div className='empty-model-row'>{configChips}</div>
            {runtimeId === 'pi' && !selectedModel && (
              <p className='empty-hint'>当前 Runtime 需要先在设置里登录模型 / Provider。</p>
            )}
            <button className='primary-button empty-create-button' type='button' onClick={onCreate}>
              <Plus size={16} /> 新建任务
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
