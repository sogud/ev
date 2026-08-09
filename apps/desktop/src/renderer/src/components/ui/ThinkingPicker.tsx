import { i18n } from '../../i18n';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { useDialogPortalContainer } from './portal-container';
import type { ThinkingLevel } from '../../../../shared/types';

// Labels resolve at render time so a runtime language switch re-renders correctly.
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

/**
 * Discrete stepped slider for thinking effort (settled decision: slider, not a menu).
 * Keyboard reachable: arrows/Home/End; every stop is clickable.
 */
function EffortSlider({
  value,
  onValueChange,
}: {
  value: ThinkingLevel;
  onValueChange(value: ThinkingLevel): void;
}): React.JSX.Element {
  const index = Math.max(
    0,
    THINKING_LEVELS.findIndex(option => option.value === value)
  );
  const last = THINKING_LEVELS.length - 1;
  const pos = (ratio: number): string => `${4 + ratio * 92}%`;
  const pct = pos(index / last);

  const move = (next: number): void => {
    const clamped = Math.min(last, Math.max(0, next));
    if (clamped !== index) onValueChange(THINKING_LEVELS[clamped].value);
  };

  return (
    <div
      className='effort-slider'
      role='slider'
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
      }}>
      <span className='track' aria-hidden='true' />
      <span className='fill' style={{ width: pct }} aria-hidden='true' />
      {THINKING_LEVELS.map((option, stop) => (
        <button
          key={option.value}
          type='button'
          tabIndex={-1}
          aria-label={i18n.t(option.key)}
          className={`stop ${stop <= index ? 'on' : ''}`}
          style={{ left: pos(stop / last) }}
          onClick={() => onValueChange(option.value)}
        />
      ))}
      <span className='thumb' style={{ left: pct }} aria-hidden='true' />
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
        aria-label={i18n.t('thinking.aria')}>
        <span>{i18n.t('thinking.trigger', { label: thinkingLevelLabel(value) })}</span>
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
