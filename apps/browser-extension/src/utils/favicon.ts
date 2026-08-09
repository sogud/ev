/**
 * Stable favicon resolution.
 * Multiple fallback strategies keep icons rendering reliably.
 */

interface FaviconCache {
  [domain: string]: {
    url: string;
    timestamp: number;
    attempts: number;
  };
}

class FaviconManager {
  private cache: FaviconCache = {};
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h
  private readonly MAX_ATTEMPTS = 3;
  private readonly STORAGE_KEY = 'ev_browser_favicon_cache';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadCacheFromStorage();
  }

  /**
   * Restore the cache from local storage so page opens do not re-probe icons.
   */
  private loadCacheFromStorage(): void {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      chrome.storage.local.get(this.STORAGE_KEY, items => {
        if (chrome.runtime.lastError) return;
        const stored = items?.[this.STORAGE_KEY] as FaviconCache | undefined;
        if (stored) {
          const now = Date.now();
          Object.keys(stored).forEach(domain => {
            if (now - stored[domain].timestamp < this.CACHE_DURATION) {
              this.cache[domain] = stored[domain];
            }
          });
        }
      });
    } catch {
      // Degrade to an in-memory cache when storage is unavailable.
    }
  }

  /**
   * Debounce writes to local storage, coalescing rapid updates.
   */
  private scheduleSaveToStorage(): void {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      if (this.saveTimer !== null) {
        clearTimeout(this.saveTimer);
      }
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        chrome.storage.local.set({ [this.STORAGE_KEY]: this.cache });
      }, 500);
    } catch {
      // Ignore storage failures silently.
    }
  }

  /**
   * Resolve a favicon URL through layered strategies.
   */
  async getFaviconUrl(url: string): Promise<string> {
    try {
      const domain = new URL(url).hostname;
      const cached = this.getFromCache(domain);

      if (cached) {
        return cached;
      }

      // Try each strategy in order.
      const strategies = [
        () => this.getFromGoogleFavicon(domain),
        () => this.getFromDuckDuckGo(domain),
        () => this.getFromFaviconIO(domain),
        () => this.getFromWebsite(domain),
        () => this.getDefaultFavicon(),
      ];

      for (const strategy of strategies) {
        try {
          const faviconUrl = await strategy();
          if (faviconUrl && (await this.isValidImage(faviconUrl))) {
            this.setCache(domain, faviconUrl);
            return faviconUrl;
          }
        } catch {
          // Swallow per-strategy failures and try the next one.
          continue;
        }
      }

      // All strategies failed; return the default icon.
      const defaultFavicon = this.getDefaultFavicon();
      this.setCache(domain, defaultFavicon);
      return defaultFavicon;
    } catch (error) {
      // Handle URL parse errors.
      console.error(`Invalid URL for favicon: ${url}`, error);
      return this.getDefaultFavicon();
    }
  }

  /**
   * Strategy 1: Google favicon service (most common).
   */
  private getFromGoogleFavicon(domain: string): string {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  }

  /**
   * Strategy 2: DuckDuckGo favicon service (more stable).
   */
  private getFromDuckDuckGo(domain: string): string {
    return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  }

  /**
   * Strategy 3: favicon.io service.
   */
  private getFromFaviconIO(domain: string): string {
    return `https://favicons.githubusercontent.com/${domain}`;
  }

  /**
   * Strategy 4: fetch directly from the site.
   */
  private getFromWebsite(domain: string): string {
    return `https://${domain}/favicon.ico`;
  }

  /**
   * Strategy 5: default icon.
   */
  getDefaultFavicon(): string {
    const svg = `
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="8" fill="#F5F5F5"/>
        <path d="M8 12H16V16H8V12Z" fill="#999999"/>
        <path d="M8 18H20V20H8V18Z" fill="#999999"/>
        <path d="M8 14H20V16H8V14Z" fill="#CCCCCC"/>
      </svg>
    `;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }

  /**
   * Validate that an image is usable.
   */
  private async isValidImage(url: string): Promise<boolean> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;

      // Apply a timeout.
      setTimeout(() => resolve(false), 3000);
    });
  }

  /**
   * Cache read.
   */
  getFromCache(domain: string): string | null {
    const cached = this.cache[domain];
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.url;
    }
    return null;
  }

  /**
   * Cache write.
   */
  setCache(domain: string, url: string): void {
    this.cache[domain] = {
      url,
      timestamp: Date.now(),
      attempts: 0,
    };
    this.scheduleSaveToStorage();
  }

  /**
   * Evict expired entries.
   */
  clearExpiredCache(): void {
    const now = Date.now();
    Object.keys(this.cache).forEach(domain => {
      if (now - this.cache[domain].timestamp > this.CACHE_DURATION) {
        delete this.cache[domain];
      }
    });
  }

  /**
   * Cache stats.
   */
  getCacheStats(): { total: number; domains: string[] } {
    return {
      total: Object.keys(this.cache).length,
      domains: Object.keys(this.cache),
    };
  }
}

// Shared instance.
export const faviconManager = new FaviconManager();

/**
 * Simplified favicon lookup.
 */
export const getFaviconUrl = (url: string): Promise<string> => {
  return faviconManager.getFaviconUrl(url);
};

/**
 * Preload a favicon.
 */
export const preloadFavicon = async (url: string): Promise<void> => {
  try {
    await faviconManager.getFaviconUrl(url);
  } catch (error) {
    console.warn('Failed to preload favicon:', error);
  }
};

/**
 * Preload favicons in batch.
 */
export const preloadFavicons = async (urls: string[]): Promise<void> => {
  const promises = urls.map(url => preloadFavicon(url));
  try {
    await Promise.all(promises);
  } catch (error) {
    // Ignore individual preload failures.
    console.warn('Some favicons failed to load:', error);
  }
};
