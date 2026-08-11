import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MediaInfo, TikwmResponse } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';

@Injectable()
export class TiktokProvider implements SocialMediaProvider {
  readonly platform = 'tiktok' as const;

  private readonly logger = new Logger(TiktokProvider.name);

  private readonly tiktokUrlPattern =
    /^(https?:\/\/)?(www\.)?(vm\.|vt\.)?tiktok\.com\/.+/i;

  private readonly requestGapMs = 1100;
  private readonly maxRetries = 4;
  private readonly ssstikUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
  private queueTail: Promise<void> = Promise.resolve();

  canHandle(url: string): boolean {
    return this.tiktokUrlPattern.test(url.trim());
  }

  async getMediaInfo(url: string): Promise<MediaInfo> {
    const tikwmResult = await this.tryTikwm(url);

    if (tikwmResult.ok) {
      return tikwmResult.mediaInfo;
    }

    this.logger.warn(
      `TikWM failed for ${url}, trying SSSTik fallback. Reason: ${tikwmResult.reason}`,
    );

    const fallback = await this.trySsstik(url);
    if (fallback) {
      this.logger.log(`Resolved via SSSTik fallback: ${url}`);
      return fallback;
    }

    throw new HttpException(tikwmResult.reason, HttpStatus.BAD_REQUEST);
  }

  private async tryTikwm(
    url: string,
  ): Promise<
    { ok: true; mediaInfo: MediaInfo } | { ok: false; reason: string }
  > {
    let lastReason = 'TikWM failed to process this URL';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let payload: TikwmResponse | null;

      try {
        payload = await this.throttledFetch(url);
      } catch (error) {
        lastReason =
          error instanceof Error ? error.message : 'TikWM network error';
        this.logger.warn(
          `TikWM request failed for ${url} (attempt ${attempt + 1}/${this.maxRetries + 1}): ${lastReason}`,
        );

        if (attempt < this.maxRetries) {
          await this.delay(1500);
          continue;
        }

        return { ok: false, reason: lastReason };
      }

      if (payload?.code === 0) {
        return { ok: true, mediaInfo: this.buildMediaInfo(payload) };
      }

      lastReason = payload?.msg ?? 'TikWM returned an error response';

      if (attempt < this.maxRetries && this.isRateLimitResponse(payload)) {
        this.logger.warn(
          `TikWM rate limited for ${url} (attempt ${attempt + 1}/${this.maxRetries + 1}): ${lastReason}`,
        );
        await this.delay(1500);
        continue;
      }

      return { ok: false, reason: lastReason };
    }

    return { ok: false, reason: lastReason };
  }

  private async trySsstik(url: string): Promise<MediaInfo | null> {
    try {
      const home = await this.ssstikFetch('https://ssstik.io/', {
        headers: { 'User-Agent': this.ssstikUserAgent },
      });

      const token = this.ssstikToken(home.body);
      if (!token) {
        this.logger.warn('SSSTik fallback: could not extract session token');
        return null;
      }

      const result = await this.ssstikFetch('https://ssstik.io/abc?url=dl', {
        method: 'POST',
        headers: {
          'User-Agent': this.ssstikUserAgent,
          Referer: 'https://ssstik.io/',
          Cookie: home.cookies,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'HX-Request': 'true',
          'HX-Current-URL': 'https://ssstik.io/',
          'HX-Target': 'target',
          'HX-Swap': 'innerHTML',
        },
        body: `id=${encodeURIComponent(url)}&locale=en&tt=${encodeURIComponent(token)}`,
      });

      const videoUrl = this.ssstikDownloadLink(result.body);
      if (!videoUrl) {
        this.logger.warn('SSSTik fallback: no download link in response');
        return null;
      }

      return {
        platform: this.platform,
        isSlideshow: false,
        title: this.ssstikTitle(result.body),
        videoUrl,
        videoUrls: [videoUrl],
        images: null,
        music: '',
        author: '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`SSSTik fallback failed for ${url}: ${message}`);
      return null;
    }
  }

  private async ssstikFetch(
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<{ body: string; cookies: string }> {
    const response = await fetch(url, {
      ...init,
      headers: { Accept: 'text/html', ...init.headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new HttpException(
        `SSSTik request failed with status ${response.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const cookies = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

    return { body: await response.text(), cookies };
  }

  private ssstikToken(html: string): string | null {
    const match = html.match(/s_tt\s*=\s*'([^']+)'/);
    return match ? match[1] : null;
  }

  private ssstikDownloadLink(html: string): string | null {
    const match = html.match(/href="(https:\/\/tikcdn\.io\/ssstik\/[^"]+)"/);
    return match ? match[1] : null;
  }

  private ssstikTitle(html: string): string {
    const match = html.match(/<h2[^>]*>([^<]+)<\/h2>/);
    return match ? match[1].trim() : '';
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
