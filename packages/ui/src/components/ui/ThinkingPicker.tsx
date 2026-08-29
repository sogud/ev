import { i18n } from '../../i18n';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { useDialogPortalContainer } from './portal-container';
import type { ThinkingLevel } from '../../shared/types';

// Ordered low→high; descriptions resolve at render time so a runtime language
// switch re-renders correctly. Slider interaction mirrors the Codex app's
// model-picker power slider: draggable thumb, snapping ticks, endpoint labels.
const THINKING_LEVELS: Array<{ value: ThinkingLevel; key: string }> = [
  { value: 'off', key: 'thinking.off' },
  { value: 'minimal', key: 'thinking.minimal' },
  { value: 'low', key: 'thinking.low' },
  { value: 'medium', key: 'thinking.medium' },
  { value: 'high', key: 'thinking.high' },
  { value: 'xhigh', key: 'thinking.xhigh' },
  { value: 'max', key: 'thinking.max' },
];

function thinkingLevelLabel(value: ThinkingLevel): string {
  const key = THINKING_LEVELS.find(option => option.value === value)?.key;
  return key ? i18n.t(key) : value;
}

/** Thumb inset so the thumb center lands on each stop without clipping at the edges. */
const EDGE_INSET_PX = 14;

/**
 * Discrete stepped slider, Codex-app style: pointer-draggable thumb that snaps
 * to ticks, plus arrows/Home/End keyboard control. Every stop stays clickable.
 */
function EffortSlider({
  value,
  onValueChange,
}: {
  value: ThinkingLevel;
  onValueChange(value: ThinkingLevel): void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const index = Math.max(
    0,
    THINKING_LEVELS.findIndex(option => option.value === value)
  );
  const last = THINKING_LEVELS.length - 1;

  const moveToClientX = (clientX: number): void => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - rect.left - EDGE_INSET_PX) / (rect.width - 2 * EDGE_INSET_PX))
    );
    const next = Math.round(ratio * last);
    if (next !== index) onValueChange(THINKING_LEVELS[next].value);
  };

  const move = (next: number): void => {
    const clamped = Math.min(last, Math.max(0, next));
    if (clamped !== index) onValueChange(THINKING_LEVELS[clamped].value);
  };

  // Thumb center position: inset px from each edge, ratio in between. calc() keeps
  // the px inset honest at any popover width (percent-only math overshoots).
  const stopOffset = (ratio: number): string =>
    `calc(${EDGE_INSET_PX}px + ${ratio} * (100% - ${2 * EDGE_INSET_PX}px))`;
  const pos = stopOffset(index / last);

  return (
    <div className='effort-slider-wrap'>
      <div
        ref={rootRef}
        className='effort-slider'
        role='slider'
        data-dragging={dragging || undefined}
        data-max={value === 'max' || undefined}
        tabIndex={0}
        aria-label={i18n.t('thinking.aria')}
        aria-valuemin={1}
        aria-valuemax={THINKING_LEVELS.length}
        aria-valuenow={index + 1}
        aria-valuetext={i18n.t('thinking.valueText', {
          label: thinkingLevelLabel(value),
          index: index + 1,
          count: THINKING_LEVELS.length,
        })}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            move(index - 1);
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(index + 1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            move(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            move(last);
          }
        }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          moveToClientX(event.clientX);
        }}
        onPointerMove={event => {
          if (!dragging) return;
          moveToClientX(event.clientX);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}>
        <span className='track' aria-hidden='true' />
        <span className='fill' style={{ width: pos }} aria-hidden='true' />
        {THINKING_LEVELS.map((option, stop) => (
          <button
            key={option.value}
            type='button'
            tabIndex={-1}
            aria-label={i18n.t(option.key)}
            data-selected={stop === index || undefined}
            className='stop'
            style={{ left: stopOffset(stop / last) }}
            onClick={() => onValueChange(option.value)}
          />
        ))}
        <span className='thumb' style={{ left: pos }} aria-hidden='true' />
      </div>
      <div className='effort-endpoints' aria-hidden='true'>
        <span>{i18n.t('thinking.endpointFast')}</span>
        <span>{i18n.t('thinking.endpointDeep')}</span>
      </div>
      {value === 'xhigh' || value === 'max' ? (
        <p className='effort-cost-warning'>{i18n.t('thinking.costWarning')}</p>
      ) : (
        <p className='effort-desc'>{i18n.t(`thinking.desc.${value}`)}</p>
      )}
    </div>
  );
}

/** Thinking effort entry point: trigger shows the current step; popup hosts the stepped slider. */
export function ThinkingPicker({
  value,
  className = '',
  onValueChange,
}: {
  value: ThinkingLevel;
  className?: string;
  onValueChange(value: ThinkingLevel): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalContainer = useDialogPortalContainer(triggerRef);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={triggerRef}
        className={`ui-picker-trigger thinking-picker-trigger ${className}`.trim()}
        data-testid='picker-thinking'
        data-high={value === 'xhigh' || value === 'max' || undefined}
        title={i18n.t('thinking.aria')}
        aria-label={`${i18n.t('thinking.aria')}: ${thinkingLevelLabel(value)}`}>
        <span>{thinkingLevelLabel(value)}</span>
        <ChevronDown className='ui-picker-chevron' size={13} aria-hidden='true' />
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Positioner align='start' sideOffset={6}>
          <Popover.Popup className='ui-popover-content thinking-picker-popover'>
            <EffortSlider value={value} onValueChange={onValueChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
