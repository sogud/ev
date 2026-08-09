import { Bookmark, BookmarkFolder } from '../types';

/**
 * 搜索书签和文件夹
 * @param query 搜索关键词
 * @param folder 要搜索的文件夹
 * @returns 匹配的结果数组
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
    // 搜索标题
    if (item.title.toLowerCase().includes(searchTerm)) {
      return true;
    }

    // 如果是书签，搜索 URL
    if ('url' in item && item.url) {
      try {
        const url = new URL(item.url);
        if (url.hostname.toLowerCase().includes(searchTerm)) {
          return true;
        }
      } catch {
        // 忽略无效 URL
      }
    }

    return false;
  };

  const traverse = (item: Bookmark | BookmarkFolder) => {
    if (searchInItem(item)) {
      results.push(item);
    }

    // 如果是文件夹，继续搜索子项
    if (!('url' in item) && item.children) {
      item.children.forEach(child => traverse(child));
    }
  };

  traverse(folder);
  return results;
}

/**
 * 获取书签树中的所有项目（用于扁平化搜索）
 * @param folder 根文件夹
 * @returns 所有书签和文件夹的扁平数组
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
