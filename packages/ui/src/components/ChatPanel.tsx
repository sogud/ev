import {
  Folder,
  GitBranch,
  Menu,
  Plus,
  Settings2,
  Sparkles,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ProviderSummary,
  RuntimeDescriptor,
  RuntimeId,
  TaskDetail,
  ThinkingLevel,
} from '../shared/types';
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
  /** Present only in the mobile form factor: opens the sidebar drawer. */
  onOpenSidebar?(): void;
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
  onOpenSidebar,
  onCreate,
  onSend,
  onAbort,
  onModel,
  onThinking,
  onRuntime,
}: ChatPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const workspace = task?.cwd ?? defaultWorkspace;
  // Capabilities come from the main-side RuntimeDescriptor (runtimes:list);
  // pi defaults to true because it is always registered — render full caps when absent.
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

  // The only runtime switch is this row under the composer (sidebar is display-only);
  // once a conversation starts (canSwitch=false) it degrades to static chips.
  // The same chip group serves the composer leading slot and the no-task empty state;
  // order: runtime, thinking effort, model.
  const configChips = (
    <>
      {canSwitch ? (
        <RuntimePicker runtimes={runtimes} value={runtimeId} onValueChange={onRuntime} />
      ) : (
        <span className='config-chip-static'>{activeRuntime?.name ?? runtimeId}</span>
      )}
      {/* P2: unsupported capability renders a disabled chip instead of hiding silently */}
      {supportsThinking ? (
        <ThinkingPicker value={thinkingLevel} onValueChange={onThinking} />
      ) : (
        <span className='config-chip-static'>{t('chat.thinkingUnsupported')}</span>
      )}
      {runtimeId === 'pi' ? (
        <ModelPicker providers={providers} value={selectedModel} onValueChange={onModel} />
      ) : supportsModels && catalog && catalog.length > 0 ? (
        task ? (
          <MenuPicker
            value={task.model?.id ?? ''}
            options={catalog.map(item => ({ value: item.id, label: item.name }))}
            ariaLabel={t('chat.modelPickerAria')}
            triggerLabel={task.model?.name ?? t('chat.modelCliDefault')}
            align='start'
            onValueChange={id => onModel(runtimeId, id)}
          />
        ) : (
          <span className='config-chip-static'>{t('chat.modelCliDefault')}</span>
        )
      ) : (
        <span className='config-chip-static'>{t('chat.modelUnsupported')}</span>
      )}
    </>
  );

  return (
    <main className='chat-panel'>
      <header className='chat-header'>
        {onOpenSidebar && (
          <button
            className='icon-button sidebar-toggle'
            type='button'
            aria-label={t('sidebar.openMenu')}
            onClick={onOpenSidebar}>
            <Menu size={18} />
          </button>
        )}
        <div className='header-title'>
          <strong>{task?.title ?? t('chat.defaultSettings')}</strong>
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
              title={t('chat.openInEditor')}
              aria-label={t('chat.openInEditor')}
              onClick={() => void window.agentDesktop.workspace.openInEditor(workspace)}>
              <SquareArrowOutUpRight size={15} />
            </button>
          )}
          {task && (
            <button
              className='icon-button'
              type='button'
              aria-label={t('inspector.aria')}
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
                <h1>
                  {task.status === 'error' ? t('chat.workspaceUnavailable') : t('chat.emptyTitle')}
                </h1>
                <p>{task.error ?? t('chat.emptyDesc')}</p>
                {task.status !== 'error' && runtimeId === 'pi' && !task.model && (
                  <p className='empty-hint'>{t('chat.needsLogin')}</p>
                )}
                {task.status === 'error' && (
                  <button
                    className='primary-button empty-create-button'
                    type='button'
                    onClick={onCreate}>
                    <Plus size={16} /> {t('chat.createWithDefault')}
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
              // Runtimes without a model catalog (codex/claude/qoder) must not disable input over a missing model.
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
            <h1>{t('chat.startTitle')}</h1>
            <p>{t('chat.startDesc')}</p>
            <div className='empty-model-row'>{configChips}</div>
            {runtimeId === 'pi' && !selectedModel && (
              <p className='empty-hint'>{t('chat.needsLogin')}</p>
            )}
            <button className='primary-button empty-create-button' type='button' onClick={onCreate}>
              <Plus size={16} /> {t('chat.createTask')}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
