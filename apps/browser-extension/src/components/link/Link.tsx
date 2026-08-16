import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Bookmark, BookmarkHandler, BookmarkItemProps } from '../../types';
import { getFaviconUrl } from '../../utils/favicon';
import { cn } from '../../lib/utils';
import EditMode from '../ui/edit-mode';
import DeleteConfirmation from '../ui/delete-confirmation';

interface LinkProps extends BookmarkItemProps {
  onUpdateBookmark?: BookmarkHandler;
  onDeleteBookmark?: (id: string) => void;
  onContextMenu?: (event: React.MouseEvent, item: Bookmark) => void;
  isSelected?: boolean;
}

type LinkMode = 'normal' | 'editing' | 'confirming-delete';

function displayDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function avatarLetter(title: string, url: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle) return normalizedTitle[0].toUpperCase();
  const domain = displayDomain(url);
  return domain[0]?.toUpperCase() ?? '·';
}

function BookmarkVisual({
  title,
  url,
  faviconUrl,
  loading,
  onFaviconError,
}: {
  title: string;
  url: string;
  faviconUrl: string;
  loading: boolean;
  onFaviconError(): void;
}): React.JSX.Element {
  if (loading) {
    return (
      <span className='bookmark-favicon-loading' aria-hidden='true'>
        <Loader2 size={15} />
      </span>
    );
  }

  if (faviconUrl) {
    return (
      <img src={faviconUrl} alt='' className='bookmark-icon-modern' onError={onFaviconError} />
    );
  }

  return (
    <span className='bookmark-fallback-icon' aria-hidden='true'>
      {avatarLetter(title, url)}
    </span>
  );
}

const Link: React.FC<LinkProps> = React.memo(
  ({ data, onUpdateBookmark, onDeleteBookmark, onContextMenu, isSelected = false }) => {
    const { t } = useTranslation();
    const [mode, setMode] = useState<LinkMode>('normal');
    const [faviconUrl, setFaviconUrl] = useState('');
    const [isLoadingFavicon, setIsLoadingFavicon] = useState(true);
    const cardRef = useRef<HTMLAnchorElement>(null);

    useEffect(() => {
      if (isSelected) {
        cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, [isSelected]);

    useEffect(() => {
      let cancelled = false;
      setIsLoadingFavicon(true);
      getFaviconUrl(data.url)
        .then(url => {
          if (!cancelled) setFaviconUrl(url);
        })
        .catch(() => {
          if (!cancelled) setFaviconUrl('');
        })
        .finally(() => {
          if (!cancelled) setIsLoadingFavicon(false);
        });

      return () => {
        cancelled = true;
      };
    }, [data.url]);

    const visual = (
      <BookmarkVisual
        title={data.title}
        url={data.url}
        faviconUrl={faviconUrl}
        loading={isLoadingFavicon}
        onFaviconError={() => setFaviconUrl('')}
      />
    );

    const handleEditSave = useCallback(
      (newTitle: string) => {
        if (newTitle && newTitle !== data.title) {
          onUpdateBookmark?.(data.id, newTitle);
        }
        setMode('normal');
      },
      [data.title, data.id, onUpdateBookmark]
    );

    const handleDeleteConfirm = useCallback(() => {
      onDeleteBookmark?.(data.id);
    }, [data.id, onDeleteBookmark]);

    if (mode === 'editing') {
      return (
        <div className='bookmark-card-modern'>
          <div className='icon-container-modern'>{visual}</div>
          <div className='bookmark-editor'>
            <EditMode
              initialValue={data.title}
              onSave={handleEditSave}
              onCancel={() => setMode('normal')}
              placeholder={t('browser.newTab.bookmarkNamePlaceholder')}
            />
          </div>
        </div>
      );
    }

    if (mode === 'confirming-delete') {
      return (
        <div className='bookmark-card-modern is-destructive'>
          <div className='icon-container-modern'>{visual}</div>
          <div className='bookmark-editor'>
            <DeleteConfirmation
              title=''
              itemName={data.title}
              onConfirm={handleDeleteConfirm}
              onCancel={() => setMode('normal')}
              type='bookmark'
            />
          </div>
        </div>
      );
    }

    const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (mode !== 'normal') {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
    };

    return (
      <a
        ref={cardRef}
        href={data.url}
        target='_blank'
        rel='noopener noreferrer'
        className={cn('bookmark-card-modern', isSelected && 'card-selected')}
        onClick={handleClick}
        onDoubleClick={event => {
          event.preventDefault();
          event.stopPropagation();
          setMode('editing');
        }}
        onContextMenu={event => onContextMenu?.(event, data)}
        aria-label={t('browser.newTab.openBookmark', { title: data.title })}
        onKeyDown={event => {
          if (event.key === ' ') {
            event.preventDefault();
            window.open(data.url, '_blank');
          }
        }}>
        <div className='icon-container-modern'>{visual}</div>
        <div className='bookmark-item-copy'>
          <span className='card-title-modern' title={data.title}>
            {data.title}
          </span>
          <small>{displayDomain(data.url)}</small>
        </div>
      </a>
    );
  }
);

Link.displayName = 'Link';

export default Link;
