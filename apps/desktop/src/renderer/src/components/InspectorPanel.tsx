import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, GitCompare, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { TaskInspection, TraceEvent } from '../../../shared/types';
import { splitDiffByFile } from '../diff-split';

type InspectorTab = 'trace' | 'changes';

export function InspectorPanel({
  taskId,
  liveTrace,
  onClose,
}: {
  taskId: string;
  liveTrace: TraceEvent[];
  onClose(): void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InspectorTab>('trace');
  const [inspection, setInspection] = useState<TaskInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setInspection(await window.agentDesktop.inspection.get(taskId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [taskId]);

  const trace = liveTrace.length > 0 ? liveTrace : (inspection?.trace ?? []);
  return (
    <aside className='inspector-panel' aria-label={t('inspector.aria')}>
      <header>
        <div className='inspector-tabs'>
          <button
            className={tab === 'trace' ? 'active' : ''}
            type='button'
            onClick={() => setTab('trace')}>
            Trace
          </button>
          <button
            className={tab === 'changes' ? 'active' : ''}
            type='button'
            onClick={() => setTab('changes')}>
            {t('inspector.changes')}
          </button>
        </div>
        <button
          className='icon-button'
          type='button'
          aria-label={t('inspector.refreshAria')}
          disabled={loading}
          onClick={() => void refresh()}>
          <RefreshCw className={loading ? 'spin' : ''} size={15} />
        </button>
        <button
          className='icon-button'
          type='button'
          aria-label={t('inspector.closeAria')}
          onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      {error && (
        <div className='inspector-error'>
          <CircleAlert size={15} />
          {error}
        </div>
      )}
      {tab === 'trace' ? <TraceList trace={trace} /> : <Changes inspection={inspection} />}
    </aside>
  );
}

function TraceList({ trace }: { trace: TraceEvent[] }): React.JSX.Element {
  const { t } = useTranslation();
  if (trace.length === 0) return <div className='inspector-empty'>{t('inspector.empty')}</div>;
  return (
    <div className='trace-list'>
      {trace.map(event => (
        <details className={`trace-row ${event.status}`} key={event.id}>
          <summary>
            <span className='trace-icon'>
              {event.status === 'running' ? (
                <LoaderCircle className='spin' size={13} />
              ) : event.status === 'error' ? (
                <CircleAlert size={13} />
              ) : (
                <Check size={13} />
              )}
            </span>
            <span>
              <strong>{event.title}</strong>
              <small>
                {event.type}
                {event.durationMs ? ` · ${event.durationMs}ms` : ''}
              </small>
            </span>
          </summary>
          {event.detail && <pre>{event.detail}</pre>}
        </details>
      ))}
    </div>
  );
}

/*
 * Diff-first (ticket 0005): the file list is an index; selecting one shows its diff hunk.
 * The first file with a diff is selected by default. Accept/revert is out of scope.
 */
function Changes({ inspection }: { inspection: TaskInspection | null }): React.JSX.Element {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const perFile = useMemo(() => splitDiffByFile(inspection?.changes.diff ?? ''), [inspection]);
  if (!inspection) return <div className='inspector-empty'>{t('inspector.loading')}</div>;
  const { changes } = inspection;
  if (!changes.isGitRepository)
    return <div className='inspector-empty'>{t('inspector.notGit')}</div>;
  const withDiff = changes.files.filter(file => perFile.has(file.path));
  const current =
    selected && (perFile.has(selected) || changes.files.some(f => f.path === selected))
      ? selected
      : (withDiff[0]?.path ?? changes.files[0]?.path ?? null);
  return (
    <div className='changes-panel'>
      <div className='changed-files'>
        <h3>
          <GitCompare size={14} />
          {t('inspector.workspaceChanges')} <span>{changes.files.length}</span>
        </h3>
        {changes.files.map(file => (
          <button
            type='button'
            className={`changed-file-row ${current === file.path ? 'active' : ''}`}
            key={`${file.status}-${file.path}`}
            onClick={() => setSelected(file.path)}>
            <code>{file.status}</code>
            <span>{file.path}</span>
          </button>
        ))}
        {changes.files.length === 0 && <p>{t('inspector.noChanges')}</p>}
      </div>
      {current &&
        (perFile.has(current) ? (
          <pre className='diff-view'>{perFile.get(current)}</pre>
        ) : (
          <p className='inline-error'>{t('inspector.noDiff')}</p>
        ))}
      {changes.error && <p className='inline-error'>{changes.error}</p>}
    </div>
  );
}
