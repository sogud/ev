import { FolderOpen, Plus, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { RuntimeDescriptor, TaskSummary } from '../../../shared/types';
import { runtimeMonogram } from './ui/runtimeMeta';

interface SidebarProps {
  tasks: TaskSummary[];
  selectedId: string | null;
  defaultWorkspace: string | null;
  runtimes: RuntimeDescriptor[];
  onSelect(id: string): void;
  onCreate(): void;
  onRemove(id: string): void;
  onSettings(): void;
}

function timeAgo(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/*
 * sidebar 纯展示：平铺任务列表 + 只读 runtime glyph。
 * Runtime 的切换入口在对话框下方，sidebar 不放任何切换交互。
 */
export function Sidebar({
  tasks,
  selectedId,
  defaultWorkspace,
  runtimes,
  onSelect,
  onCreate,
  onRemove,
  onSettings,
}: SidebarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const recentWindow = 7 * 24 * 3600 * 1000;
  const isRecent = (task: TaskSummary): boolean =>
    task.status !== 'idle' || Date.now() - task.updatedAt < recentWindow;
  const visible = expanded ? sorted : sorted.filter(isRecent);
  const hiddenCount = sorted.length - visible.length;
  // 任务行的 runtime 只是只读展示：descriptor glyph 优先，monogram 兜底；
  // 历史任务无 session ref 时按 pi 显示。
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
          新任务
          <kbd>⌘N</kbd>
        </button>
      </div>

      <nav className='task-list' aria-label='任务列表'>
        {visible.map(task => (
          <div className={`task-row ${selectedId === task.id ? 'active' : ''}`} key={task.id}>
            <button type='button' className='task-select' onClick={() => onSelect(task.id)}>
              <span className={`status-dot ${task.status}`} />
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
              aria-label={`删除 ${task.title}`}
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
            {expanded ? '收起历史' : `显示更多（${hiddenCount}）`}
          </button>
        )}
        {sorted.length === 0 && <p className='sidebar-empty'>还没有任务</p>}
      </nav>

      <div className='sidebar-footer'>
        <div className='workspace-summary' title={defaultWorkspace ?? ''}>
          <FolderOpen size={15} />
          <span>{defaultWorkspace?.split('/').pop() ?? '未选择目录'}</span>
        </div>
        <button className='icon-button' type='button' aria-label='设置' onClick={onSettings}>
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
