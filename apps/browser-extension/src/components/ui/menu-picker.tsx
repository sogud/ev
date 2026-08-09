import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';

export interface MenuPickerOption<Value extends string> {
  value: Value;
  label: string;
}

export function MenuPicker<Value extends string>({
  value,
  options,
  ariaLabel,
  onValueChange,
}: {
  value: Value;
  options: Array<MenuPickerOption<Value>>;
  ariaLabel: string;
  onValueChange(value: Value): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className='ev-menu-trigger' aria-label={ariaLabel}>
        <span>{selected?.label ?? 'Select'}</span>
        <ChevronDown size={12} aria-hidden='true' />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align='start' sideOffset={5}>
          <Menu.Popup className='ev-menu-content'>
            {options.map(option => (
              <Menu.Item
                className='ev-menu-item'
                key={option.value}
                onClick={() => onValueChange(option.value)}>
                <span className='ev-menu-check' aria-hidden='true'>
                  {option.value === value && <Check size={13} strokeWidth={2.2} />}
                </span>
                {option.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
