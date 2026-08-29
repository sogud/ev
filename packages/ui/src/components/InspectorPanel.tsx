import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, GitCompare, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { TaskInspection, TraceEvent } from '../shared/types';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { splitDiffByFile } from '../diff-split';
import {
  buildTrajectory,
  formatDuration,
  formatTimestamp,
  tokensLabel,
} from '../trajectory-view-model';

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
  useEscapeToClose(onClose);

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
      {tab === 'trace' ? <TrajectoryTable trace={trace} /> : <Changes inspection={inspection} />}
    </aside>
  );
}

/**
 * Trajectory table (DSH-trajectory P1): turn-grouped event rows; clicking a
 * row opens the inspector below it. Running rows show no fabricated
 * duration/token values — undefined fields render as "–".
 */
function TrajectoryTable({ trace }: { trace: TraceEvent[] }): React.JSX.Element {
  const { t } = useTranslation();
  const view = useMemo(() => buildTrajectory(trace), [trace]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (trace.length === 0) return <div className='inspector-empty'>{t('inspector.empty')}</div>;
  return (
    <div className='trajectory-table'>
      <div className='trajectory-head' aria-hidden='true'>
        <span />
        <span>{t('inspector.trajectoryColType')}</span>
        <span>{t('inspector.trajectoryColTitle')}</span>
        <span>{t('inspector.trajectoryColStatus')}</span>
        <span>{t('inspector.trajectoryColDuration')}</span>
        <span>{t('inspector.trajectoryColTokens')}</span>
      </div>
      {view.turns.map(turn => (
        <Fragment key={turn.id}>
          <div className='trajectory-turn-divider'>
            {turn.kind === 'setup'
              ? t('inspector.trajectorySetup')
              : t('inspector.trajectoryTurn', { n: turn.index })}
          </div>
          {turn.rows.map(({ event: rowEvent, index }) => {
            const selected = selectedId === rowEvent.id;
            return (
              <div className='trajectory-item' key={rowEvent.id}>
                <button
                  type='button'
                  className={`trajectory-row ${rowEvent.status}${selected ? ' selected' : ''}`}
                  aria-expanded={selected}
                  onClick={() => setSelectedId(selected ? null : rowEvent.id)}>
                  <span className='trajectory-index'>{index}</span>
                  <span className='trajectory-type'>{rowEvent.type}</span>
                  <span className='trajectory-title'>{rowEvent.title}</span>
                  <span className='trajectory-status'>
                    {rowEvent.status === 'running' ? (
                      <LoaderCircle className='spin' size={12} />
                    ) : rowEvent.status === 'error' ? (
                      <CircleAlert size={12} />
                    ) : (
                      <Check size={12} />
                    )}
                  </span>
                  <span className='trajectory-duration'>
                    {rowEvent.status === 'running'
                      ? ''
                      : (formatDuration(rowEvent.durationMs) ?? '–')}
                  </span>
                  <span className='trajectory-tokens'>{tokensLabel(rowEvent) ?? '–'}</span>
                </button>
                {selected && <RowInspector event={rowEvent} />}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/** Expanded row inspector: payloads, token usage, timing. Missing fields stay hidden. */
function RowInspector({ event }: { event: TraceEvent }): React.JSX.Element {
  const { t } = useTranslation();
  const tokens = tokensLabel(event);
  return (
    <div className='trajectory-inspector'>
      <dl className='trajectory-kv'>
        <dt>{t('inspector.trajectoryTokens')}</dt>
        <dd>{tokens ?? '–'}</dd>
        {event.ttftMs !== undefined && (
          <>
            <dt>{t('inspector.trajectoryFirstToken')}</dt>
            <dd>{formatDuration(event.ttftMs) ?? '–'}</dd>
          </>
        )}
        {event.status !== 'running' && event.durationMs !== undefined && (
          <>
            <dt>{t('inspector.trajectoryDuration')}</dt>
            <dd>{formatDuration(event.durationMs) ?? '–'}</dd>
          </>
        )}
        <dt>{t('inspector.trajectoryStarted')}</dt>
        <dd>{formatTimestamp(event.timestamp)}</dd>
      </dl>
      {event.input !== undefined && (
        <div className='trajectory-payload'>
          <h4>{t('inspector.trajectoryInput')}</h4>
          <pre>{event.input}</pre>
        </div>
      )}
      {event.output !== undefined && (
        <div className='trajectory-payload'>
          <h4>{t('inspector.trajectoryOutput')}</h4>
          <pre>{event.output}</pre>
        </div>
      )}
      {event.input === undefined && event.output === undefined && event.detail && (
        <pre>{event.detail}</pre>
      )}
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
