import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Folder as FolderIcon } from 'lucide-react';
import { BookmarkFolder, BookmarkHandler, FolderHandler, FolderItemProps } from '../../types';
import { cn } from '../../lib/utils';
import EditMode from '../ui/edit-mode';
import DeleteConfirmation from '../ui/delete-confirmation';

interface FolderProps extends FolderItemProps {
  onFolderClick?: (folder: BookmarkFolder) => void;
  onUpdateFolder?: BookmarkHandler;
  onDeleteFolder?: FolderHandler;
  onContextMenu?: (event: React.MouseEvent, item: BookmarkFolder) => void;
  isSelected?: boolean;
}

type FolderMode = 'normal' | 'editing' | 'confirming-delete';

const Folder: React.FC<FolderProps> = React.memo(
  ({
    folder,
    onFolderClick,
    onUpdateFolder,
    onDeleteFolder,
    onContextMenu,
    isSelected = false,
  }) => {
    const [mode, setMode] = useState<FolderMode>('normal');
    const cardRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
      if (isSelected) {
        cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, [isSelected]);

    const handleEditSave = useCallback(
      (newTitle: string) => {
        if (newTitle && newTitle !== folder.title) {
          onUpdateFolder?.(folder.id, newTitle);
        }
        setMode('normal');
      },
      [folder.title, folder.id, onUpdateFolder]
    );

    const handleDeleteConfirm = useCallback(() => {
      onDeleteFolder?.(folder.id);
    }, [folder.id, onDeleteFolder]);

    if (mode === 'editing') {
      return (
        <div className='folder-card-modern'>
          <div className='icon-container-modern'>
            <FolderIcon className='folder-icon-modern' />
          </div>
          <div className='bookmark-editor'>
            <EditMode
              initialValue={folder.title}
              onSave={handleEditSave}
              onCancel={() => setMode('normal')}
              placeholder='输入文件夹名称...'
            />
          </div>
        </div>
      );
    }

    if (mode === 'confirming-delete') {
      return (
        <div className='folder-card-modern is-destructive'>
          <div className='icon-container-modern'>
            <FolderIcon className='folder-icon-modern' />
          </div>
          <div className='bookmark-editor'>
            <DeleteConfirmation
              title=''
              itemName={folder.title}
              onConfirm={handleDeleteConfirm}
              onCancel={() => setMode('normal')}
              type='folder'
            />
          </div>
        </div>
      );
    }

    const itemCount = folder.children?.length ?? 0;

    return (
      <button
        ref={cardRef}
        type='button'
        className={cn('folder-card-modern', isSelected && 'card-selected')}
        onClick={event => {
          if (event.button === 0) {
            onFolderClick?.(folder);
          }
        }}
        onDoubleClick={event => {
          event.preventDefault();
          event.stopPropagation();
          setMode('editing');
        }}
        onContextMenu={event => onContextMenu?.(event, folder)}
        aria-label={`打开文件夹: ${folder.title}，包含 ${itemCount} 个项目`}>
        <div className='icon-container-modern'>
          <FolderIcon className='folder-icon-modern' />
        </div>
        <div className='bookmark-item-copy'>
          <span className='card-title-modern' title={folder.title}>
            {folder.title}
          </span>
          <small>{itemCount === 0 ? '空文件夹' : `${itemCount} 个项目`}</small>
        </div>
      </button>
    );
  }
);

Folder.displayName = 'Folder';

export default Folder;
