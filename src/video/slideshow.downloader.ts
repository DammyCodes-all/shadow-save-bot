import { Injectable, Logger } from '@nestjs/common';
import { createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import { once } from 'events';
import { lookup } from 'dns/promises';
import { basename, join } from 'path';
import { Agent, type Dispatcher } from 'undici';
import { VideoConfigService } from './video.config';
import { VideoExportError } from './video.types';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 3;
const CONCURRENCY = 6;

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 203 && b === 0 && octets[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIP(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.includes(':')) {
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true;
    if (lower.startsWith('ff')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) {
      return isPrivateIPv4(mapped[1].split('.').map(Number));
    }
    if (lower.startsWith('::ffff:')) return true;
    return false;
  }
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  return isPrivateIPv4(octets);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

@Injectable()
export class SlideshowDownloader {
  private readonly logger = new Logger(SlideshowDownloader.name);
  private ipv4Dispatcher: Dispatcher | null = null;

  constructor(private readonly videoConfig: VideoConfigService) {}

  private getIpv4Dispatcher(): Dispatcher {
    if (!this.ipv4Dispatcher) {
      this.ipv4Dispatcher = new Agent({ connect: { family: 4 } });
    }
    return this.ipv4Dispatcher;
  }

  private buildHeaders(url: string): Record<string, string> {
    const host = hostOf(url);
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    // TikTok/Instagram CDNs sometimes treat referer-less requests as hotlinking.
    if (host.includes('tiktok')) {
      headers.Referer = 'https://www.tiktok.com/';
    } else if (
      host.includes('instagram') ||
      host.includes('fbcdn') ||
      host.includes('cdninstagram')
    ) {
      headers.Referer = 'https://www.instagram.com/';
    }
    return headers;
  }

  async downloadImages(
    urls: string[],
    dir: string,
    maxCount: number,
    minCount = 2,
  ): Promise<string[]> {
    const config = this.videoConfig.config;
    const capped = urls.slice(0, Math.max(0, maxCount));
    if (capped.length < minCount) {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Need at least ${minCount} image${minCount === 1 ? '' : 's'} to build a video.`,
      );
    }
    const shared = { claimed: 0 };
    const results: Array<string | null> = new Array(capped.length).fill(null);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, capped.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= capped.length) {
            return;
          }
          const fileName = `img-${String(index).padStart(3, '0')}.jpg`;
          try {
            results[index] = await this.fetchToFile(
              capped[index],
              join(dir, fileName),
              config.maxImageBytes,
              config.maxJobBytes,
              shared,
            );
          } catch (err) {
            this.logger.warn(
              `Image ${index} download failed for host ${hostOf(capped[index])}: ${(err as Error).message}`,
            );
            results[index] = null;
          }
        }
      },
    );
    await Promise.all(workers);
    const succeeded = results.filter((r): r is string => r !== null);
    if (succeeded.length < minCount) {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        'Could not download enough images to build a video. The images may have expired.',
      );
    }
    if (succeeded.length < capped.length) {
      this.logger.warn(
        `Downloaded ${succeeded.length}/${capped.length} images; continuing with available images`,
      );
    }
    return succeeded;
  }

  async downloadAudio(url: string, dir: string): Promise<string | null> {
    const config = this.videoConfig.config;
    try {
      const shared = { claimed: 0 };
      // Audio files are an order of magnitude bigger than images and stream
      // slower off CDN edges, so they get their own (longer) timeout instead
      // of the image-tuned one.
      return await this.fetchToFile(
        url,
        join(dir, 'music.mp3'),
        config.maxAudioBytes,
        config.maxJobBytes,
        shared,
        config.audioDownloadTimeoutMs,
      );
    } catch (err) {
      this.logger.warn(
        `Audio download failed for host ${hostOf(url)}; continuing without audio: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async fetchToFile(
    url: string,
    destPath: string,
    fileLimit: number,
    jobLimit: number,
    shared: { claimed: number },
    timeoutMs?: number,
  ): Promise<string> {
    const config = this.videoConfig.config;
    const effectiveTimeout = timeoutMs ?? config.downloadTimeoutMs;
    let current = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await this.assertUrlSafe(current);
      response = await this.fetchOnce(current, effectiveTimeout);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        try {
          await response.body?.cancel();
        } catch {
          // ignore cancel failures
        }
        if (!location || hop === MAX_REDIRECTS) {
          throw new VideoExportError(
            'VIDEO_DOWNLOAD_FAILED',
            `Too many redirects downloading from ${hostOf(current)}`,
          );
        }
        current = new URL(location, current).toString();
        response = null;
        continue;
      }
      break;
    }
    if (!response) {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Too many redirects downloading from ${hostOf(url)}`,
      );
    }
    if (!response.ok) {
      const retriable = response.status === 429 || response.status >= 500;
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      if (retriable) {
        await sleep(200 + Math.random() * 300);
        await this.assertUrlSafe(current);
        response = await this.fetchOnce(current, effectiveTimeout);
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            // ignore
          }
          throw new VideoExportError(
            'VIDEO_DOWNLOAD_FAILED',
            `Download failed with status ${response.status} from ${hostOf(current)}`,
          );
        }
      } else {
        throw new VideoExportError(
          'VIDEO_DOWNLOAD_FAILED',
          `Download failed with status ${response.status} from ${hostOf(current)}`,
        );
      }
    }
    if (!response.body) {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Empty response body from ${hostOf(current)}`,
      );
    }
    const partPath = `${destPath}.part`;
    const file = createWriteStream(partPath);
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        shared.claimed += chunk.length;
        if (received > fileLimit) {
          throw new VideoExportError(
            'VIDEO_DOWNLOAD_FAILED',
            `File exceeds size limit from ${hostOf(current)}`,
          );
        }
        if (shared.claimed > jobLimit) {
          throw new VideoExportError(
            'VIDEO_DOWNLOAD_FAILED',
            'Slideshow exceeds the per-job download limit.',
          );
        }
        if (!file.write(chunk)) {
          await once(file, 'drain');
        }
      }
    } catch (err) {
      try {
        file.destroy();
      } catch {
        // ignore
      }
      await fs.rm(partPath, { force: true });
      throw err;
    }
    file.end();
    await once(file, 'finish');
    if (received === 0) {
      await fs.rm(partPath, { force: true });
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Empty file downloaded from ${hostOf(current)}`,
      );
    }
    await fs.rename(partPath, destPath);
    return destPath;
  }

  private async fetchOnce(url: string, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchAttempt(url, timeoutMs, false);
    } catch (err) {
      if (err instanceof VideoExportError) {
        throw err;
      }
      // First attempt uses the default route (often IPv6). Small hosts and
      // VPS networks frequently have broken IPv6 routes to CDN edges, so the
      // retry forces IPv4 before giving up on the file.
      this.logger.debug(
        `Retrying ${hostOf(url)} over IPv4 after: ${(err as Error).message}`,
      );
      await sleep(200 + Math.random() * 300);
      try {
        return await this.fetchAttempt(url, timeoutMs, true);
      } catch (retryErr) {
        throw new VideoExportError(
          'VIDEO_DOWNLOAD_FAILED',
          `Network error downloading from ${hostOf(url)}`,
          { cause: retryErr },
        );
      }
    }
  }

  private async fetchAttempt(
    url: string,
    timeoutMs: number,
    forceIpv4: boolean,
  ): Promise<Response> {
    return fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: this.buildHeaders(url),
      ...(forceIpv4 ? { dispatcher: this.getIpv4Dispatcher() } : {}),
    });
  }

  private async assertUrlSafe(raw: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        'Invalid download URL.',
      );
    }
    if (parsed.protocol !== 'https:') {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Blocked non-HTTPS download from ${parsed.hostname}`,
      );
    }
    if (parsed.port !== '' && parsed.port !== '443') {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Blocked non-standard port for ${parsed.hostname}`,
      );
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Blocked URL with credentials for ${parsed.hostname}`,
      );
    }
    let addresses;
    try {
      addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    } catch {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Could not resolve host ${parsed.hostname}`,
      );
    }
    for (const entry of addresses) {
      if (isPrivateIP(entry.address)) {
        throw new VideoExportError(
          'VIDEO_DOWNLOAD_FAILED',
          `Blocked private-network host ${parsed.hostname}`,
        );
      }
    }
  }
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return basename(raw);
  }
}
