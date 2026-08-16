import { i18n } from '../../i18n';
import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { useDialogPortalContainer } from './portal-container';

export interface MenuPickerOption<Value extends string> {
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface MenuPickerProps<Value extends string> {
  value: Value;
  options: Array<MenuPickerOption<Value>>;
  ariaLabel: string;
  triggerLabel?: string;
  leadingIcon?: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  onValueChange(value: Value): void;
  testId?: string;
}

export function MenuPicker<Value extends string>({
  value,
  options,
  ariaLabel,
  triggerLabel,
  leadingIcon,
  className = '',
  align = 'end',
  onValueChange,
  testId,
}: MenuPickerProps<Value>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalContainer = useDialogPortalContainer(triggerRef);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        ref={triggerRef}
        className={`ui-picker-trigger ${className}`.trim()}
        data-testid={testId}
        aria-label={ariaLabel}>
        {leadingIcon && <span className='ui-picker-icon'>{leadingIcon}</span>}
        <span className='ui-picker-value'>
          {triggerLabel ?? selected?.label ?? i18n.t('common.select')}
        </span>
        <ChevronDown className='ui-picker-chevron' size={13} aria-hidden='true' />
      </Menu.Trigger>
      <Menu.Portal container={portalContainer ?? undefined}>
        <Menu.Positioner align={align} sideOffset={6}>
          <Menu.Popup className='ui-menu-content'>
            {options.map(option => (
              <Menu.Item
                className='ui-menu-item'
                disabled={option.disabled}
                key={option.value}
                onClick={() => onValueChange(option.value)}>
                <span className='ui-menu-indicator' aria-hidden='true'>
                  {option.value === value && <Check size={14} strokeWidth={2.2} />}
                </span>
                <span className='ui-menu-copy'>
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
