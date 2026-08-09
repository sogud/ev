import React, {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from 'react';
import { Search, X, Command } from 'lucide-react';
import { Bookmark, BookmarkFolder } from '../../types';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { searchBookmarks } from '../../utils/search';
import { cn } from '../../lib/utils';

interface SearchBarProps {
  currentFolder: BookmarkFolder;
  /** 完整书签树，存在时进行全局搜索，否则仅搜索当前文件夹 */
  rootFolder?: BookmarkFolder | null;
  onSearchResult: (results: (Bookmark | BookmarkFolder)[], searchTerm: string) => void;
}

export interface SearchBarRef {
  refreshSearch: () => void;
  clearSearch: () => void;
  focus: () => void;
}

const SearchBar = forwardRef<SearchBarRef, SearchBarProps>(
  ({ currentFolder, rootFolder, onSearchResult }, ref) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [resultCount, setResultCount] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleSearch = useCallback(
      (term: string) => {
        if (term.trim()) {
          // 优先在完整书签树中全局搜索，排除搜索范围自身（根文件夹）
          const scope = rootFolder ?? currentFolder;
          const results = searchBookmarks(term, scope).filter(item => item.id !== scope.id);
          setResultCount(results.length);
          onSearchResult(results, term);
        } else {
          setResultCount(0);
          onSearchResult([], '');
        }
      },
      [currentFolder, rootFolder, onSearchResult]
    );

    useEffect(() => {
      handleSearch(searchTerm);
    }, [searchTerm, handleSearch]);

    // 使用 useImperativeHandle 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      refreshSearch: () => {
        handleSearch(searchTerm);
      },
      clearSearch: () => {
        setSearchTerm('');
      },
      focus: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }));

    return (
      <div className='w-full'>
        <div className='relative group'>
          <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ev-color-icon-tertiary)]' />
          <Input
            ref={inputRef}
            type='text'
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder='搜索全部书签和文件夹…'
            aria-label='搜索全部书签和文件夹'
            className='search-input pl-9 pr-14'
          />
          <div className='search-shortcut'>
            <Command className='h-3 w-3' />
            <span>K</span>
          </div>
          {searchTerm && (
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setSearchTerm('')}
              className='search-clear-btn'>
              <X className='h-4 w-4' />
            </Button>
          )}
        </div>
        {searchTerm && (
          <div className='search-indicator' aria-live='polite'>
            <span>
              {resultCount > 0
                ? `找到 ${resultCount} 个与 "${searchTerm}" 相关的结果`
                : `未找到与 "${searchTerm}" 相关的结果`}
            </span>
          </div>
        )}
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';

export default SearchBar;
