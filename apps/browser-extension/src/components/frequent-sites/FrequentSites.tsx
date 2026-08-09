import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/button';

interface ChromeHistoryItem {
  id?: string;
  url?: string;
  title?: string;
  visitCount?: number;
  lastVisitTime?: number;
}

interface FrequentSite {
  id: string;
  url: string;
  title: string;
  visitCount: number;
  lastVisitTime: number;
  favicon: string;
}

interface FrequentSitesProps {
  maxSites?: number;
  onClose?: () => void;
}

function siteDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const FrequentSites: React.FC<FrequentSitesProps> = ({ maxSites = 8, onClose }) => {
  const [sites, setSites] = useState<FrequentSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getFavicon = useCallback((url: string): string => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    } catch {
      return '';
    }
  }, []);

  const loadFrequentSites = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      if (!chrome.history) {
        setError('浏览器没有开放历史记录');
        return;
      }

      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const historyItems = await new Promise<ChromeHistoryItem[]>((resolve, reject) => {
        chrome.history.search({ text: '', startTime: thirtyDaysAgo, maxResults: 1000 }, results => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(results as ChromeHistoryItem[]);
        });
      });

      const processedSites = historyItems
        .filter(
          item =>
            item.url?.startsWith('http') &&
            !item.url.startsWith('chrome://') &&
            !item.url.startsWith('chrome-extension://') &&
            !item.url.startsWith('moz-extension://') &&
            (item.visitCount ?? 0) > 1
        )
        .sort((left, right) => (right.visitCount ?? 0) - (left.visitCount ?? 0))
        .slice(0, maxSites)
        .map(item => ({
          id: item.id || item.url!,
          url: item.url!,
          title: item.title || siteDomain(item.url!),
          visitCount: item.visitCount || 0,
          lastVisitTime: item.lastVisitTime || 0,
          favicon: getFavicon(item.url!),
        }));

      setSites(processedSites);
    } catch (loadError) {
      console.error('Failed to load frequent sites:', loadError);
      setError('无法加载常用网站');
    } finally {
      setLoading(false);
    }
  }, [getFavicon, maxSites]);

  useEffect(() => {
    void loadFrequentSites();
  }, [loadFrequentSites]);

  const formatLastVisit = (timestamp: number): string => {
    const hours = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} 天前`;
    if (hours > 0) return `${hours} 小时前`;
    return '最近访问';
  };

  return (
    <section className='ev-home-section' aria-labelledby='frequent-sites-title'>
      <div className='ev-section-heading'>
        <div className='ev-section-heading-main'>
          <div>
            <h2 id='frequent-sites-title'>常用网站</h2>
            <p>最近 30 天</p>
          </div>
        </div>
        {onClose && (
          <Button
            variant='ghost'
            size='icon'
            onClick={onClose}
            aria-label='隐藏常用网站'
            title='隐藏常用网站'>
            <X size={14} />
          </Button>
        )}
      </div>

      {loading ? (
        <div className='ev-frequent-grid' aria-busy='true' aria-label='正在加载常用网站'>
          {Array.from({ length: maxSites }).map((_, index) => (
            <div key={index} className='loading-skeleton ev-frequent-skeleton' />
          ))}
        </div>
      ) : error ? (
        <div className='ev-inline-empty' role='status'>
          <span>{error}</span>
          <button type='button' onClick={() => void loadFrequentSites()}>
            重试
          </button>
        </div>
      ) : sites.length === 0 ? (
        <div className='ev-inline-empty' role='status'>
          浏览一段时间后，常用网站会出现在这里。
        </div>
      ) : (
        <div className='ev-frequent-grid'>
          {sites.map(site => (
            <button
              key={site.id}
              type='button'
              onClick={() => window.open(site.url, '_blank')}
              className='ev-frequent-site'
              title={`${site.title} · 访问 ${site.visitCount} 次 · ${formatLastVisit(site.lastVisitTime)}`}>
              <span
                className='ev-frequent-site-icon'
                data-letter={site.title[0]?.toUpperCase() ?? '·'}
                aria-hidden='true'>
                {site.favicon ? (
                  <img
                    src={site.favicon}
                    alt=''
                    onError={event => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  site.title[0]?.toUpperCase()
                )}
              </span>
              <span className='ev-frequent-site-copy'>
                <strong>{site.title}</strong>
                <small>{siteDomain(site.url)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
};

export default FrequentSites;
