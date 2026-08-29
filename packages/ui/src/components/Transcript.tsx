import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from '../shared/types';
import { buildTranscriptView, type ChangedFileView, type TurnView } from '../transcript-view-model';
import { PixelLoader, ThinkingBlock } from './ui/AgentState';

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
      {/* Codex-style header: chevron + title on one full-width toggle row; View diff stays. */}
      <div className='cf-head'>
        <button
          type='button'
          className='cf-toggle'
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(value => !value)}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className='cf-title'>CHANGED FILES ({files.length})</span>
        </button>
        <span className='cf-actions'>
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

/** Raw markdown of a finished assistant turn, for the hover copy button. */
function turnMarkdown(turn: TurnView): string {
  return turn.doc.map(block => block.text).join('\n\n');
}

/** Hover copy affordance on completed turns; copies the raw markdown source. */
function CopyTurnButton({ turn }: { turn: TurnView }): React.JSX.Element | null {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (turn.running || turn.doc.length === 0) return null;
  const text = turnMarkdown(turn);
  return (
    <button
      type='button'
      className='turn-copy'
      aria-label={t('transcript.copyTurn')}
      title={t('transcript.copyTurn')}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setCopied(false));
      }}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

const SCROLL_FOLLOW_THRESHOLD_PX = 80;

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

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(cell => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return line.includes('|') && cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function MarkdownText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): React.JSX.Element {
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
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      nodes.push(
        <div className='doc-table-wrap' key={`table-${index}`}>
          <table className='doc-table'>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{renderInline(row[cellIndex] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
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
  if (streaming && nodes.length > 0) {
    const last = nodes.pop();
    nodes.push(
      <div className='stream-line' key='stream-line'>
        {last}
        <span className='stream-caret' aria-hidden='true' />
      </div>
    );
  }
  return <div className={streaming ? 'doc-md streaming' : 'doc-md'}>{nodes}</div>;
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
  // Smart follow: stick to bottom only while the user is already near it;
  // scrolling up pauses follow and reveals a jump-to-latest button.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ behavior: running ? 'auto' : 'smooth' });
  }, [view, follow, running]);
  const atBottom = follow ? '' : ' show';

  return (
    <div
      className='transcript-c'
      ref={scrollRef}
      onScroll={event => {
        const el = event.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_FOLLOW_THRESHOLD_PX);
      }}>
      <div className='doc-column'>
        {view.turns.map(turn => (
          <section className='turn' key={turn.id}>
            <CopyTurnButton turn={turn} />
            {turn.userText !== null && <blockquote className='user-q'>{turn.userText}</blockquote>}
            {turn.doc.map((block, index) =>
              block.tone === 'error' ? (
                <p className='doc-error' key={block.id}>
                  {block.text}
                </p>
              ) : (
                <MarkdownText
                  key={block.id}
                  text={block.text}
                  streaming={turn.running && index === turn.doc.length - 1}
                />
              )
            )}
            {turn.running
              ? turn.changedFiles.length > 0 && (
                  <ThinkingBlock
                    activeLabel={t('transcript.thinkingActive')}
                    doneLabel={t('transcript.thinkingDone', { count: turn.changedFiles.length })}
                    running={true}
                    rows={turn.changedFiles.map(file => ({
                      primary: file.tool,
                      secondary: file.path.split('/').pop() ?? file.path,
                    }))}
                  />
                )
              : turn.changedFiles.length > 0 && (
                  <ChangedFilesCard files={turn.changedFiles} onViewDiff={onViewDiff} />
                )}
            <footer className='turn-footer'>
              {formatClock(turn.endedAt)} · {formatDuration(turn)}
              {turn.running ? ` · ${t('transcript.running')}` : ''}
            </footer>
          </section>
        ))}
        {running && (
          <PixelLoader
            label={t('transcript.processing')}
            startedAt={view.turns.find(turn => turn.running)?.startedAt}
          />
        )}
        <div ref={endRef} />
        <button
          type='button'
          className={`jump-bottom${atBottom}`}
          aria-label={t('transcript.jumpToLatest')}
          hidden={follow}
          onClick={() => {
            setFollow(true);
            endRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}>
          <ChevronDown size={15} />
        </button>
      </div>
    </div>
  );
}
