import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { DownloadService } from './download.service';
import { MediaCacheService } from './media-cache.service.js';
import { TiktokProvider } from './providers/tiktok.provider';
import { TwitterProvider } from './providers/twitter.provider';
import { InstagramProvider } from './providers/instagram.provider';
import { SOCIAL_MEDIA_PROVIDERS } from './providers/provider.constants';

@Module({
  imports: [
    CacheModule.register({
      ttl: 2 * 60 * 60 * 1000,
      namespace: 'tikwm',
    }),
  ],
  providers: [
    DownloadService,
    MediaCacheService,
    TiktokProvider,
    TwitterProvider,
    InstagramProvider,
    {
      provide: SOCIAL_MEDIA_PROVIDERS,
      useFactory: (
        tiktokProvider: TiktokProvider,
        twitterProvider: TwitterProvider,
        instagramProvider: InstagramProvider,
      ) => [tiktokProvider, twitterProvider, instagramProvider],
      inject: [TiktokProvider, TwitterProvider, InstagramProvider],
    },
  ],
  exports: [DownloadService],
})
export class DownloadModule {}
