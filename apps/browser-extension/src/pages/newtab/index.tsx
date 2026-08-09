import React, { useEffect, useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import {
  ArrowLeft,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Plus,
  Search,
  Undo2,
} from 'lucide-react';
import '../../globals.css';

import Folder from '../../components/folder/Folder';
import Link from '../../components/link/Link';
import SearchBar, { SearchBarRef } from '../../components/search-bar/SearchBar';
import ErrorMessage from '../../components/ui/error-message';
import { Button } from '../../components/ui/button';
import ContextMenu from '../../components/context-menu/ContextMenu';
import FrequentSites from '../../components/frequent-sites/FrequentSites';
import { SettingsProvider, useSettings } from '../../contexts/SettingsContext';
import { applyCustomSettings, applySavedBackground } from '../../utils/apply-settings';

import { Bookmark, BookmarkFolder, ChromeBookmarkTreeNode, convertToBookmark } from '../../types';
import { preloadFavicons } from '../../utils/favicon';

// 统一状态管理接口
interface AppState {
  // 书签数据
  currentFolder: BookmarkFolder;
  // 完整书签树，用于全局搜索
  rootFolder: BookmarkFolder | null;
  folderHistory: BookmarkFolder[];
  searchResults: (Bookmark | BookmarkFolder)[];
  searchTerm: string;
  isLoading: boolean;
  error: string | null;
  // UI状态
  editModalOpen: boolean;
  editingItemId: string | null;
  // 右键菜单
  contextMenu: {
    isOpen: boolean;
    x: number;
    y: number;
    targetItem: Bookmark | BookmarkFolder | null;
    targetType: 'bookmark' | 'folder' | null;
  };
  // 选中项
  selectedItemId: string | null;
}

const EditModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (title: string) => void;
  title: string;
}> = ({ isOpen, onClose, onSave, title }) => {
  const [inputTitle, setInputTitle] = useState(title);

  // 弹窗每次打开或编辑对象切换时，同步最新的标题，避免显示上一次编辑的旧值
  useEffect(() => {
    if (isOpen) {
      setInputTitle(title);
    }
  }, [isOpen, title]);

  if (!isOpen) return null;

  return (
    <div className='ev-modal-backdrop'>
      <div className='ev-modal-content'>
        <h2>编辑书签</h2>
        <input
          type='text'
          value={inputTitle}
          onChange={e => setInputTitle(e.target.value)}
          className='ev-input mb-3'
        />
        <div className='flex gap-2 justify-end'>
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onSave(inputTitle)}>保存</Button>
        </div>
      </div>
    </div>
  );
};

// 新建书签/文件夹弹窗
const CreateModal: React.FC<{
  isOpen: boolean;
  type: 'bookmark' | 'folder';
  onClose: () => void;
  onCreate: (title: string, url?: string) => void;
}> = ({ isOpen, type, onClose, onCreate }) => {
  const [inputTitle, setInputTitle] = useState('');
  const [inputUrl, setInputUrl] = useState('');

  // 每次打开时重置表单
  useEffect(() => {
    if (isOpen) {
      setInputTitle('');
      setInputUrl('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const canSave = inputTitle.trim() !== '' && (type === 'folder' || inputUrl.trim() !== '');

  const handleSubmit = () => {
    if (!canSave) return;
    onCreate(inputTitle.trim(), type === 'bookmark' ? inputUrl.trim() : undefined);
  };

  return (
    <div className='ev-modal-backdrop'>
      <div className='ev-modal-content'>
        <h2>{type === 'bookmark' ? '新建书签' : '新建文件夹'}</h2>
        <input
          type='text'
          value={inputTitle}
          onChange={e => setInputTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          placeholder={type === 'bookmark' ? '输入书签名称...' : '输入文件夹名称...'}
          autoFocus
          className='ev-input mb-2'
        />
        {type === 'bookmark' && (
          <input
            type='text'
            value={inputUrl}
            onChange={e => setInputUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder='输入网址，如 example.com'
            className='ev-input mb-3'
          />
        )}
        <div className='flex gap-2 justify-end'>
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSave}>
            创建
          </Button>
        </div>
      </div>
    </div>
  );
};

// 删除撤销提示条
const UndoToast: React.FC<{
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}> = ({ message, onUndo, onDismiss }) => {
  return (
    <div className='ev-toast'>
      <span className='text-sm'>{message}</span>
      <button
        onClick={onUndo}
        className='flex items-center gap-1 text-xs font-medium text-[var(--ev-color-text-link)]'>
        <Undo2 className='h-4 w-4' />
        撤销
      </button>
      <button
        onClick={onDismiss}
        className='text-[var(--ev-color-icon-tertiary)] hover:text-[var(--ev-color-icon-primary)]'
        aria-label='关闭提示'>
        ✕
      </button>
    </div>
  );
};

// 递归恢复被删除的文件夹子树
const restoreFolderNode = (node: BookmarkFolder, parentId: string) => {
  chrome.bookmarks.create({ parentId, title: node.title, index: node.index }, created => {
    if (chrome.runtime.lastError || !created) {
      console.error('Failed to restore folder:', chrome.runtime.lastError);
      return;
    }
    node.children.forEach(child => {
      if ('url' in child) {
        chrome.bookmarks.create(
          { parentId: created.id, title: child.title, url: child.url },
          () => {
            if (chrome.runtime.lastError) {
              console.error('Failed to restore bookmark:', chrome.runtime.lastError);
            }
          }
        );
      } else {
        restoreFolderNode(child as BookmarkFolder, created.id);
      }
    });
  });
};

function NewtabContent() {
  const { settings } = useSettings();

  // Apply custom settings when they change
  useEffect(() => {
    applyCustomSettings(settings);
    void applySavedBackground(settings);
  }, [settings]);

  return (
    <>
      {/* Custom background container */}
      <div className='custom-background-container' />

      {/* Main content */}
      <NewtabApp />
    </>
  );
}

function NewtabApp() {
  // 统一状态管理
  const [state, setState] = useState<AppState>({
    currentFolder: {
      id: '',
      title: '',
      children: [],
      dateAdded: 0,
      dateGroupModified: 0,
      index: 0,
    },
    rootFolder: null,
    folderHistory: [],
    searchResults: [],
    searchTerm: '',
    isLoading: false,
    error: null,
    editModalOpen: false,
    editingItemId: null,
    contextMenu: {
      isOpen: false,
      x: 0,
      y: 0,
      targetItem: null,
      targetType: null,
    },
    selectedItemId: null,
  });

  // 用于跟踪最近删除的书签
  const recentlyDeletedRef = useRef<{ id: string; timestamp: number }[]>([]);

  // 搜索框引用，用于快捷键聚焦和清空
  const searchBarRef = useRef<SearchBarRef>(null);

  // 书签事件刷新的防抖定时器
  const reloadTimerRef = useRef<number | null>(null);

  // 新建弹窗状态
  const [createModal, setCreateModal] = useState<{ open: boolean; type: 'bookmark' | 'folder' }>({
    open: false,
    type: 'bookmark',
  });

  // 删除撤销状态
  const [undo, setUndo] = useState<{ message: string; restore: () => void } | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  const showUndo = useCallback((message: string, restore: () => void) => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
    }
    setUndo({ message, restore });
    undoTimerRef.current = window.setTimeout(() => setUndo(null), 6000);
  }, []);

  const dismissUndo = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndo(null);
  }, []);

  // 卸载时清理撤销定时器
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  // 状态更新函数
  const updateState = useCallback((updates: Partial<AppState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // 先定义这些函数，供 handleKeyDown 使用
  const handleFolderClick = useCallback((folder: BookmarkFolder) => {
    setState(prev => ({
      ...prev,
      folderHistory: [...prev.folderHistory, prev.currentFolder],
      currentFolder: folder,
      searchResults: [],
      searchTerm: '',
    }));
    searchBarRef.current?.clearSearch();
  }, []);

  const handleBack = useCallback(() => {
    setState(prev => {
      if (prev.folderHistory.length > 0) {
        const previousFolder = prev.folderHistory[prev.folderHistory.length - 1];
        return {
          ...prev,
          folderHistory: prev.folderHistory.slice(0, -1),
          currentFolder: previousFolder,
          searchResults: [],
          searchTerm: '',
        };
      }
      return prev;
    });
    searchBarRef.current?.clearSearch();
  }, []);

  const handleDeleteBookmark = useCallback(
    (id: string) => {
      // 记录删除来源，避免书签事件监听器重复处理
      recentlyDeletedRef.current.push({ id, timestamp: Date.now() });
      const now = Date.now();
      recentlyDeletedRef.current = recentlyDeletedRef.current.filter(
        item => now - item.timestamp < 5000
      );

      // 删除前先保存现场，供撤销时恢复
      const deletedItem = state.currentFolder.children.find(
        child => child.id === id && 'url' in child
      ) as Bookmark | undefined;
      const currentFolderId = state.currentFolder.id;

      // 先做乐观更新，界面立即响应
      setState(prev => ({
        ...prev,
        currentFolder: {
          ...prev.currentFolder,
          children: prev.currentFolder.children.filter(child => child.id !== id),
        },
        searchResults: prev.searchResults.filter(item => item.id !== id),
      }));

      // 再调用 Chrome API，成功后同步当前文件夹的最新数据
      chrome.bookmarks.remove(id, () => {
        if (chrome.runtime.lastError) {
          console.error('Failed to delete bookmark:', chrome.runtime.lastError);
          return;
        }
        // 提供撤销入口
        if (deletedItem) {
          showUndo(`已删除书签 “${deletedItem.title}”`, () => {
            chrome.bookmarks.create(
              {
                parentId: currentFolderId,
                title: deletedItem.title,
                url: deletedItem.url,
                index: deletedItem.index,
              },
              () => {
                if (chrome.runtime.lastError) {
                  console.error('Failed to restore bookmark:', chrome.runtime.lastError);
                }
              }
            );
          });
        }
        chrome.bookmarks.getSubTree(currentFolderId, results => {
          if (chrome.runtime.lastError) return;
          if (results && results.length > 0) {
            const updatedFolder = convertToBookmark(results[0]) as BookmarkFolder;
            setState(prevState => ({ ...prevState, currentFolder: updatedFolder }));
          }
        });
      });
    },
    [state.currentFolder, showUndo]
  );

  const handleDeleteFolder = useCallback(
    (id: string) => {
      // 删除前先保存完整子树，供撤销时恢复
      const deletedFolder = state.currentFolder.children.find(
        child => child.id === id && !('url' in child)
      ) as BookmarkFolder | undefined;
      const currentFolderId = state.currentFolder.id;

      chrome.bookmarks.removeTree(id, () => {
        if (chrome.runtime.lastError) {
          console.error('Failed to delete folder:', chrome.runtime.lastError);
          return;
        }
        setState(prev => ({
          ...prev,
          currentFolder: {
            ...prev.currentFolder,
            children: prev.currentFolder.children.filter(child => child.id !== id),
          },
          searchResults: prev.searchResults.filter(item => item.id !== id),
        }));
        // 提供撤销入口：递归重建文件夹及其内容
        if (deletedFolder) {
          showUndo(`已删除文件夹 “${deletedFolder.title}”`, () => {
            restoreFolderNode(deletedFolder, currentFolderId);
          });
        }
      });
    },
    [state.currentFolder, showUndo]
  );

  // 新建书签/文件夹
  const handleCreate = useCallback(
    (title: string, url?: string) => {
      const parentId = state.currentFolder.id;
      // 网址未带协议时自动补全 https 前缀
      const normalizedUrl = url ? (/^[\w-]+:\/\//.test(url) ? url : `https://${url}`) : undefined;

      chrome.bookmarks.create({ parentId, title, url: normalizedUrl }, created => {
        if (chrome.runtime.lastError || !created) {
          console.error('Failed to create item:', chrome.runtime.lastError);
          return;
        }
        setCreateModal(prev => ({ ...prev, open: false }));
        // 创建事件会触发防抖刷新，界面自动更新
      });
    },
    [state.currentFolder.id]
  );

  // 键盘快捷键支持
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Ctrl/Cmd + K 或 Ctrl/Cmd + F 聚焦搜索框
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'f')) {
        event.preventDefault();
        searchBarRef.current?.focus();
        return;
      }

      if (isInputFocused && event.key !== 'Escape') return;

      // ESC 键清除搜索、关闭模态框和右键菜单
      if (event.key === 'Escape') {
        setState(prev => ({
          ...prev,
          searchResults: [],
          searchTerm: '',
          editModalOpen: false,
          editingItemId: null,
          contextMenu: { ...prev.contextMenu, isOpen: false, targetItem: null, targetType: null },
        }));
        setCreateModal(prev => (prev.open ? { ...prev, open: false } : prev));
        // 通过受控方式清空搜索框，保证 React 状态同步
        searchBarRef.current?.clearSearch();
        return;
      }

      // F2 编辑当前选中项
      if (event.key === 'F2') {
        setState(prev => {
          if (prev.selectedItemId) {
            return { ...prev, editModalOpen: true, editingItemId: prev.selectedItemId };
          }
          return prev;
        });
        return;
      }

      // Delete 或 Backspace 删除当前选中项
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isInputFocused) {
        if (!state.selectedItemId) return;
        const allItems = [...state.currentFolder.children, ...state.searchResults];
        const selectedItem = allItems.find(item => item.id === state.selectedItemId);
        if (selectedItem) {
          if ('url' in selectedItem) {
            handleDeleteBookmark(selectedItem.id);
          } else {
            handleDeleteFolder(selectedItem.id);
          }
          setState(prev => ({ ...prev, selectedItemId: null }));
        }
        return;
      }

      // Enter 打开书签/进入文件夹
      if (event.key === 'Enter') {
        if (!state.selectedItemId) return;
        const allItems = [...state.currentFolder.children, ...state.searchResults];
        const selectedItem = allItems.find(item => item.id === state.selectedItemId);
        if (selectedItem) {
          if ('url' in selectedItem) {
            window.open(selectedItem.url, '_blank');
          } else {
            handleFolderClick(selectedItem as BookmarkFolder);
          }
        }
        return;
      }

      // Alt+Left 返回上一级（Backspace 仅用于删除选中项，避免误操作）
      if (event.altKey && event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        handleBack();
        return;
      }

      // 方向键导航
      const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (arrowKeys.indexOf(event.key) !== -1) {
        event.preventDefault();
        setState(prev => {
          const allItems =
            prev.searchResults.length > 0 ? prev.searchResults : prev.currentFolder.children;
          if (allItems.length === 0) return prev;

          let currentIndex = prev.selectedItemId
            ? allItems.findIndex(item => item.id === prev.selectedItemId)
            : -1;
          let newIndex = currentIndex;

          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            newIndex = currentIndex < allItems.length - 1 ? currentIndex + 1 : 0;
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            newIndex = currentIndex > 0 ? currentIndex - 1 : allItems.length - 1;
          }

          if (newIndex >= 0 && newIndex < allItems.length) {
            return { ...prev, selectedItemId: allItems[newIndex].id };
          } else if (currentIndex === -1) {
            return { ...prev, selectedItemId: allItems[0].id };
          }
          return prev;
        });
        return;
      }
    },
    [
      state.selectedItemId,
      state.currentFolder.children,
      state.searchResults,
      handleBack,
      handleFolderClick,
      handleDeleteBookmark,
      handleDeleteFolder,
    ]
  );

  // 右键菜单处理函数
  const handleContextMenu = useCallback((e: React.MouseEvent, item: Bookmark | BookmarkFolder) => {
    e.preventDefault();
    e.stopPropagation();
    const targetType = 'url' in item ? 'bookmark' : 'folder';
    setState(prev => ({
      ...prev,
      contextMenu: {
        isOpen: true,
        x: e.clientX,
        y: e.clientY,
        targetItem: item,
        targetType,
      },
      selectedItemId: item.id,
    }));
  }, []);

  const handleContextMenuClose = useCallback(() => {
    setState(prev => ({
      ...prev,
      contextMenu: { ...prev.contextMenu, isOpen: false, targetItem: null, targetType: null },
    }));
  }, []);

  const handleContextMenuEdit = useCallback(() => {
    setState(prev => {
      if (prev.contextMenu.targetItem) {
        return {
          ...prev,
          editModalOpen: true,
          editingItemId: prev.contextMenu.targetItem.id,
          contextMenu: { ...prev.contextMenu, isOpen: false, targetItem: null, targetType: null },
        };
      }
      return prev;
    });
  }, []);

  const handleContextMenuDelete = useCallback(() => {
    setState(prev => {
      if (prev.contextMenu.targetItem) {
        if (prev.contextMenu.targetType === 'bookmark') {
          handleDeleteBookmark(prev.contextMenu.targetItem.id);
        } else {
          handleDeleteFolder(prev.contextMenu.targetItem.id);
        }
        return {
          ...prev,
          contextMenu: { ...prev.contextMenu, isOpen: false, targetItem: null, targetType: null },
        };
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  // 加载书签数据
  const loadBookmarks = useCallback((isInitialLoad = false) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    chrome.bookmarks.getTree(bookmarkArray => {
      if (chrome.runtime.lastError) {
        console.error('Failed to load bookmarks:', chrome.runtime.lastError);
        setState(prev => ({ ...prev, isLoading: false, error: '加载书签失败，请刷新页面重试' }));
        return;
      }

      try {
        const rootNode = bookmarkArray[0]?.children?.[0] as ChromeBookmarkTreeNode;
        if (rootNode && bookmarkArray[0].children && bookmarkArray[0].children.length > 0) {
          const convertedFolder = convertToBookmark(rootNode) as BookmarkFolder;

          // 同步保存完整书签树，供全局搜索使用
          setState(prev => ({ ...prev, rootFolder: convertedFolder }));

          if (isInitialLoad) {
            setState(prev => ({ ...prev, currentFolder: convertedFolder, isLoading: false }));
            setTimeout(() => {
              const visibleBookmarks = convertedFolder.children
                .filter(item => 'url' in item)
                .slice(0, 20);
              const bookmarkUrls = visibleBookmarks.map(bookmark => (bookmark as Bookmark).url);
              if (bookmarkUrls.length > 0) {
                preloadFavicons(bookmarkUrls).catch(error => {
                  console.warn('Failed to preload some favicons:', error);
                });
              }
            }, 100);
          } else {
            setState(prev => {
              const currentFolderId = prev.currentFolder.id;
              if (currentFolderId !== convertedFolder.id) {
                const findFolder = (folder: BookmarkFolder, id: string): BookmarkFolder | null => {
                  if (folder.id === id) return folder;
                  for (const child of folder.children) {
                    if (!('url' in child) && child.children) {
                      const found = findFolder(child as BookmarkFolder, id);
                      if (found) return found;
                    }
                  }
                  return null;
                };

                const updatedCurrentFolder = findFolder(convertedFolder, currentFolderId);
                if (updatedCurrentFolder) {
                  return { ...prev, currentFolder: updatedCurrentFolder, isLoading: false };
                } else if (prev.folderHistory.length > 0) {
                  const previousFolder = prev.folderHistory[prev.folderHistory.length - 1];
                  return {
                    ...prev,
                    currentFolder: previousFolder,
                    folderHistory: prev.folderHistory.slice(0, -1),
                    isLoading: false,
                  };
                } else {
                  return { ...prev, currentFolder: convertedFolder, isLoading: false };
                }
              } else {
                return { ...prev, currentFolder: convertedFolder, isLoading: false };
              }
            });
          }
        } else {
          setState(prev => ({
            ...prev,
            isLoading: false,
            error: '无法找到书签数据，请检查浏览器书签设置',
          }));
        }
      } catch (error) {
        console.error('Error processing bookmarks:', error);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: '处理书签数据时出错，请刷新页面重试',
        }));
      }
    });
  }, []);

  // 使用 useRef 存储 loadBookmarks 的引用，避免在事件监听器中捕获过时的函数
  const loadBookmarksRef = useRef(loadBookmarks);
  loadBookmarksRef.current = loadBookmarks;

  // 加载书签数据并设置事件监听器
  useEffect(() => {
    // 初始加载
    loadBookmarksRef.current(true);

    // 防抖刷新：批量变更（如导入书签）时合并为一次全量刷新
    const debouncedReload = () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        loadBookmarksRef.current(false);
      }, 200);
    };

    // 监听 Chrome bookmarks API 的事件
    const handleBookmarkChanged = () => {
      debouncedReload();
    };

    const handleBookmarkRemoved = (id: string) => {
      // 检查是否是我们手动删除的书签（避免重复处理）
      const isRecentlyDeleted = recentlyDeletedRef.current.some(item => item.id === id);
      if (isRecentlyDeleted) {
        return;
      }
      debouncedReload();
    };

    const handleBookmarkCreatedOrMoved = () => {
      debouncedReload();
    };

    // 添加事件监听器
    chrome.bookmarks.onChanged.addListener(handleBookmarkChanged);
    chrome.bookmarks.onRemoved.addListener(handleBookmarkRemoved);
    chrome.bookmarks.onCreated.addListener(handleBookmarkCreatedOrMoved);
    chrome.bookmarks.onMoved.addListener(handleBookmarkCreatedOrMoved);

    // 组件卸载时移除事件监听器
    return () => {
      chrome.bookmarks.onChanged.removeListener(handleBookmarkChanged);
      chrome.bookmarks.onRemoved.removeListener(handleBookmarkRemoved);
      chrome.bookmarks.onCreated.removeListener(handleBookmarkCreatedOrMoved);
      chrome.bookmarks.onMoved.removeListener(handleBookmarkCreatedOrMoved);
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []); // 只在组件挂载时执行一次，使用 ref 来访问最新的 loadBookmarks

  const handleTitleChange = useCallback((id: string, newTitle: string) => {
    chrome.bookmarks.update(id, { title: newTitle }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to update bookmark title:', chrome.runtime.lastError);
        return;
      }
      setState(prev => ({
        ...prev,
        currentFolder: {
          ...prev.currentFolder,
          title: id === prev.currentFolder.id ? newTitle : prev.currentFolder.title,
          children: prev.currentFolder.children.map(child =>
            child.id === id ? { ...child, title: newTitle } : child
          ),
        },
        editModalOpen: false,
        editingItemId: null,
      }));
    });
  }, []);

  const handleUpdateBookmark = useCallback((id: string, newTitle: string) => {
    chrome.bookmarks.update(id, { title: newTitle }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to update bookmark:', chrome.runtime.lastError);
        return;
      }
      setState(prev => ({
        ...prev,
        currentFolder: {
          ...prev.currentFolder,
          children: prev.currentFolder.children.map(child =>
            child.id === id ? { ...child, title: newTitle } : child
          ),
        },
        searchResults: prev.searchResults.map(item =>
          item.id === id ? { ...item, title: newTitle } : item
        ),
      }));
    });
  }, []);

  const handleUpdateFolder = useCallback((id: string, newTitle: string) => {
    chrome.bookmarks.update(id, { title: newTitle }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to update folder:', chrome.runtime.lastError);
        return;
      }
      setState(prev => ({
        ...prev,
        currentFolder: {
          ...prev.currentFolder,
          title: id === prev.currentFolder.id ? newTitle : prev.currentFolder.title,
          children: prev.currentFolder.children.map(child =>
            child.id === id ? { ...child, title: newTitle } : child
          ),
        },
        folderHistory: prev.folderHistory.map(folder =>
          folder.id === id ? { ...folder, title: newTitle } : folder
        ),
        searchResults: prev.searchResults.map(item =>
          item.id === id ? { ...item, title: newTitle } : item
        ),
      }));
    });
  }, []);

  // 处理搜索结果回调
  const handleSearchResult = useCallback(
    (results: (Bookmark | BookmarkFolder)[], searchTerm: string) => {
      setState(prev => ({ ...prev, searchResults: results, searchTerm }));
    },
    []
  );

  const isSearching = state.searchTerm.trim().length > 0;
  const visibleItems = isSearching ? state.searchResults : state.currentFolder.children;
  const folderTitle = state.currentFolder.title || '书签';

  return (
    <div className='ev-newtab-page'>
      <div className='ev-newtab-shell scrollbar-modern'>
        <header className='ev-bookmark-header'>
          <div className='ev-newtab-toolbar'>
            <div className='ev-bookmark-heading'>
              <div className='ev-bookmark-heading-copy'>
                <span className='ev-newtab-kicker'>EV Browser</span>
                <div className='ev-breadcrumb-row'>
                  {state.folderHistory.length > 0 && (
                    <button
                      onClick={handleBack}
                      className='ev-button ev-button-ghost ev-button-icon focus-ring-modern'
                      title='返回上一级'
                      aria-label='返回上一级'>
                      <ArrowLeft size={16} />
                    </button>
                  )}
                  <nav aria-label='文件夹路径导航'>
                    <ol className='ev-breadcrumb-list'>
                      {state.folderHistory.map((folder, index) => (
                        <li key={folder.id}>
                          <button
                            onClick={() => {
                              setState(prev => ({
                                ...prev,
                                currentFolder: folder,
                                folderHistory: prev.folderHistory.slice(0, index),
                                searchResults: [],
                                searchTerm: '',
                              }));
                              searchBarRef.current?.clearSearch();
                            }}
                            className='ev-breadcrumb-button'
                            aria-label={`导航到文件夹: ${folder.title}`}>
                            {folder.title}
                          </button>
                          <ChevronRight size={13} aria-hidden='true' />
                        </li>
                      ))}
                      <li>
                        <h1 id='current-folder-title'>{folderTitle}</h1>
                      </li>
                    </ol>
                  </nav>
                </div>
              </div>
            </div>
            <div className='ev-bookmark-actions'>
              <Button
                variant='outline'
                onClick={() => setCreateModal({ open: true, type: 'folder' })}
                title='在当前文件夹新建文件夹'>
                <FolderPlus size={15} />
                <span>文件夹</span>
              </Button>
              <Button
                onClick={() => setCreateModal({ open: true, type: 'bookmark' })}
                title='在当前文件夹新建书签'>
                <Plus size={15} />
                <span>书签</span>
              </Button>
            </div>
          </div>

          <div className='ev-bookmark-search'>
            <SearchBar
              ref={searchBarRef}
              currentFolder={state.currentFolder}
              rootFolder={state.rootFolder}
              onSearchResult={handleSearchResult}
            />
          </div>
        </header>

        <main className='ev-bookmark-content'>
          {!isSearching && !state.isLoading && <FrequentSites maxSites={8} />}

          <section className='ev-home-section ev-bookmark-library' aria-labelledby='library-title'>
            <div className='ev-section-heading'>
              <div className='ev-section-heading-main'>
                <div>
                  <h2 id='library-title'>{isSearching ? '搜索结果' : '书签'}</h2>
                  <p>{isSearching ? `全部书签中与“${state.searchTerm}”匹配的项目` : folderTitle}</p>
                </div>
              </div>
              <span className='ev-section-count' aria-live='polite'>
                {state.isLoading ? '加载中' : `${visibleItems.length} 项`}
              </span>
            </div>

            {state.isLoading ? (
              <div className='ev-bookmark-grid' aria-busy='true' aria-label='正在加载书签'>
                {Array.from({ length: 8 }).map((_, index) => (
                  <div className='skeleton-card ev-bookmark-skeleton' key={index} />
                ))}
              </div>
            ) : visibleItems.length > 0 ? (
              <div
                className='ev-bookmark-grid'
                role='grid'
                aria-label={isSearching ? '搜索结果' : '书签和文件夹'}>
                {visibleItems.map(item =>
                  'url' in item ? (
                    <Link
                      key={item.id}
                      data={item as Bookmark}
                      onUpdateBookmark={handleUpdateBookmark}
                      onDeleteBookmark={handleDeleteBookmark}
                      onContextMenu={event => handleContextMenu(event, item)}
                      isSelected={state.selectedItemId === item.id}
                    />
                  ) : (
                    <Folder
                      key={item.id}
                      folder={item as BookmarkFolder}
                      onFolderClick={() => handleFolderClick(item as BookmarkFolder)}
                      onUpdateFolder={handleUpdateFolder}
                      onDeleteFolder={handleDeleteFolder}
                      onContextMenu={event => handleContextMenu(event, item)}
                      isSelected={state.selectedItemId === item.id}
                    />
                  )
                )}
              </div>
            ) : (
              <div className='empty-state'>
                {isSearching ? (
                  <Search className='empty-state-icon' />
                ) : (
                  <FolderIcon className='empty-state-icon' />
                )}
                <h3 className='empty-state-title'>
                  {isSearching ? '没有匹配的书签' : '这个文件夹还是空的'}
                </h3>
                <p className='empty-state-description'>
                  {isSearching
                    ? '试试更短的关键词，或按 Esc 清除搜索。'
                    : '添加一个书签，或创建文件夹开始整理。'}
                </p>
                {!isSearching && (
                  <div className='ev-empty-actions'>
                    <Button
                      variant='outline'
                      onClick={() => setCreateModal({ open: true, type: 'folder' })}>
                      <FolderPlus size={15} /> 新建文件夹
                    </Button>
                    <Button onClick={() => setCreateModal({ open: true, type: 'bookmark' })}>
                      <Plus size={15} /> 新建书签
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>
      </div>

      <EditModal
        isOpen={state.editModalOpen}
        onClose={() => setState(prev => ({ ...prev, editModalOpen: false, editingItemId: null }))}
        onSave={title => {
          if (state.editingItemId) {
            const item = [...state.currentFolder.children, ...state.searchResults].find(
              i => i.id === state.editingItemId
            );
            if (item) {
              if ('url' in item) {
                handleUpdateBookmark(item.id, title);
              } else {
                handleUpdateFolder(item.id, title);
              }
            }
          }
        }}
        title={(() => {
          if (state.editingItemId) {
            const item = [...state.currentFolder.children, ...state.searchResults].find(
              i => i.id === state.editingItemId
            );
            return item?.title || '';
          }
          return '';
        })()}
      />

      <ContextMenu
        x={state.contextMenu.x}
        y={state.contextMenu.y}
        isOpen={state.contextMenu.isOpen}
        onClose={handleContextMenuClose}
        onEdit={handleContextMenuEdit}
        onDelete={handleContextMenuDelete}
      />

      <CreateModal
        isOpen={createModal.open}
        type={createModal.type}
        onClose={() => setCreateModal(prev => ({ ...prev, open: false }))}
        onCreate={handleCreate}
      />

      {undo && (
        <UndoToast
          message={undo.message}
          onUndo={() => {
            undo.restore();
            dismissUndo();
          }}
          onDismiss={dismissUndo}
        />
      )}

      {state.error && <ErrorMessage error={state.error} onRetry={() => loadBookmarks(true)} />}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <SettingsProvider>
    <NewtabContent />
  </SettingsProvider>
);
