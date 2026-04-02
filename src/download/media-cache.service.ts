import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import type { MediaInfo } from './download.types';

type CacheEntry = {
  insertedAt: number;
};

@Injectable()
export class MediaCacheService implements OnModuleDestroy {
  private readonly ttlMs = 2 * 60 * 60 * 1000;
  private readonly maxEntries = 1000;
  private readonly cleanupIntervalMs = 15 * 60 * 1000;
  private readonly cacheKeys = new Map<string, CacheEntry>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    this.cleanupTimer = setInterval(() => {
      void this.prune();
    }, this.cleanupIntervalMs);

    this.cleanupTimer.unref();
  }

  async get(url: string): Promise<MediaInfo | null> {
    const key = this.getKey(url);
    const cached = await this.cacheManager.get<MediaInfo>(key);

    if (!cached) {
      this.cacheKeys.delete(key);
      return null;
    }

    this.cacheKeys.set(key, { insertedAt: Date.now() });
    return cached;
  }

  async set(url: string, value: MediaInfo): Promise<void> {
    const key = this.getKey(url);
    await this.cacheManager.set(key, value, this.ttlMs);
    this.cacheKeys.set(key, { insertedAt: Date.now() });
    await this.prune();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.cacheManager.clear();
    this.cacheKeys.clear();
  }

  private getKey(url: string): string {
    return `media:${url.trim()}`;
  }

  private async prune(): Promise<void> {
    const now = Date.now();

    for (const [key, entry] of this.cacheKeys.entries()) {
      if (now - entry.insertedAt > this.ttlMs) {
        this.cacheKeys.delete(key);
        await this.cacheManager.del(key);
      }
    }

    while (this.cacheKeys.size > this.maxEntries) {
      const oldestKey = this.cacheKeys.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }

      this.cacheKeys.delete(oldestKey);
      await this.cacheManager.del(oldestKey);
    }
  }
}
