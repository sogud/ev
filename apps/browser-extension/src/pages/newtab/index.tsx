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
import type { SearchBarRef } from '../../components/search-bar/SearchBar';
import SearchBar from '../../components/search-bar/SearchBar';
import ErrorMessage from '../../components/ui/error-message';
import { Button } from '../../components/ui/button';
import ContextMenu from '../../components/context-menu/ContextMenu';
import FrequentSites from '../../components/frequent-sites/FrequentSites';
import { SettingsProvider, useSettings } from '../../contexts/SettingsContext';
import { applyCustomSettings, applySavedBackground } from '../../utils/apply-settings';

import type { Bookmark, BookmarkFolder, ChromeBookmarkTreeNode } from '../../types';
import { convertToBookmark } from '../../types';
import { preloadFavicons } from '../../utils/favicon';

// Single state shape for the page.
interface AppState {
  // Bookmark data.
  currentFolder: BookmarkFolder;
  // Full tree, used for global search.
  rootFolder: BookmarkFolder | null;
  folderHistory: BookmarkFolder[];
  searchResults: (Bookmark | BookmarkFolder)[];
  searchTerm: string;
  isLoading: boolean;
  error: string | null;
  // UI state.
  editModalOpen: boolean;
  editingItemId: string | null;
  // Context menu.
  contextMenu: {
    isOpen: boolean;
    x: number;
    y: number;
    targetItem: Bookmark | BookmarkFolder | null;
    targetType: 'bookmark' | 'folder' | null;
  };
  // Selected item.
  selectedItemId: string | null;
}

const EditModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (title: string) => void;
  title: string;
}> = ({ isOpen, onClose, onSave, title }) => {
  const [inputTitle, setInputTitle] = useState(title);

  // Re-sync the title whenever the dialog opens or the target changes, so stale text never leaks in.
  useEffect(() => {
    if (isOpen) {
      setInputTitle(title);
    }
  }, [isOpen, title]);

  if (!isOpen) return null;

  return (
    <div className='ev-modal-backdrop'>
      <div className='ev-modal-content'>
        <h2>Edit bookmark</h2>
        <input
          type='text'
          value={inputTitle}
          onChange={e => setInputTitle(e.target.value)}
          className='ev-input mb-3'
        />
        <div className='flex gap-2 justify-end'>
          <Button variant='outline' onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(inputTitle)}>Save</Button>
        </div>
      </div>
    </div>
  );
};

// Create bookmark/folder dialog.
const CreateModal: React.FC<{
  isOpen: boolean;
  type: 'bookmark' | 'folder';
  onClose: () => void;
  onCreate: (title: string, url?: string) => void;
}> = ({ isOpen, type, onClose, onCreate }) => {
  const [inputTitle, setInputTitle] = useState('');
  const [inputUrl, setInputUrl] = useState('');

  // Reset the form on every open.
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
        <h2>{type === 'bookmark' ? 'New bookmark' : 'New folder'}</h2>
        <input
          type='text'
          value={inputTitle}
          onChange={e => setInputTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          placeholder={type === 'bookmark' ? 'Enter bookmark name...' : 'Enter folder name...'}
          autoFocus
          className='ev-input mb-2'
        />
        {type === 'bookmark' && (
          <input
            type='text'
            value={inputUrl}
            onChange={e => setInputUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder='Enter a URL, e.g. example.com'
            className='ev-input mb-3'
          />
        )}
        <div className='flex gap-2 justify-end'>
          <Button variant='outline' onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSave}>
            Create
          </Button>
        </div>
      </div>
    </div>
  );
};

// Undo toast for deletions.
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
        Undo
      </button>
      <button
        onClick={onDismiss}
        className='text-[var(--ev-color-icon-tertiary)] hover:text-[var(--ev-color-icon-primary)]'
        aria-label='Dismiss notice'>
        ✕
      </button>
    </div>
  );
};

// Recursively restore a deleted folder subtree.
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
  // Single state management.
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

  // Tracks the most recent deletion for undo.
  const recentlyDeletedRef = useRef<{ id: string; timestamp: number }[]>([]);

  // Search input ref: shortcut focus + controlled clear.
  const searchBarRef = useRef<SearchBarRef>(null);

  // Debounce timer for bookmark-event refreshes.
  const reloadTimerRef = useRef<number | null>(null);

  // Create-dialog state.
  const [createModal, setCreateModal] = useState<{ open: boolean; type: 'bookmark' | 'folder' }>({
    open: false,
    type: 'bookmark',
  });

  // Undo state.
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

  // Clear the undo timer on unmount.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

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
      // Record the deletion source so bookmark-event listeners do not double-process it.
      recentlyDeletedRef.current.push({ id, timestamp: Date.now() });
      const now = Date.now();
      recentlyDeletedRef.current = recentlyDeletedRef.current.filter(
        item => now - item.timestamp < 5000
      );

      // Snapshot state before deletion so undo can restore it.
      const deletedItem = state.currentFolder.children.find(
        child => child.id === id && 'url' in child
      ) as Bookmark | undefined;
      const currentFolderId = state.currentFolder.id;

      // Optimistic update first so the UI responds immediately.
      setState(prev => ({
        ...prev,
        currentFolder: {
          ...prev.currentFolder,
          children: prev.currentFolder.children.filter(child => child.id !== id),
        },
        searchResults: prev.searchResults.filter(item => item.id !== id),
      }));

      // Then call the Chrome API; on success, refresh the current folder data.
      chrome.bookmarks.remove(id, () => {
        if (chrome.runtime.lastError) {
          console.error('Failed to delete bookmark:', chrome.runtime.lastError);
          return;
        }
        // Offer undo.
        if (deletedItem) {
          showUndo(`Deleted bookmark “${deletedItem.title}”`, () => {
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
      // Snapshot the full subtree before deletion so undo can restore it.
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
        // Offer undo: recursively rebuild the folder and its contents.
        if (deletedFolder) {
          showUndo(`Deleted folder “${deletedFolder.title}”`, () => {
            restoreFolderNode(deletedFolder, currentFolderId);
          });
        }
      });
    },
    [state.currentFolder, showUndo]
  );

  // Create bookmark/folder.
  const handleCreate = useCallback(
    (title: string, url?: string) => {
      const parentId = state.currentFolder.id;
      // Prepend https:// when the URL has no scheme.
      const normalizedUrl = url ? (/^[\w-]+:\/\//.test(url) ? url : `https://${url}`) : undefined;

      chrome.bookmarks.create({ parentId, title, url: normalizedUrl }, created => {
        if (chrome.runtime.lastError || !created) {
          console.error('Failed to create item:', chrome.runtime.lastError);
          return;
        }
        setCreateModal(prev => ({ ...prev, open: false }));
        // Creation triggers the debounced refresh; the UI updates on its own.
      });
    },
    [state.currentFolder.id]
  );

  // Keyboard shortcuts.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Ctrl/Cmd+K or Ctrl/Cmd+F focuses the search box.
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'f')) {
        event.preventDefault();
        searchBarRef.current?.focus();
        return;
      }

      if (isInputFocused && event.key !== 'Escape') return;

      // ESC clears the search and closes modals and the context menu.
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
        // Clear the search box in a controlled way so React state stays in sync.
        searchBarRef.current?.clearSearch();
        return;
      }

      // F2 edits the selected item.
      if (event.key === 'F2') {
        setState(prev => {
          if (prev.selectedItemId) {
            return { ...prev, editModalOpen: true, editingItemId: prev.selectedItemId };
          }
          return prev;
        });
        return;
      }

      // Delete or Backspace deletes the selected item.
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

      // Enter opens a bookmark / enters a folder.
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

      // Alt+Left goes up one level (Backspace is reserved for deleting the selection, to avoid misfires).
      if (event.altKey && event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        handleBack();
        return;
      }

      // Arrow-key navigation.
      const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (arrowKeys.indexOf(event.key) !== -1) {
        event.preventDefault();
        setState(prev => {
          const allItems =
            prev.searchResults.length > 0 ? prev.searchResults : prev.currentFolder.children;
          if (allItems.length === 0) return prev;

          const currentIndex = prev.selectedItemId
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

  // Context menu handlers.
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

  // Load bookmarks.
  const loadBookmarks = useCallback((isInitialLoad = false) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    chrome.bookmarks.getTree(bookmarkArray => {
      if (chrome.runtime.lastError) {
        console.error('Failed to load bookmarks:', chrome.runtime.lastError);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: 'Failed to load bookmarks; refresh the page and try again',
        }));
        return;
      }

      try {
        const rootNode = bookmarkArray[0]?.children?.[0] as ChromeBookmarkTreeNode;
        if (rootNode && bookmarkArray[0].children && bookmarkArray[0].children.length > 0) {
          const convertedFolder = convertToBookmark(rootNode) as BookmarkFolder;

          // Keep the full tree in sync for global search.
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
            error: 'Bookmark data not found; check your browser bookmark settings',
          }));
        }
      } catch (error) {
        console.error('Error processing bookmarks:', error);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: 'Error processing bookmark data; refresh the page and try again',
        }));
      }
    });
  }, []);

  // Keep loadBookmarks in a ref so event listeners never capture a stale closure.
  const loadBookmarksRef = useRef(loadBookmarks);
  loadBookmarksRef.current = loadBookmarks;

  // Load bookmarks and attach listeners.
  useEffect(() => {
    // Initial load.
    loadBookmarksRef.current(true);

    // Debounced refresh: batch changes (e.g. imports) collapse into one full reload.
    const debouncedReload = () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        loadBookmarksRef.current(false);
      }, 200);
    };

    // Listen to Chrome bookmarks API events.
    const handleBookmarkChanged = () => {
      debouncedReload();
    };

    const handleBookmarkRemoved = (id: string) => {
      // Skip bookmarks we deleted ourselves (avoid double processing).
      const isRecentlyDeleted = recentlyDeletedRef.current.some(item => item.id === id);
      if (isRecentlyDeleted) {
        return;
      }
      debouncedReload();
    };

    const handleBookmarkCreatedOrMoved = () => {
      debouncedReload();
    };

    // Attach listeners.
    chrome.bookmarks.onChanged.addListener(handleBookmarkChanged);
    chrome.bookmarks.onRemoved.addListener(handleBookmarkRemoved);
    chrome.bookmarks.onCreated.addListener(handleBookmarkCreatedOrMoved);
    chrome.bookmarks.onMoved.addListener(handleBookmarkCreatedOrMoved);

    // Detach listeners on unmount.
    return () => {
      chrome.bookmarks.onChanged.removeListener(handleBookmarkChanged);
      chrome.bookmarks.onRemoved.removeListener(handleBookmarkRemoved);
      chrome.bookmarks.onCreated.removeListener(handleBookmarkCreatedOrMoved);
      chrome.bookmarks.onMoved.removeListener(handleBookmarkCreatedOrMoved);
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []); // mount-only; refs give access to the latest loadBookmarks

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

  // Search results callback.
  const handleSearchResult = useCallback(
    (results: (Bookmark | BookmarkFolder)[], searchTerm: string) => {
      setState(prev => ({ ...prev, searchResults: results, searchTerm }));
    },
    []
  );

  const isSearching = state.searchTerm.trim().length > 0;
  const visibleItems = isSearching ? state.searchResults : state.currentFolder.children;
  const folderTitle = state.currentFolder.title || 'Bookmarks';

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
                      title='Go up one level'
                      aria-label='Go up one level'>
                      <ArrowLeft size={16} />
                    </button>
                  )}
                  <nav aria-label='Folder path navigation'>
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
                            aria-label={`Navigate to folder: ${folder.title}`}>
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
                title='New folder in the current folder'>
                <FolderPlus size={15} />
                <span>Folder</span>
              </Button>
              <Button
                onClick={() => setCreateModal({ open: true, type: 'bookmark' })}
                title='New bookmark in the current folder'>
                <Plus size={15} />
                <span>Bookmark</span>
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
                  <h2 id='library-title'>{isSearching ? 'Search results' : 'Bookmarks'}</h2>
                  <p>
                    {isSearching
                      ? `Items matching “${state.searchTerm}” across all bookmarks`
                      : folderTitle}
                  </p>
                </div>
              </div>
              <span className='ev-section-count' aria-live='polite'>
                {state.isLoading ? 'Loading' : `${visibleItems.length} items`}
              </span>
            </div>

            {state.isLoading ? (
              <div className='ev-bookmark-grid' aria-busy='true' aria-label='Loading bookmarks'>
                {Array.from({ length: 8 }).map((_, index) => (
                  <div className='skeleton-card ev-bookmark-skeleton' key={index} />
                ))}
              </div>
            ) : visibleItems.length > 0 ? (
              <div
                className='ev-bookmark-grid'
                role='grid'
                aria-label={isSearching ? 'Search results' : 'Bookmarks and folders'}>
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
                  {isSearching ? 'No matching bookmarks' : 'This folder is still empty'}
                </h3>
                <p className='empty-state-description'>
                  {isSearching
                    ? 'Try a shorter keyword, or press Esc to clear the search.'
                    : 'Add a bookmark, or create a folder to start organizing.'}
                </p>
                {!isSearching && (
                  <div className='ev-empty-actions'>
                    <Button
                      variant='outline'
                      onClick={() => setCreateModal({ open: true, type: 'folder' })}>
                      <FolderPlus size={15} /> New folder
                    </Button>
                    <Button onClick={() => setCreateModal({ open: true, type: 'bookmark' })}>
                      <Plus size={15} /> New bookmark
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
