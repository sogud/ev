import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from '../../../shared/types';
import { buildTranscriptView, type ChangedFileView, type TurnView } from '../transcript-view-model';

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(turn: TurnView): string {
  const seconds = Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const segments = paths[0].split('/');
  let prefix: string[] = [];
  for (const segment of segments) {
    const next = [...prefix, segment];
    if (paths.every(path => path.startsWith(next.join('/') + '/') || path === next.join('/'))) {
      prefix = next;
    } else {
      break;
    }
  }
  return prefix.join('/');
}

function ChangedFilesCard({
  files,
  onViewDiff,
}: {
  files: ChangedFileView[];
  onViewDiff(): void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const prefix = commonPrefix(files.map(file => file.path));

  return (
    <div className='cf-card'>
      <div className='cf-head'>
        <span className='cf-title'>CHANGED FILES ({files.length})</span>
        <span className='cf-actions'>
          <button type='button' onClick={() => setCollapsed(value => !value)}>
            {collapsed ? 'Expand all' : 'Collapse all'}
          </button>
          <button type='button' onClick={onViewDiff}>
            View diff
          </button>
        </span>
      </div>
      {!collapsed && (
        <>
          {prefix && <div className='cf-row folder'>▾ {prefix}</div>}
          {files.map(file => (
            <div className='cf-row file' key={file.path}>
              <span className='path'>
                {prefix ? file.path.slice(prefix.length + 1) : file.path}
              </span>
              <span className='tool'>{file.tool}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let key = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code className='doc-code' key={key++}>
          {token.slice(1, -1)}
        </code>
      );
    } else {
      nodes.push(
        <strong className='doc-strong' key={key++}>
          {token.slice(2, -2)}
        </strong>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MarkdownText({ text }: { text: string }): React.JSX.Element {
  const nodes: React.ReactNode[] = [];
  let fence: string[] | null = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trimStart().startsWith('```')) {
      if (fence) {
        nodes.push(
          <pre className='doc-pre' key={index}>
            {fence.join('\n')}
          </pre>
        );
        fence = null;
      } else {
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      nodes.push(
        <p className={`doc-h${level}`} key={index}>
          {renderInline(heading[2])}
        </p>
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      nodes.push(
        <p className='doc-li' key={index}>
          {renderInline(bullet[1])}
        </p>
      );
      continue;
    }
    if (line.trim() === '') continue;
    nodes.push(
      <p className='doc-line' key={index}>
        {renderInline(line)}
      </p>
    );
  }
  if (fence) {
    nodes.push(
      <pre className='doc-pre' key='open-fence'>
        {fence.join('\n')}
      </pre>
    );
  }
  return <div className='doc-md'>{nodes}</div>;
}

export function Transcript({
  items,
  running,
  onViewDiff,
}: {
  items: TranscriptItem[];
  running: boolean;
  onViewDiff(): void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const view = useMemo(() => buildTranscriptView(items, running), [items, running]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [view]);

  return (
    <div className='transcript-c'>
      <div className='doc-column'>
        {view.turns.map(turn => (
          <section className='turn' key={turn.id}>
            {turn.userText !== null && <blockquote className='user-q'>{turn.userText}</blockquote>}
            {turn.doc.map(block =>
              block.tone === 'error' ? (
                <p className='doc-error' key={block.id}>
                  {block.text}
                </p>
              ) : (
                <MarkdownText key={block.id} text={block.text} />
              )
            )}
            {turn.changedFiles.length > 0 && (
              <ChangedFilesCard files={turn.changedFiles} onViewDiff={onViewDiff} />
            )}
            <footer className='turn-footer'>
              {formatClock(turn.endedAt)} · {formatDuration(turn)}
              {turn.running ? ` · ${t('transcript.running')}` : ''}
            </footer>
          </section>
        ))}
        {running && (
          <div className='working-indicator'>
            <span />
            <span />
            <span /> {t('transcript.processing')}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
