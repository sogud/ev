import { FolderOpen, LayoutGrid, Plus, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import type { RuntimeDescriptor, TaskSummary } from '../shared/types';
import { runtimeMonogram } from './ui/runtimeMeta';

interface SidebarProps {
  tasks: TaskSummary[];
  selectedId: string | null;
  defaultWorkspace: string | null;
  runtimes: RuntimeDescriptor[];
  /** Which main-area view is open (herdr-fleet-v1 prototype). */
  activeView: 'chat' | 'fleet';
  onSelect(id: string): void;
  onCreate(): void;
  onRemove(id: string): void;
  onOpenFleet(): void;
  onSettings(): void;
}

function timeAgo(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return i18n.t('common.justNow');
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/*
 * Task-row status glyph, adapted from beautifului.dev Task Rows (MIT):
 * running = spinning arc ring, error = red disc with x, idle = quiet dot.
 */
function TaskStatusIcon({ status }: { status: TaskSummary['status'] }): React.JSX.Element {
  if (status === 'running') {
    return (
      <span className='task-status running' aria-hidden='true'>
        <svg width='18' height='18' viewBox='0 0 24 24'>
          <circle
            cx='12'
            cy='12'
            r='10'
            fill='none'
            stroke='var(--ev-color-border-strong)'
            strokeWidth='2'
          />
          <circle
            cx='12'
            cy='12'
            r='10'
            fill='none'
            stroke='var(--ev-color-status-info)'
            strokeWidth='2'
            strokeLinecap='round'
            strokeDasharray='17.6 45.2'
          />
        </svg>
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className='task-status error' aria-hidden='true'>
        <svg
          width='10'
          height='10'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='3'
          strokeLinecap='round'>
          <path d='M18 6L6 18M6 6l12 12' />
        </svg>
      </span>
    );
  }
  return <span className='task-status idle' aria-hidden='true' />;
}

/*
 * The sidebar is display-only: flat task list + read-only runtime glyph.
 * Runtime switching lives under the composer, never here.
 */
export function Sidebar({
  tasks,
  selectedId,
  defaultWorkspace,
  runtimes,
  activeView,
  onSelect,
  onCreate,
  onRemove,
  onOpenFleet,
  onSettings,
}: SidebarProps): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const recentWindow = 7 * 24 * 3600 * 1000;
  const isRecent = (task: TaskSummary): boolean =>
    task.status !== 'idle' || Date.now() - task.updatedAt < recentWindow;
  const visible = expanded ? sorted : sorted.filter(isRecent);
  const hiddenCount = sorted.length - visible.length;
  // Read-only runtime hint per row: descriptor glyph first, monogram fallback;
  // legacy tasks without a session ref render as pi.
  const glyphOf = (task: TaskSummary): string => {
    const id = task.runtime?.runtimeId ?? 'pi';
    return runtimes.find(runtime => runtime.id === id)?.glyph ?? runtimeMonogram(id);
  };

  return (
    <aside className='sidebar'>
      <div className='sidebar-drag-region' />
      <div className='new-task-row'>
        <button className='new-task-button' type='button' onClick={onCreate}>
          <Plus size={16} />
          {t('common.newTask')}
          <kbd>⌘N</kbd>
        </button>
      </div>

      <nav className='task-list' aria-label={t('sidebar.taskListAria')}>
        {visible.map(task => (
          <div className={`task-row ${selectedId === task.id ? 'active' : ''}`} key={task.id}>
            <button type='button' className='task-select' onClick={() => onSelect(task.id)}>
              <TaskStatusIcon status={task.status} />
              <span className='task-copy'>
                <span className='task-title'>{task.title}</span>
                <span className='task-meta' title={task.runtime?.runtimeId ?? 'pi'}>
                  {glyphOf(task)}
                </span>
              </span>
              <span className='task-time'>{timeAgo(task.updatedAt)}</span>
            </button>
            <button
              className='task-remove'
              type='button'
              aria-label={t('sidebar.deleteTask', { title: task.title })}
              onClick={() => onRemove(task.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {(hiddenCount > 0 || expanded) && (
          <button
            className='task-show-more'
            type='button'
            onClick={() => setExpanded(value => !value)}>
            {expanded
              ? t('sidebar.collapseHistory')
              : t('sidebar.showMore', { count: hiddenCount })}
          </button>
        )}
        {sorted.length === 0 && <p className='sidebar-empty'>{t('sidebar.empty')}</p>}
      </nav>

      <div className='sidebar-footer'>
        <div className='workspace-summary' title={defaultWorkspace ?? ''}>
          <FolderOpen size={15} />
          <span>{defaultWorkspace?.split('/').pop() ?? t('sidebar.noWorkspace')}</span>
        </div>
        <button
          className={
            activeView === 'fleet' ? 'icon-button fleet-toggle active' : 'icon-button fleet-toggle'
          }
          type='button'
          aria-label={t('fleet.openAria')}
          aria-pressed={activeView === 'fleet'}
          data-testid='fleet-open'
          onClick={onOpenFleet}>
          <LayoutGrid size={17} />
          <span className='fleet-toggle-label'>{t('fleet.title')}</span>
        </button>
        <button
          className='icon-button'
          type='button'
          aria-label={t('settings.title')}
          data-testid='settings-open'
          onClick={onSettings}>
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
