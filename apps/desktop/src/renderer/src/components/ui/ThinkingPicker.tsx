import { Popover } from '@base-ui/react/popover';
import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { useDialogPortalContainer } from './portal-container';
import type { ThinkingLevel } from '../../../../shared/types';

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: '不思考' },
  { value: 'minimal', label: '最少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
];

function thinkingLevelLabel(value: ThinkingLevel): string {
  return THINKING_LEVELS.find(option => option.value === value)?.label ?? value;
}

/**
 * 离散阶梯滑块（思考强度）。用户定案：思考强度用滑块，不用菜单。
 * 键盘可达：方向键/Home/End；每个 stop 也可点击。
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
      aria-label='思考强度'
      aria-valuemin={1}
      aria-valuemax={THINKING_LEVELS.length}
      aria-valuenow={index + 1}
      aria-valuetext={`${thinkingLevelLabel(value)}，第 ${index + 1} 项，共 ${THINKING_LEVELS.length} 项`}
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
          aria-label={option.label}
          className={`stop ${stop <= index ? 'on' : ''}`}
          style={{ left: pos(stop / last) }}
          onClick={() => onValueChange(option.value)}
        />
      ))}
      <span className='thumb' style={{ left: pct }} aria-hidden='true' />
    </div>
  );
}

/** 思考强度入口：trigger 显示当前档位，弹层内是离散阶梯滑块。 */
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
        aria-label='思考强度'>
        <span>思考：{thinkingLevelLabel(value)}</span>
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
