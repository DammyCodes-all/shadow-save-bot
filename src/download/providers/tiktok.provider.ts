import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { MediaInfo, TikwmResponse } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';

@Injectable()
export class TiktokProvider implements SocialMediaProvider {
  readonly platform = 'tiktok' as const;

  private readonly tiktokUrlPattern =
    /^(https?:\/\/)?(www\.)?(vm\.|vt\.)?tiktok\.com\/.+/i;

  canHandle(url: string): boolean {
    return this.tiktokUrlPattern.test(url.trim());
  }

  async getMediaInfo(url: string): Promise<MediaInfo> {
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
      throw new HttpException(
        `TikWM request failed with status ${response.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const payload = (await response.json()) as TikwmResponse;

    if (payload.code !== 0) {
      throw new HttpException(
        payload.msg ?? 'TikWM failed to process this URL',
        HttpStatus.BAD_REQUEST,
      );
    }

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
      videoUrls: isSlideshow ? null : (data.play ? [data.play] : null),
      images: isSlideshow ? (data?.images ?? []) : null,
      music: data.music ?? '',
      author: data.author?.nickname ?? '',
    };
  }
}
