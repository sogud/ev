import type React from 'react';
import { Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';

interface DeleteConfirmationProps {
  title: string;
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'bookmark' | 'folder';
  className?: string;
}

/** Reusable delete confirmation for bookmarks and folders. */
const DeleteConfirmation: React.FC<DeleteConfirmationProps> = ({
  itemName,
  onConfirm,
  onCancel,
  type = 'bookmark',
  className = '',
}) => {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className='flex-1 min-w-0 text-center'>
        <p className='text-sm text-destructive font-medium'>
          {type === 'bookmark'
            ? t('browser.newTab.deleteBookmark')
            : t('browser.newTab.deleteFolder')}
        </p>
        <p className='text-xs text-muted-foreground truncate'>"{itemName}"</p>
      </div>
      <div className='flex gap-1 ml-2'>
        <Button size='sm' variant='destructive' className='h-6 px-2' onClick={onConfirm}>
          <Trash2 className='h-3 w-3' />
        </Button>
        <Button size='sm' variant='outline' className='h-6 px-2' onClick={onCancel}>
          <X className='h-3 w-3' />
        </Button>
      </div>
    </div>
  );
};

export default DeleteConfirmation;
