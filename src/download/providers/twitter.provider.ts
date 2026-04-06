import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MediaInfo } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';
import type {
  FixTweetFormat,
  FixTweetMediaItem,
  FixTweetResponse,
  FixTweetVariant,
} from './twitter.types';

@Injectable()
export class TwitterProvider implements SocialMediaProvider {
  readonly platform = 'twitter' as const;

  private readonly logger = new Logger(TwitterProvider.name);

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

    const mediaItems = this.extractMediaItems(payload);

    if (mediaItems.length === 0) {
      this.logger.warn(
        `FixTweet returned code 200 but no media for tweet ${tweetId}. This can happen for sensitive content that requires Elongator bypass.`,
      );
      throw new HttpException(
        'No media found for this tweet. It may be sensitive, restricted, or unavailable.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const candidateVideoUrls = this.selectVideoUrlsByQuality(mediaItems);
    if (candidateVideoUrls.length > 0) {
      return {
        platform: this.platform,
        isSlideshow: false,
        title: payload.tweet.text ?? '',
        videoUrl: candidateVideoUrls[0],
        videoUrls: candidateVideoUrls,
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
        videoUrls: null,
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

  private extractMediaItems(payload: FixTweetResponse): FixTweetMediaItem[] {
    const media = payload.tweet?.media;

    if (!media) {
      return [];
    }

    const combined = [
      ...(media.all ?? []),
      ...(media.videos ?? []),
      ...(media.photos ?? []),
    ];

    const seenIds = new Set<string>();
    const deduplicated: FixTweetMediaItem[] = [];

    for (const item of combined) {
      if (!item) {
        continue;
      }

      const key =
        item.id ??
        `${item.type ?? 'unknown'}::${item.url ?? ''}::${item.duration ?? 0}`;

      if (seenIds.has(key)) {
        continue;
      }

      seenIds.add(key);
      deduplicated.push(item);
    }

    return deduplicated;
  }

  private selectVideoUrlsByQuality(mediaItems: FixTweetMediaItem[]): string[] {
    const variants = mediaItems
      .filter((item) => item.type === 'video')
      .flatMap((video) => [
        ...(video.variants ?? []),
        ...this.formatsToVariants(video.formats),
      ])
      .filter(
        (variant): variant is FixTweetVariant & { url: string } =>
          variant.content_type === 'video/mp4' &&
          typeof variant.url === 'string',
      )
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

    const dedupedUrls = Array.from(
      new Set(variants.map((variant) => variant.url)),
    );

    if (dedupedUrls.length === 0) {
      return [];
    }

    const preferredCeilingBitrate = 10_000_000;
    const preferred = variants
      .filter((variant) => (variant.bitrate ?? 0) <= preferredCeilingBitrate)
      .map((variant) => variant.url);
    const dedupedPreferred = Array.from(new Set(preferred));

    return dedupedPreferred.length > 0 ? dedupedPreferred : dedupedUrls;
  }

  private formatsToVariants(formats?: FixTweetFormat[]): FixTweetVariant[] {
    if (!formats || formats.length === 0) {
      return [];
    }

    return formats.map((format) => ({
      url: format.url,
      bitrate: format.bitrate,
      content_type: format.container === 'mp4' ? 'video/mp4' : undefined,
    }));
  }

  private collectPhotoUrls(mediaItems: FixTweetMediaItem[]): string[] {
    return mediaItems
      .filter((item) => item.type === 'photo' && typeof item.url === 'string')
      .map((item) => item.url as string)
      .slice(0, 4);
  }
}
