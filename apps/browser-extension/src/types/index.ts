export interface Bookmark {
  id: string;
  title: string;
  url: string;
  parentId?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
}

export interface BookmarkFolder {
  id: string;
  title: string;
  children: (Bookmark | BookmarkFolder)[];
  parentId?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
}

export interface Options {
  theme: 'light' | 'dark' | 'auto';
  sortBy: 'date' | 'name' | 'url';
  // Icon color settings.
  iconColor: {
    bookmark: string;
    folder: string;
  };
  // Background settings.
  background: {
    type: 'gradient' | 'image' | 'color';
    value: string;
    opacity: number;
  };
  // UI customization.
  uiCustomization: {
    cardStyle: 'modern' | 'minimal' | 'glass';
    animationEnabled: boolean;
    compactMode: boolean;
  };
}

// Drag-and-drop types.
export interface DragState {
  activeId: string | null;
  overId: string | null;
}

// UI state types.
export interface BookmarkState {
  currentFolder: BookmarkFolder;
  folderHistory: BookmarkFolder[];
  searchResults: (Bookmark | BookmarkFolder)[];
  isLoading: boolean;
  error: string | null;
}

export interface UIModalState {
  editModalOpen: boolean;
  editingItemId: string | null;
}

// Event handler types.
export type BookmarkHandler = (id: string, title: string) => void;
export type FolderHandler = (id: string) => void;
export type SearchHandler = (results: (Bookmark | BookmarkFolder)[], searchTerm: string) => void;

// Component props types.
export interface BaseItemProps {
  onContextMenuOpen?: () => void;
  onContextMenuClose?: () => void;
  isContextMenuOpen?: boolean;
}

export interface BookmarkItemProps extends BaseItemProps {
  data: Bookmark;
  onUpdateBookmark?: BookmarkHandler;
  onDeleteBookmark?: (id: string) => void;
}

export interface FolderItemProps extends BaseItemProps {
  folder: BookmarkFolder;
  onFolderClick?: (folder: BookmarkFolder) => void;
  onUpdateFolder?: BookmarkHandler;
  onDeleteFolder?: FolderHandler;
}

// Chrome Bookmarks API types.
export interface ChromeBookmarkTreeNode {
  id: string;
  parentId?: string;
  index?: number;
  url?: string;
  title: string;
  dateAdded?: number;
  dateGroupModified?: number;
  children?: ChromeBookmarkTreeNode[];
}

export const convertToBookmark = (node: ChromeBookmarkTreeNode): Bookmark | BookmarkFolder => {
  const base = {
    id: node.id,
    title: node.title,
    parentId: node.parentId,
    dateAdded: node.dateAdded || 0,
    dateGroupModified: node.dateGroupModified || 0,
    index: node.index || 0,
  };

  if (node.url) {
    return {
      ...base,
      url: node.url,
      children: node.children?.map(convertToBookmark),
    } as Bookmark;
  }

  return {
    ...base,
    children: (node.children || []).map(convertToBookmark),
  } as BookmarkFolder;
};
