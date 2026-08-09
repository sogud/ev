import type { RuntimeDescriptor, RuntimeId } from '../../../../shared/types';

/** Runtime monogram 字符，descriptor 未提供 glyph 时的兜底。 */
export function runtimeMonogram(id: RuntimeId): string {
  switch (id) {
    case 'pi':
      return 'π';
    case 'codex':
      return 'Cx';
    case 'claude-code':
      return 'Cl';
    case 'qoder':
      return 'Qd';
  }
}

export function runtimeAvailabilityTone(
  availability: RuntimeDescriptor['availability']
): 'ok' | 'warn' | 'err' {
  if (availability === 'available') return 'ok';
  if (availability === 'missing') return 'err';
  return 'warn';
}
