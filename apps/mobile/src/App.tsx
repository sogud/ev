/**
 * Standalone mobile web entry (P3 R3, React): /m route, 390x844 baseline.
 * Reuses only the contracts client + design tokens; components are written
 * independently from the desktop renderer. Minimal feature set: task list ->
 * detail (transcript + send) -> model switch + runtime status line.
 */
import type { ProviderSummary, TaskDetail, TaskSummary } from '@ev/contracts/domain';
import type { RuntimeDescriptor } from '@ev/contracts';
import { createEvClient } from '@ev/contracts/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasLangOverride, i18n } from './i18n';
import { resolveLanguage } from '@ev/locales';
import '@ev/design-tokens/theme.css';
import './style.css';

const params = new URLSearchParams(window.location.search);
const api = createEvClient({
  baseUrl: `http://${window.location.hostname}:${params.get('port') ?? (window.location.port || '7877')}`,
  token: params.get('token') ?? '',
});

function timeAgo(ts: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 1) return i18n.t('common.justNow');
  if (minutes < 60) return i18n.t('common.minutesAgo', { count: minutes });
  return i18n.t('common.hoursAgo', { count: Math.round(minutes / 60) });
}

interface ModelOption {
  provider: string;
  id: string;
  name: string;
}

function authLabel(status: string | undefined): string {
  if (status === 'logged_in') return i18n.t('common.loggedIn');
  if (status === 'logged_out') return i18n.t('common.loggedOut');
  return i18n.t('common.authUnknown');
}

export function App(): React.JSX.Element {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeDescriptor[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.tasks.list(),
      api.runtimes.list(),
      api.providers.list(),
      api.settings.get().catch(() => null),
    ])
      .then(([taskList, runtimeList, providerList, settings]) => {
        if (settings && !hasLangOverride)
          void i18n.changeLanguage(resolveLanguage(settings.language));
        if (!alive) return;
        setTasks(taskList);
        setRuntimes(runtimeList);
        setProviders(providerList);
      })
      .catch(err => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    const offReconnect = api.onReconnect(() => {
      // Full refetch after a reconnect to converge events missed while offline.
      void api.tasks.list().then(list => {
        if (alive) setTasks(list);
      });
      setDetail(prev => {
        if (prev) void api.tasks.get(prev.id).then(fresh => setDetail(fresh));
        return prev;
      });
    });
    const off = api.onWire('tasks:update', payload => {
      const task = payload as TaskDetail;
      setTasks(prev => {
        const known = prev.some(item => item.id === task.id);
        const summary: TaskSummary = {
          id: task.id,
          title: task.title,
          cwd: task.cwd,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          thinkingLevel: task.thinkingLevel,
          runtime: task.runtime,
          pendingRuntimeId: task.pendingRuntimeId,
          model: task.model,
        };
        return known
          ? prev.map(item => (item.id === task.id ? { ...item, ...summary } : item))
          : [summary, ...prev];
      });
      setDetail(prev => (prev?.id === task.id ? task : prev));
    });
    return () => {
      alive = false;
      off();
      offReconnect();
    };
  }, []);

  const runtimeOf = (task: TaskSummary | null): RuntimeDescriptor | undefined => {
    const id = task?.runtime?.runtimeId ?? task?.pendingRuntimeId;
    return runtimes.find(runtime => runtime.id === id);
  };

  const statusLine = useMemo(() => {
    const runtime = runtimeOf(detail) ?? runtimes[0];
    if (!runtime) return i18n.t('mobile.runtimeUnknown');
    const auth = authLabel(runtime.auth?.status);
    const availability =
      runtime.availability === 'available'
        ? i18n.t('common.available')
        : i18n.t('common.unavailable');
    return `${runtime.name} · ${availability} · ${auth}`;
  }, [detail, runtimes]);

  if (error) return <p className='m-empty'>{t('mobile.connectError', { error })}</p>;

  return detail ? (
    <DetailView
      detail={detail}
      statusLine={statusLine}
      runtime={runtimeOf(detail)}
      providers={providers}
      sheetOpen={sheetOpen}
      setSheetOpen={setSheetOpen}
      onBack={() => {
        setDetail(null);
        setSheetOpen(false);
      }}
      onSend={text => {
        // No local echo: the user turn arrives via the tasks:update event stream.
        void api.tasks.prompt(detail.id, text);
      }}
      onModel={(provider, id) => {
        setSheetOpen(false);
        // setModel has no response body; the tasks:update broadcast reconciles detail.
        void api.tasks.setModel(detail.id, provider, id);
      }}
    />
  ) : (
    <>
      <header className='m-header'>
        <h1>EV</h1>
        <span className='m-status'>{statusLine}</span>
      </header>
      <main className='m-list'>
        {tasks.length === 0 && <p className='m-empty'>{t('mobile.emptyTasks')}</p>}
        {tasks.map(task => (
          <button
            type='button'
            key={task.id}
            className='m-task'
            data-task={task.id}
            onClick={() => {
              void api.tasks.get(task.id).then(got => {
                setDetail(got);
                setSheetOpen(false);
              });
            }}>
            <strong>{task.title || t('common.newTask')}</strong>
            <span>
              {runtimeOf(task)?.glyph ?? '·'} {timeAgo(task.updatedAt)}
            </span>
          </button>
        ))}
      </main>
    </>
  );
}

function modelLabelOf(detail: TaskDetail, runtime: RuntimeDescriptor | undefined): string {
  if (detail.model) return detail.model.id;
  if (runtime && runtime.id !== 'pi')
    return runtime.modelCatalog?.[0]?.name ?? i18n.t('mobile.model');
  return i18n.t('mobile.model');
}

function DetailView(props: {
  detail: TaskDetail;
  statusLine: string;
  runtime?: RuntimeDescriptor;
  providers: ProviderSummary[];
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  onBack: () => void;
  onSend: (text: string) => void;
  onModel: (provider: string, id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const {
    detail,
    statusLine,
    runtime,
    providers,
    sheetOpen,
    setSheetOpen,
    onBack,
    onSend,
    onModel,
  } = props;
  // Uncontrolled input: automation (golden) can assign .value directly; real typing works the same.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);

  const submit = (): void => {
    const node = inputRef.current;
    const text = node?.value.trim() ?? '';
    if (!text || !node) return;
    node.value = '';
    onSend(text);
  };

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [detail.messages.length]);

  const modelOptions: ModelOption[] = useMemo(() => {
    if (runtime?.id === 'pi') {
      return providers.flatMap(provider =>
        provider.models
          .filter(model => model.available)
          .map(model => ({ provider: provider.id, id: model.id, name: model.name }))
      );
    }
    return (runtime?.modelCatalog ?? []).map(model => ({
      provider: runtime!.id,
      id: model.id,
      name: model.name,
    }));
  }, [runtime, providers]);

  const modelLabel = modelLabelOf(detail, runtime);

  return (
    <>
      <header className='m-header'>
        <button
          type='button'
          className='m-back'
          data-back='1'
          aria-label={t('common.back')}
          onClick={onBack}>
          ‹
        </button>
        <h1>{detail.title || t('mobile.taskFallback')}</h1>
        <span className='m-status'>{statusLine}</span>
      </header>
      <main className='m-transcript' ref={transcriptRef as React.RefObject<HTMLElement>}>
        {detail.messages
          .filter(message => message.kind === 'user' || message.kind === 'assistant')
          .map(message => (
            <div key={message.id} className={`m-msg ${message.kind}`}>
              <span className='m-role'>{message.kind === 'user' ? t('mobile.you') : 'EV'}</span>
              <p>{message.content}</p>
            </div>
          ))}
      </main>
      <footer className='m-bar'>
        <button
          type='button'
          className='m-chip'
          data-sheet='model'
          aria-label={t('mobile.switchModel')}
          onClick={() => setSheetOpen(true)}>
          {modelLabel}
        </button>
        <input
          id='m-input'
          placeholder={t('mobile.placeholder')}
          enterKeyHint='send'
          ref={inputRef}
          onKeyDown={event => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button
          type='button'
          className='m-send'
          data-send='1'
          aria-label={t('common.send')}
          onClick={submit}>
          ↑
        </button>
      </footer>
      {sheetOpen && (
        <div className='m-sheet' data-sheet-close='1'>
          <button
            type='button'
            className='m-sheet-backdrop'
            aria-label={t('mobile.closeSheet')}
            onClick={() => setSheetOpen(false)}
          />
          <div className='m-sheet-card' role='dialog' aria-label={t('mobile.switchModel')}>
            {modelOptions.length === 0 && <p className='m-empty'>{t('mobile.nativeSource')}</p>}
            {modelOptions.map(option => (
              <button
                type='button'
                key={`${option.provider}/${option.id}`}
                className='m-sheet-item'
                data-model-provider={option.provider}
                data-model-id={option.id}
                onClick={() => onModel(option.provider, option.id)}>
                {option.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
