import { Popover } from '@base-ui/react/popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useDialogPortalContainer } from './portal-container';
import type { ProviderSummary } from '../../../../shared/types';

export interface ModelPickerItem {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  available: boolean;
}

export interface ModelPickerGroup {
  id: string;
  name: string;
  models: ModelPickerItem[];
}

export function filterModelPickerItem(
  value: string,
  search: string,
  keywords: string[] = []
): number {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return 1;
  const searchable = [value, ...keywords].join(' ').toLocaleLowerCase();
  return searchable.includes(query) ? 1 : 0;
}

export function buildModelPickerGroups(
  providers: ProviderSummary[],
  selectedValue: string
): ModelPickerGroup[] {
  return providers.flatMap(provider => {
    const models = provider.models
      .filter(model => model.available || `${provider.id}/${model.id}` === selectedValue)
      .map(model => ({
        id: model.id,
        name: model.name,
        providerId: provider.id,
        providerName: provider.name,
        available: model.available,
      }));

    return models.length > 0 ? [{ id: provider.id, name: provider.name, models }] : [];
  });
}

interface ModelPickerProps {
  providers: ProviderSummary[];
  value: string;
  className?: string;
  allowAutomatic?: boolean;
  onValueChange(provider: string, model: string): void;
  onAutomatic?: () => void;
}

export function ModelPicker({
  providers,
  value,
  className = '',
  allowAutomatic = false,
  onValueChange,
  onAutomatic,
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalContainer = useDialogPortalContainer(triggerRef);
  const groups = useMemo(() => buildModelPickerGroups(providers, value), [providers, value]);
  const models = groups.flatMap(group => group.models);
  const selected = models.find(model => `${model.providerId}/${model.id}` === value);
  const fallbackModelId = value.slice(value.indexOf('/') + 1);
  const triggerName = selected?.name ?? (value ? fallbackModelId : '选择模型');
  const triggerProvider = selected?.providerName ?? (value ? value.split('/')[0] : null);
  const hasChoices = allowAutomatic || models.some(model => model.available);

  const selectModel = (model: ModelPickerItem): void => {
    onValueChange(model.providerId, model.id);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={triggerRef}
        className={`ui-picker-trigger model-picker-trigger ${className}`.trim()}
        aria-label='选择模型'
        disabled={!hasChoices}
        title={selected && !selected.available ? `${triggerName} 当前不可用` : undefined}>
        <span className='model-picker-current'>
          <span>{hasChoices || value ? triggerName : '没有可用模型'}</span>
          {triggerProvider && <small>{triggerProvider}</small>}
        </span>
        {selected && !selected.available && (
          <span className='model-picker-unavailable'>不可用</span>
        )}
        <ChevronDown className='ui-picker-chevron' size={13} aria-hidden='true' />
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Positioner align='end' sideOffset={6}>
          <Popover.Popup className='ui-popover-content model-picker-popover'>
            <Command
              label='选择模型'
              loop
              defaultValue={value || (allowAutomatic ? 'automatic default model' : undefined)}
              filter={filterModelPickerItem}>
              <div className='model-picker-search'>
                <Search size={14} aria-hidden='true' />
                <Command.Input aria-label='搜索模型' placeholder='搜索模型或 Provider' autoFocus />
              </div>
              <Command.List>
                <Command.Empty>没有匹配的可用模型</Command.Empty>
                {allowAutomatic && (
                  <Command.Group heading='默认行为'>
                    <Command.Item
                      value='automatic default model'
                      onSelect={() => {
                        onAutomatic?.();
                        setOpen(false);
                      }}>
                      <span className='ui-menu-indicator' aria-hidden='true'>
                        {!value && <Check size={14} strokeWidth={2.2} />}
                      </span>
                      <span className='model-picker-item-copy'>
                        <span>自动选择</span>
                        <small>使用第一个可用模型</small>
                      </span>
                    </Command.Item>
                  </Command.Group>
                )}
                {groups.map(group => (
                  <Command.Group heading={group.name} key={group.id}>
                    {group.models.map(model => {
                      const modelValue = `${model.providerId}/${model.id}`;
                      return (
                        <Command.Item
                          value={modelValue}
                          keywords={[model.name, model.providerName, model.id]}
                          disabled={!model.available}
                          onSelect={() => selectModel(model)}
                          key={modelValue}>
                          <span className='ui-menu-indicator' aria-hidden='true'>
                            {modelValue === value && <Check size={14} strokeWidth={2.2} />}
                          </span>
                          <span className='model-picker-item-copy'>
                            <span>{model.name}</span>
                            <small>{model.id}</small>
                          </span>
                          {!model.available && <em>不可用</em>}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
