import { Collapsible } from '@base-ui/react/collapsible';
import { useEffect, useState } from 'react';

/**
 * Agent activity indicators, adapted from beautifului.dev (MIT) into EV tokens:
 * PixelLoader = pixel-grid shimmer loader with an elapsed-time counter;
 * ThinkingBlock = collapsible live trace of an in-flight turn (Base UI Collapsible).
 */

const PIXEL_DELAYS = [90, 180, 270, 0, 90, 180, 90, 180, 270];

export function PixelLoader({
  label,
  startedAt,
}: {
  label: string;
  startedAt?: number;
}): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <div className='ev-loader'>
      <span aria-hidden='true' className='ev-loader-grid'>
        {PIXEL_DELAYS.map((delay, index) => (
          <span key={index} className='ev-loader-pixel' style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span className='ev-shimmer-text'>{label}</span>
      {startedAt !== undefined && <span className='ev-loader-time'>{elapsed.toFixed(1)}s</span>}
    </div>
  );
}

export interface ThinkingRow {
  primary: string;
  secondary?: string;
}

export function ThinkingBlock({
  activeLabel,
  doneLabel,
  rows,
  running,
  defaultOpen = true,
}: {
  activeLabel: string;
  doneLabel: string;
  rows: ThinkingRow[];
  running: boolean;
  defaultOpen?: boolean;
}): React.JSX.Element {
  return (
    <Collapsible.Root className='ev-think' defaultOpen={defaultOpen}>
      <Collapsible.Trigger className='ev-think-trigger' type='button'>
        <svg
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill={running ? 'var(--ev-color-text-secondary)' : 'var(--ev-color-text-tertiary)'}
          aria-hidden='true'>
          <path d='M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z' />
        </svg>
        {running ? (
          <span className='ev-shimmer-text'>{activeLabel}</span>
        ) : (
          <span className='ev-think-done'>{doneLabel}</span>
        )}
        <svg
          className='ev-think-chevron'
          width='13'
          height='13'
          viewBox='0 0 24 24'
          fill='none'
          stroke='var(--ev-color-text-tertiary)'
          strokeWidth='2.2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'>
          <path d='M6 9l6 6 6-6' />
        </svg>
      </Collapsible.Trigger>
      <Collapsible.Panel className='ev-think-panel'>
        <div className='ev-think-rows'>
          <span aria-hidden='true' className='ev-think-rail' />
          {rows.map((row, index) => {
            const isCurrent = running && index === rows.length - 1;
            return (
              <div
                className='ev-think-row'
                key={`${row.primary}-${row.secondary ?? index}`}
                style={{ animationDelay: `${index * 120}ms` }}>
                {isCurrent ? (
                  <span className='ev-think-spinner' aria-hidden='true' />
                ) : (
                  <svg
                    className='ev-think-check'
                    width='13'
                    height='13'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    aria-hidden='true'>
                    <path d='M20 6L9 17l-5-5' />
                  </svg>
                )}
                <span className='ev-think-primary'>{row.primary}</span>
                {row.secondary && <span className='ev-think-secondary'>{row.secondary}</span>}
              </div>
            );
          })}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
