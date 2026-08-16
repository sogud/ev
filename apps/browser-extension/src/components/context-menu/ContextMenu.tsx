import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Edit, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

// Shared portal container so the menu always renders on top.
let portalContainer: HTMLDivElement | null = null;

if (typeof document !== 'undefined') {
  portalContainer = document.getElementById('context-menu-portal') as HTMLDivElement;
  if (!portalContainer) {
    portalContainer = document.createElement('div');
    portalContainer.id = 'context-menu-portal';
    portalContainer.style.position = 'fixed';
    portalContainer.style.zIndex = '9999';
    portalContainer.style.top = '0';
    portalContainer.style.left = '0';
    document.body.appendChild(portalContainer);
  }
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, isOpen, onClose, onEdit, onDelete }) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  // Track position changes.
  useEffect(() => {
    if (isOpen) {
      setPosition({ x, y });
    }
  }, [x, y, isOpen]);

  // Keep the menu inside the viewport.
  useEffect(() => {
    if (menuRef.current && isOpen) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newX = position.x;
      let newY = position.y;

      // Right edge.
      if (rect.right > viewportWidth) {
        newX = viewportWidth - rect.width;
      }

      // Bottom edge.
      if (rect.bottom > viewportHeight) {
        newY = viewportHeight - rect.height;
      }

      if (newX !== position.x || newY !== position.y) {
        setPosition({ x: newX, y: newY });
      }
    }
  }, [isOpen, position]);

  // Close on outside click.
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Ignore clicks that originate inside the menu.
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Close on ESC.
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      // Attach listeners on the next frame via requestAnimationFrame,
      // so they cannot catch the event that opened the menu.
      requestAnimationFrame(() => {
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
      });
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Menu item click handling.
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  // Render nothing while closed.
  if (!isOpen || !portalContainer) return null;

  // Portal to the outermost body layer so page z-index stacks cannot cover the menu.
  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className='fixed bg-white border border-gray-200 rounded-lg shadow-lg py-2 min-w-[140px] z-50'
      style={{ top: position.y, left: position.x }}
      onClick={e => e.stopPropagation()}>
      <ul className='space-y-1'>
        <li
          className='px-4 py-2 text-sm cursor-pointer hover:bg-gray-100 text-gray-700 transition-colors rounded-lg mx-1 flex items-center space-x-2'
          onClick={handleEditClick}>
          <Edit className='h-4 w-4' />
          <span>{t('browser.newTab.edit')}</span>
        </li>
        <li
          className='px-4 py-2 text-sm cursor-pointer hover:bg-red-50 hover:text-red-600 text-gray-700 transition-colors rounded-lg mx-1 flex items-center space-x-2'
          onClick={handleDeleteClick}>
          <Trash2 className='h-4 w-4' />
          <span>{t('browser.newTab.delete')}</span>
        </li>
      </ul>
    </div>,
    portalContainer
  );
};

export default ContextMenu;
