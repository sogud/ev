import React, {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from 'react';
import { Search, X, Command } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Bookmark, BookmarkFolder } from '../../types';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { searchBookmarks } from '../../utils/search';

interface SearchBarProps {
  currentFolder: BookmarkFolder;
  /** Full bookmark tree; when present, search is global, otherwise scoped to the current folder. */
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
    const { t } = useTranslation();
    const [searchTerm, setSearchTerm] = useState('');
    const [resultCount, setResultCount] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleSearch = useCallback(
      (term: string) => {
        if (term.trim()) {
          // Prefer global search over the full tree, excluding the search root itself.
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

    // Expose imperative methods to the parent via useImperativeHandle.
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
            placeholder={t('browser.newTab.searchPlaceholder')}
            aria-label={t('browser.newTab.searchAria')}
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
                ? t('browser.newTab.searchFound', { count: resultCount, term: searchTerm })
                : t('browser.newTab.searchEmpty', { term: searchTerm })}
            </span>
          </div>
        )}
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';

export default SearchBar;
