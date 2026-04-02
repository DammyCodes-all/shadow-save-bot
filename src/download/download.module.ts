import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { DownloadService } from './download.service';
import { MediaCacheService } from './media-cache.service.js';

@Module({
  imports: [
    CacheModule.register({
      ttl: 2 * 60 * 60 * 1000,
      namespace: 'tikwm',
    }),
  ],
  providers: [DownloadService, MediaCacheService],
  exports: [DownloadService],
})
export class DownloadModule {}
