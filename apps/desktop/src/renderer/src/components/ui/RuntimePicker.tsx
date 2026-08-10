import { i18n } from '../../i18n';
import type { RuntimeDescriptor, RuntimeId } from '../../../../shared/types';
import { MenuPicker } from './MenuPicker';
import { runtimeMonogram } from './runtimeMeta';

/**
 * Runtime picker: the single switch under the composer.
 * Runtimes without an installed CLI are disabled in the menu; the post-first-message
 * locked state is rendered by the caller as a static chip.
 */
export function RuntimePicker({
  runtimes,
  value,
  onValueChange,
  className = '',
  testId,
}: {
  runtimes: RuntimeDescriptor[];
  value: RuntimeId;
  onValueChange(value: RuntimeId): void;
  testId?: string;
  className?: string;
}): React.JSX.Element {
  const selected = runtimes.find(runtime => runtime.id === value);
  const options = runtimes.map(runtime => ({
    value: runtime.id,
    label: runtime.name,
    description:
      runtime.availability === 'available'
        ? runtime.version
        : runtime.availability === 'missing'
          ? i18n.t('runtime.cliMissing')
          : i18n.t('runtime.versionUnsupported'),
    disabled: runtime.availability !== 'available',
  }));
  return (
    <MenuPicker
      className={className}
      testId={testId}
      value={value}
      options={options}
      ariaLabel={i18n.t('runtime.pickerAria')}
      triggerLabel={selected?.name ?? value}
      leadingIcon={
        <span className='runtime-glyph' aria-hidden='true'>
          {selected?.glyph ?? runtimeMonogram(value)}
        </span>
      }
      align='start'
      onValueChange={onValueChange}
    />
  );
}
