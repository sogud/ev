import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Edit, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

// 创建一个全局 portal 容器，确保菜单总是在最上层显示
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  // 当 x 和 y 改变时更新位置
  useEffect(() => {
    if (isOpen) {
      setPosition({ x, y });
    }
  }, [x, y, isOpen]);

  // 确保菜单在视口内
  useEffect(() => {
    if (menuRef.current && isOpen) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newX = position.x;
      let newY = position.y;

      // 检查右边界
      if (rect.right > viewportWidth) {
        newX = viewportWidth - rect.width;
      }

      // 检查下边界
      if (rect.bottom > viewportHeight) {
        newY = viewportHeight - rect.height;
      }

      if (newX !== position.x || newY !== position.y) {
        setPosition({ x: newX, y: newY });
      }
    }
  }, [isOpen, position]);

  // 处理点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // 确保点击事件不是来自菜单本身
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // 按 ESC 键关闭菜单
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      // 使用 requestAnimationFrame 确保在下一帧添加事件监听器
      // 这样可以避免与触发菜单打开的事件冲突
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

  // 处理菜单项点击事件
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  // 如果菜单未打开，不渲染任何内容
  if (!isOpen || !portalContainer) return null;

  // 使用 Portal 将菜单渲染到 body 的最外层，避免被其他元素的 z-index 影响
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
          <span>编辑</span>
        </li>
        <li
          className='px-4 py-2 text-sm cursor-pointer hover:bg-red-50 hover:text-red-600 text-gray-700 transition-colors rounded-lg mx-1 flex items-center space-x-2'
          onClick={handleDeleteClick}>
          <Trash2 className='h-4 w-4' />
          <span>删除</span>
        </li>
      </ul>
    </div>,
    portalContainer
  );
};

export default ContextMenu;
