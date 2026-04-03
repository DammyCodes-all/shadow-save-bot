import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MediaInfo } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';
import type {
  FixTweetMediaItem,
  FixTweetResponse,
  FixTweetVariant,
} from './twitter.types';

@Injectable()
export class TwitterProvider implements SocialMediaProvider {
  readonly platform = 'twitter' as const;

  private readonly logger = new Logger(TwitterProvider.name);
  private readonly maxTelegramVideoSizeBytes = 20 * 1024 * 1024;

  private readonly twitterUrlPattern =
    /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/.+/i;
  private readonly twitterStatusPattern =
    /(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/i;

  canHandle(url: string): boolean {
    return this.twitterUrlPattern.test(url.trim());
  }

  async getMediaInfo(url: string): Promise<MediaInfo> {
    const tweetId = this.extractTweetId(url);
    if (!tweetId) {
      throw new HttpException(
        'Invalid Twitter/X status URL',
        HttpStatus.BAD_REQUEST,
      );
    }

    const endpoint = `https://api.fxtwitter.com/status/${tweetId}`;

    let response: Response;
    try {
      response = await fetch(endpoint);
    } catch {
      throw new HttpException(
        'Failed to reach FixTweet service',
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (!response.ok) {
      throw new HttpException(
        `FixTweet request failed with status ${response.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const payload = (await response.json()) as FixTweetResponse;
    if (payload.code !== 200 || !payload.tweet) {
      throw new HttpException(
        payload.message ?? 'FixTweet failed to process this URL',
        HttpStatus.BAD_REQUEST,
      );
    }

    const mediaItems = payload.tweet.media?.all ?? [];

    if (mediaItems.length === 0) {
      this.logger.warn(
        `FixTweet returned code 200 but no media for tweet ${tweetId}. This can happen for sensitive content that requires Elongator bypass.`,
      );
      throw new HttpException(
        'No media found for this tweet. It may be sensitive, restricted, or unavailable.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const selectedVideoUrl = this.selectBestVideoUrl(mediaItems);
    if (selectedVideoUrl) {
      return {
        platform: this.platform,
        isSlideshow: false,
        title: payload.tweet.text ?? '',
        videoUrl: selectedVideoUrl,
        images: null,
        music: '',
        author:
          payload.tweet.author?.screen_name ?? payload.tweet.author?.name ?? '',
      };
    }

    const images = this.collectPhotoUrls(mediaItems);
    if (images.length > 0) {
      return {
        platform: this.platform,
        isSlideshow: true,
        title: payload.tweet.text ?? '',
        videoUrl: null,
        images,
        music: '',
        author:
          payload.tweet.author?.screen_name ?? payload.tweet.author?.name ?? '',
      };
    }

    throw new HttpException(
      'No compatible media found in this tweet',
      HttpStatus.BAD_REQUEST,
    );
  }

  private extractTweetId(url: string): string | null {
    const match = this.twitterStatusPattern.exec(url.trim());
    return match?.[1] ?? null;
  }

  private selectBestVideoUrl(mediaItems: FixTweetMediaItem[]): string | null {
    const videos = mediaItems.filter((item) => item.type === 'video');

    for (const video of videos) {
      const variants = (video.variants ?? [])
        .filter(
          (variant) => variant.content_type === 'video/mp4' && !!variant.url,
        )
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

      const fittingVariant = variants.find(
        (variant) =>
          this.getEstimatedSizeBytes(variant, video.duration) <=
          this.maxTelegramVideoSizeBytes,
      );

      if (fittingVariant?.url) {
        return fittingVariant.url;
      }

      const fallback = variants[variants.length - 1];
      if (fallback?.url) {
        return fallback.url;
      }
    }

    return null;
  }

  private collectPhotoUrls(mediaItems: FixTweetMediaItem[]): string[] {
    return mediaItems
      .filter((item) => item.type === 'photo' && typeof item.url === 'string')
      .map((item) => item.url as string)
      .slice(0, 4);
  }

  private getEstimatedSizeBytes(
    variant: FixTweetVariant,
    durationSeconds?: number,
  ): number {
    if (typeof variant.size_bytes === 'number' && variant.size_bytes > 0) {
      return variant.size_bytes;
    }

    const bitrate = variant.bitrate ?? 0;
    if (!durationSeconds || durationSeconds <= 0 || bitrate <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.round((bitrate * durationSeconds) / 8);
  }
}
