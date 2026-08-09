/**
 * 稳定的Favicon获取工具
 * 实现多种fallback策略，确保图标稳定显示
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
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24小时
  private readonly MAX_ATTEMPTS = 3;
  private readonly STORAGE_KEY = 'ev_browser_favicon_cache';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadCacheFromStorage();
  }

  /**
   * 从本地存储恢复缓存，避免每次打开页面都重新探测图标
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
      // 存储不可用时静默降级为纯内存缓存
    }
  }

  /**
   * 延迟写入本地存储，合并短时间内的多次更新
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
      // 存储不可用时静默忽略
    }
  }

  /**
   * 获取favicon URL，使用多种策略
   */
  async getFaviconUrl(url: string): Promise<string> {
    try {
      const domain = new URL(url).hostname;
      const cached = this.getFromCache(domain);

      if (cached) {
        return cached;
      }

      // 尝试多种获取策略
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
        } catch (error) {
          // 静默处理策略失败，继续尝试下一个策略
          continue;
        }
      }

      // 如果所有策略都失败，返回默认图标
      const defaultFavicon = this.getDefaultFavicon();
      this.setCache(domain, defaultFavicon);
      return defaultFavicon;
    } catch (error) {
      // 处理URL解析错误
      console.error(`Invalid URL for favicon: ${url}`, error);
      return this.getDefaultFavicon();
    }
  }

  /**
   * 策略1: Google Favicon服务 (最常用)
   */
  private getFromGoogleFavicon(domain: string): string {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  }

  /**
   * 策略2: DuckDuckGo Favicon服务 (更稳定)
   */
  private getFromDuckDuckGo(domain: string): string {
    return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  }

  /**
   * 策略3: Favicon.io服务
   */
  private getFromFaviconIO(domain: string): string {
    return `https://favicons.githubusercontent.com/${domain}`;
  }

  /**
   * 策略4: 直接从网站获取
   */
  private getFromWebsite(domain: string): string {
    return `https://${domain}/favicon.ico`;
  }

  /**
   * 策略5: 默认图标
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
   * 验证图片是否有效
   */
  private async isValidImage(url: string): Promise<boolean> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;

      // 设置超时
      setTimeout(() => resolve(false), 3000);
    });
  }

  /**
   * 从缓存获取
   */
  getFromCache(domain: string): string | null {
    const cached = this.cache[domain];
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.url;
    }
    return null;
  }

  /**
   * 设置缓存
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
   * 清除过期缓存
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
   * 获取缓存统计
   */
  getCacheStats(): { total: number; domains: string[] } {
    return {
      total: Object.keys(this.cache).length,
      domains: Object.keys(this.cache),
    };
  }
}

// 创建全局实例
export const faviconManager = new FaviconManager();

/**
 * 简化的favicon获取函数
 */
export const getFaviconUrl = (url: string): Promise<string> => {
  return faviconManager.getFaviconUrl(url);
};

/**
 * 预加载favicon
 */
export const preloadFavicon = async (url: string): Promise<void> => {
  try {
    await faviconManager.getFaviconUrl(url);
  } catch (error) {
    console.warn('Failed to preload favicon:', error);
  }
};

/**
 * 批量预加载favicon
 */
export const preloadFavicons = async (urls: string[]): Promise<void> => {
  const promises = urls.map(url => preloadFavicon(url));
  try {
    await Promise.all(promises);
  } catch (error) {
    // 忽略单个favicon加载失败的错误
    console.warn('Some favicons failed to load:', error);
  }
};
