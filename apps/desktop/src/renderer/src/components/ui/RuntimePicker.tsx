import type { RuntimeDescriptor, RuntimeId } from '../../../../shared/types';
import { MenuPicker } from './MenuPicker';
import { runtimeMonogram } from './runtimeMeta';

/**
 * Runtime 选择器：composer 下方唯一切换入口。
 * 未安装 CLI 的 runtime 在菜单内 disabled；首消息后的锁定态由调用方渲染静态 chip。
 */
export function RuntimePicker({
  runtimes,
  value,
  onValueChange,
  className = '',
}: {
  runtimes: RuntimeDescriptor[];
  value: RuntimeId;
  onValueChange(value: RuntimeId): void;
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
          ? 'CLI 未安装'
          : '当前版本不支持',
    disabled: runtime.availability !== 'available',
  }));
  return (
    <MenuPicker
      className={className}
      value={value}
      options={options}
      ariaLabel='选择 Runtime'
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
