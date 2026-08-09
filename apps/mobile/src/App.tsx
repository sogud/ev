/**
 * EV 移动端独立 Web entry（P3 R3，React 版）：/m 路由，390×844 基准。
 * 只复用 contracts client + design-tokens；组件独立实现，不搬桌面 renderer。
 * 最小功能集：任务列表 → 详情（transcript+发送，乐观上屏）→ 切模型 + runtime 状态行。
 */
import type { ProviderSummary, TaskDetail, TaskSummary } from '@ev/contracts/domain';
import type { RuntimeDescriptor } from '@ev/contracts';
import { createEvClient } from '@ev/contracts/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import '@ev/design-tokens/theme.css';
import './style.css';

const params = new URLSearchParams(window.location.search);
const api = createEvClient({
  baseUrl: `http://${window.location.hostname}:${params.get('port') ?? (window.location.port || '7877')}`,
  token: params.get('token') ?? '',
});

function timeAgo(ts: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

interface ModelOption {
  provider: string;
  id: string;
  name: string;
}

function authLabel(status: string | undefined): string {
  if (status === 'logged_in') return '已登录';
  if (status === 'logged_out') return '未登录';
  return '状态未知';
}

export function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeDescriptor[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.tasks.list(), api.runtimes.list(), api.providers.list()])
      .then(([taskList, runtimeList, providerList]) => {
        if (!alive) return;
        setTasks(taskList);
        setRuntimes(runtimeList);
        setProviders(providerList);
      })
      .catch(err => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    const offReconnect = api.onReconnect(() => {
      // 断线重连后全量 refetch 收敛：列表 + 当前详情。
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
    if (!runtime) return 'runtime 未知';
    const auth = authLabel(runtime.auth?.status);
    return `${runtime.name} · ${runtime.availability === 'available' ? '可用' : '不可用'} · ${auth}`;
  }, [detail, runtimes]);

  if (error) return <p className='m-empty'>连不上 EV server：{error}</p>;

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
        // 不靠本地回显：user turn 在 tasks:update 事件流里，WS 送达即上屏。
        void api.tasks.prompt(detail.id, text);
      }}
      onModel={(provider, id) => {
        setSheetOpen(false);
        // setModel 无返回体；tasks:update 广播会校正 detail。
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
        {tasks.length === 0 && <p className='m-empty'>暂无任务，桌面端创建后这里可见</p>}
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
            <strong>{task.title || '新任务'}</strong>
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
  if (runtime && runtime.id !== 'pi') return runtime.modelCatalog?.[0]?.name ?? '模型';
  return '模型';
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
  // 非受控输入：外部自动化（golden）直接赋 value 也能读到，真实键入同样工作。
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
        <button type='button' className='m-back' data-back='1' aria-label='返回' onClick={onBack}>
          ‹
        </button>
        <h1>{detail.title || '任务'}</h1>
        <span className='m-status'>{statusLine}</span>
      </header>
      <main className='m-transcript' ref={transcriptRef as React.RefObject<HTMLElement>}>
        {detail.messages
          .filter(message => message.kind === 'user' || message.kind === 'assistant')
          .map(message => (
            <div key={message.id} className={`m-msg ${message.kind}`}>
              <span className='m-role'>{message.kind === 'user' ? '你' : 'EV'}</span>
              <p>{message.content}</p>
            </div>
          ))}
      </main>
      <footer className='m-bar'>
        <button
          type='button'
          className='m-chip'
          data-sheet='model'
          aria-label='切换模型'
          onClick={() => setSheetOpen(true)}>
          {modelLabel}
        </button>
        <input
          id='m-input'
          placeholder='发送一句话…'
          enterKeyHint='send'
          ref={inputRef}
          onKeyDown={event => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button type='button' className='m-send' data-send='1' aria-label='发送' onClick={submit}>
          ↑
        </button>
      </footer>
      {sheetOpen && (
        <div className='m-sheet' data-sheet-close='1'>
          <button
            type='button'
            className='m-sheet-backdrop'
            aria-label='关闭模型列表'
            onClick={() => setSheetOpen(false)}
          />
          <div className='m-sheet-card' role='dialog' aria-label='选择模型'>
            {modelOptions.length === 0 && <p className='m-empty'>以原生为准</p>}
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
