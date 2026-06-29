import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ultraigdl } from 'ultra-igdl';
import type { DownloadResponse } from 'ultra-igdl';
import type { MediaInfo } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';

@Injectable()
export class InstagramProvider implements SocialMediaProvider {
  readonly platform = 'instagram' as const;

  private readonly logger = new Logger(InstagramProvider.name);
  private readonly client: ultraigdl;

  private readonly instagramUrlPattern =
    /^(https?:\/\/)?(www\.)?instagram\.com\/(p|reel|tv|stories)\/.+/i;

  constructor() {
    this.client = new ultraigdl({
      timeoutMs: 30000,
      retries: 2,
      cache: true,
      cookies: process.env.INSTAGRAM_COOKIES,
      sessionId: process.env.INSTAGRAM_SESSION_ID,
    });
  }

  canHandle(url: string): boolean {
    return this.instagramUrlPattern.test(url.trim());
  }

  async getMediaInfo(url: string): Promise<MediaInfo> {
    try {
      const result = await this.client.download(url.trim());

      if (result.code !== 200) {
        throw new HttpException(
          result.message ?? 'Failed to fetch Instagram media',
          this.mapErrorCode(result.code),
        );
      }

      const data = result as DownloadResponse;

      const videos = data.media
        .filter((m) => m.type === 'video')
        .map((m) => m.url);
      const images = data.media
        .filter((m) => m.type === 'image')
        .map((m) => m.url);

      const firstVideo = videos[0] ?? null;
      const isSlideshow = data.media.length > 1;

      return {
        platform: this.platform,
        isSlideshow,
        title: data.caption ?? '',
        videoUrl: firstVideo,
        videoUrls: videos.length > 0 ? videos : null,
        images: images.length > 0 ? images : null,
        music: '',
        author: data.username ?? '',
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`Error fetching Instagram media: ${error}`);
      throw new HttpException(
        'Failed to process Instagram URL',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private mapErrorCode(code: number): HttpStatus {
    switch (code) {
      case 400:
        return HttpStatus.BAD_REQUEST;
      case 403:
        return HttpStatus.FORBIDDEN;
      case 404:
        return HttpStatus.NOT_FOUND;
      case 429:
        return HttpStatus.TOO_MANY_REQUESTS;
      case 504:
        return HttpStatus.GATEWAY_TIMEOUT;
      default:
        return HttpStatus.BAD_GATEWAY;
    }
  }
}
