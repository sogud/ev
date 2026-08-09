import type { Bookmark, BookmarkFolder } from '../types';

/**
 * Search bookmarks and folders.
 * @param query Search keyword.
 * @param folder Folder to search in.
 * @returns Matching results.
 */
export function searchBookmarks(
  query: string,
  folder: BookmarkFolder
): (Bookmark | BookmarkFolder)[] {
  if (!query.trim()) {
    return [];
  }

  const results: (Bookmark | BookmarkFolder)[] = [];
  const searchTerm = query.toLowerCase();

  const searchInItem = (item: Bookmark | BookmarkFolder): boolean => {
    // Match titles.
    if (item.title.toLowerCase().includes(searchTerm)) {
      return true;
    }

    // Bookmarks also match URLs.
    if ('url' in item && item.url) {
      try {
        const url = new URL(item.url);
        if (url.hostname.toLowerCase().includes(searchTerm)) {
          return true;
        }
      } catch {
        // Ignore invalid URLs.
      }
    }

    return false;
  };

  const traverse = (item: Bookmark | BookmarkFolder) => {
    if (searchInItem(item)) {
      results.push(item);
    }

    // Folders recurse into children.
    if (!('url' in item) && item.children) {
      item.children.forEach(child => traverse(child));
    }
  };

  traverse(folder);
  return results;
}

/**
 * Flatten the bookmark tree (for global search).
 * @param folder Root folder.
 * @returns Flat array of all bookmarks and folders.
 */
export function getAllBookmarks(folder: BookmarkFolder): (Bookmark | BookmarkFolder)[] {
  const results: (Bookmark | BookmarkFolder)[] = [];

  const traverse = (item: Bookmark | BookmarkFolder) => {
    results.push(item);
    if (!('url' in item) && item.children) {
      item.children.forEach(child => traverse(child));
    }
  };

  traverse(folder);
  return results;
}
