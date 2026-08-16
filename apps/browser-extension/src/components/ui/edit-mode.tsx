import type React from 'react';
import { useState, useCallback } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';
import { Input } from './input';

interface EditModeProps {
  initialValue: string;
  onSave: (newValue: string) => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

/**
 * Reusable inline rename component.
 * Used for renaming bookmarks and folders.
 */
const EditMode: React.FC<EditModeProps> = ({
  initialValue,
  onSave,
  onCancel,
  placeholder,
  className = '',
  autoFocus = true,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);

  const handleSave = useCallback(() => {
    const trimmedValue = value.trim();
    if (trimmedValue && trimmedValue !== initialValue) {
      onSave(trimmedValue);
    } else {
      onCancel();
    }
  }, [value, initialValue, onSave, onCancel]);

  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        onCancel();
      }
    },
    [handleSave, onCancel]
  );

  return (
    <div
      className={`flex items-center gap-1 bg-white rounded px-2 py-1 border border-gray-300 ${className}`}>
      <Input
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyPress}
        onBlur={handleSave}
        placeholder={placeholder ?? t('browser.newTab.renamePlaceholder')}
        className='h-8 text-sm border-0 p-0 focus:ring-1 focus:ring-blue-500 bg-white text-gray-900 font-medium flex-1'
        autoFocus={autoFocus}
      />
      <Button
        size='sm'
        variant='ghost'
        className='h-6 w-6 p-0 hover:bg-green-100 hover:text-green-600'
        onClick={handleSave}
        title={t('browser.common.save')}>
        <Check className='h-3 w-3' />
      </Button>
      <Button
        size='sm'
        variant='ghost'
        className='h-6 w-6 p-0 hover:bg-red-100 hover:text-red-600'
        onClick={onCancel}
        title={t('browser.common.cancel')}>
        <X className='h-3 w-3' />
      </Button>
    </div>
  );
};

export default EditMode;
