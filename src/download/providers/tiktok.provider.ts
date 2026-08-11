import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { MediaInfo, TikwmResponse } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';

@Injectable()
export class TiktokProvider implements SocialMediaProvider {
  readonly platform = 'tiktok' as const;

  private readonly tiktokUrlPattern =
    /^(https?:\/\/)?(www\.)?(vm\.|vt\.)?tiktok\.com\/.+/i;

  private readonly requestGapMs = 1100;
  private readonly maxRetries = 4;
  private queueTail: Promise<void> = Promise.resolve();

  canHandle(url: string): boolean {
    return this.tiktokUrlPattern.test(url.trim());
  }

  async getMediaInfo(url: string): Promise<MediaInfo> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const payload = await this.throttledFetch(url);

      if (payload?.code === 0) {
        return this.buildMediaInfo(payload);
      }

      if (attempt < this.maxRetries && this.isRateLimitResponse(payload)) {
        await this.delay(1500);
        continue;
      }

      throw new HttpException(
        payload?.msg ?? 'TikWM failed to process this URL',
        HttpStatus.BAD_REQUEST,
      );
    }

    throw new HttpException(
      'TikWM failed to process this URL',
      HttpStatus.BAD_REQUEST,
    );
  }

  private throttledFetch(url: string): Promise<TikwmResponse | null> {
    const request = this.queueTail.then(async () => {
      const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;

      let response: Response;
      try {
        response = await fetch(endpoint);
      } catch {
        throw new HttpException(
          'Failed to reach TikWM service',
          HttpStatus.BAD_GATEWAY,
        );
      }

      if (!response.ok) {
        if (response.status === 429) {
          return null;
        }

        throw new HttpException(
          `TikWM request failed with status ${response.status}`,
          HttpStatus.BAD_GATEWAY,
        );
      }

      return (await response.json()) as TikwmResponse;
    });

    this.queueTail = request.then(
      () => this.delay(this.requestGapMs),
      () => this.delay(this.requestGapMs),
    );

    return request;
  }

  private buildMediaInfo(payload: TikwmResponse): MediaInfo {
    const data = payload.data;
    if (!data) {
      throw new HttpException(
        'TikWM returned empty data',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const isSlideshow = Array.isArray(data.images) && data.images.length > 0;

    return {
      platform: this.platform,
      isSlideshow,
      title: data.title ?? '',
      videoUrl: isSlideshow ? null : (data.play ?? null),
      videoUrls: isSlideshow ? null : data.play ? [data.play] : null,
      images: isSlideshow ? (data.images ?? []) : null,
      music: data.music ?? '',
      author: data.author?.nickname ?? '',
    };
  }

  private isRateLimitResponse(payload: TikwmResponse | null): boolean {
    if (!payload) {
      return true;
    }

    return Boolean(payload.msg && /limit/i.test(payload.msg));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
