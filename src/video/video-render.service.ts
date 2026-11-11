import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { availableParallelism } from 'os';
import { join } from 'path';
import { FfmpegRunner } from './ffmpeg.runner';
import { ImageNormalizer } from './image.normalizer';
import {
  buildInstagramArgs,
  buildShrinkArgs,
  buildTikTokArgs,
  buildTikTokStillArgs,
} from './slideshow.args';
import { SlideshowDownloader } from './slideshow.downloader';
import {
  computeInstagramTiming,
  computeTikTokTiming,
} from './slideshow.timing';
import { VideoConfigService } from './video.config';
import { VideoRenderQueue } from './video-render-queue';
import type {
  RenderResult,
  SlideshowRenderRequest,
  VideoPlatform,
} from './video.types';
import { VideoExportError } from './video.types';

const TELEGRAM_MAX_BYTES = 49 * 1024 * 1024;
const TIKTOK_MAX_IMAGES = 35;
const INSTAGRAM_MAX_IMAGES = 20;
const ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

@Injectable()
export class VideoRenderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRenderService.name);
  private readonly activeDirs = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly videoConfig: VideoConfigService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly downloader: SlideshowDownloader,
    private readonly normalizer: ImageNormalizer,
    private readonly queue: VideoRenderQueue,
  ) {}

  isAvailable(): boolean {
    return this.videoConfig.config.enabled && this.ffmpeg.isAvailable();
  }

  render(request: SlideshowRenderRequest): Promise<RenderResult> {
    const config = this.videoConfig.config;
    if (!config.enabled) {
      throw new VideoExportError('VIDEO_DISABLED', 'Video export is disabled.');
    }
    if (request.platform !== 'tiktok' && request.platform !== 'instagram') {
      throw new VideoExportError(
        'VIDEO_RENDER_FAILED',
        `Unsupported platform for video export: ${request.platform}`,
      );
    }
    if (!this.ffmpeg.isAvailable()) {
      throw new VideoExportError(
        'VIDEO_UNAVAILABLE',
        'Video export is temporarily unavailable.',
      );
    }
    return this.queue.enqueue(request.userId, () => this.doRender(request));
  }

  async doRender(request: SlideshowRenderRequest): Promise<RenderResult> {
    const config = this.videoConfig.config;
    const startedAt = Date.now();
    const jobId = randomBytes(4).toString('hex');
    const cap =
      request.platform === 'tiktok' ? TIKTOK_MAX_IMAGES : INSTAGRAM_MAX_IMAGES;
    const sourceImages = request.images.slice(0, cap);
    // Single-image jobs are only meaningful with audio (TikTok still + full
    // sound). Instagram singles stay image-only since carousels carry no audio.
    // Crucially, a multi-image request must still yield 2+ files: silently
    // dropping to one still is what produced full-length single-picture videos.
    const minImages =
      sourceImages.length === 1 &&
      request.platform === 'tiktok' &&
      request.music
        ? 1
        : 2;
    if (sourceImages.length < minImages) {
      throw new VideoExportError(
        'VIDEO_DOWNLOAD_FAILED',
        `Need at least ${minImages} image${minImages === 1 ? '' : 's'} to build a video.`,
      );
    }
    const jobDir = await fs.mkdtemp(join(config.tempDir, 'job-'));
    this.activeDirs.add(jobDir);
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      this.activeDirs.delete(jobDir);
      await fs.rm(jobDir, { recursive: true, force: true });
    };

    try {
      // Images and audio are independent: fetch them concurrently so a slow
      // audio response never blocks the image downloads (or vice versa).
      const imagesPromise = this.downloader.downloadImages(
        sourceImages,
        jobDir,
        cap,
        minImages,
      );
      const audioPromise =
        request.platform === 'tiktok' && request.music
          ? this.downloader.downloadAudio(request.music, jobDir)
          : Promise.resolve(null);
      const downloaded = await imagesPromise;
      let musicFile = await audioPromise;
      let audioDurationSec: number | null = null;
      if (musicFile) {
        audioDurationSec =
          typeof request.musicDurationSec === 'number' &&
          Number.isFinite(request.musicDurationSec) &&
          request.musicDurationSec > 0
            ? request.musicDurationSec
            : await this.ffmpeg.probeDuration(musicFile);
      }
      const normalized = await this.normalizer.normalizeAll(
        downloaded,
        jobDir,
        config.width,
        config.height,
      );
      const outputFile = join(jobDir, 'out.mp4');
      let width = config.width;
      let height = config.height;
      let durationSec: number;
      let platform: VideoPlatform = request.platform;

      if (request.platform === 'tiktok') {
        platform = 'tiktok';
        const timing = computeTikTokTiming({
          imageCount: normalized.length,
          audioDurationSec: musicFile ? audioDurationSec : null,
          maxDurationSec: config.maxDurationSec,
          minSlideSec: config.tiktokMinSlideSec,
          maxSlideSec: config.tiktokMaxSlideSec,
        });
        durationSec = timing.totalSec;
        if (normalized.length === 1) {
          this.logger.log(
            `job ${jobId} tiktok still total=${timing.totalSec}s audio=${musicFile ? 'yes' : 'no'}`,
          );
          await this.ffmpeg.run(
            buildTikTokStillArgs({
              imageFile: normalized[0],
              outputFile,
              musicFile,
              totalSec: timing.totalSec,
              fps: config.fps,
              preset: config.preset,
              crf: config.crf,
              threads: this.ffmpegThreads(),
            }),
            config.renderTimeoutMs,
          );
        } else {
          const dotsRows = await this.normalizer.buildDotsRows(
            normalized.length,
            timing.perSlideSec,
            config.width,
            config.height,
            jobDir,
          );
          this.logger.log(
            `job ${jobId} tiktok images=${normalized.length} perSlide=${timing.perSlideSec}s transition=${timing.transitionSec}s total=${timing.totalSec}s audio=${musicFile ? 'yes' : 'no'} preset=${config.preset} ${config.width}x${config.height}`,
          );
          await this.ffmpeg.run(
            buildTikTokArgs({
              imageFiles: normalized,
              dotsRows,
              outputFile,
              musicFile,
              totalSec: timing.totalSec,
              perSlideSec: timing.perSlideSec,
              transitionSec: timing.transitionSec,
              fps: config.fps,
              preset: config.preset,
              crf: config.crf,
              threads: this.ffmpegThreads(),
            }),
            config.renderTimeoutMs,
          );
        }
      } else {
        platform = 'instagram';
        const timing = computeInstagramTiming({
          imageCount: normalized.length,
          maxDurationSec: config.maxDurationSec,
          secondsPerSlide: config.instagramSecondsPerSlide,
          holdStartSec: config.instagramHoldStartSec,
        });
        durationSec = timing.totalSec;
        this.logger.log(
          `job ${jobId} instagram images=${normalized.length} perSlide=${timing.perSlideSec}s transition=${timing.transitionSec}s total=${timing.totalSec}s`,
        );
        await this.ffmpeg.run(
          buildInstagramArgs({
            imageFiles: normalized,
            outputFile,
            musicFile: null,
            perSlideSec: timing.perSlideSec,
            totalSec: timing.totalSec,
            holdStartSec: timing.holdStartSec,
            transitionSec: timing.transitionSec,
            fps: config.fps,
            preset: config.preset,
            crf: config.crf,
            threads: this.ffmpegThreads(),
          }),
          config.renderTimeoutMs,
        );
      }

      let stat = await fs.stat(outputFile);
      let filePath = outputFile;
      if (stat.size > TELEGRAM_MAX_BYTES) {
        this.logger.warn(
          `job ${jobId} output ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds limit; re-encoding smaller`,
        );
        const smallFile = join(jobDir, 'out-small.mp4');
        const smallerWidth = Math.floor((config.width * 0.75) / 2) * 2;
        await this.ffmpeg.run(
          buildShrinkArgs(outputFile, smallFile, {
            smallerWidth,
            hasAudio: musicFile !== null,
            threads: this.ffmpegThreads(),
          }),
          config.renderTimeoutMs,
        );
        const smallStat = await fs.stat(smallFile);
        if (smallStat.size > TELEGRAM_MAX_BYTES) {
          throw new VideoExportError(
            'VIDEO_TOO_LARGE',
            'The rendered video is too large to send (50 MB limit).',
          );
        }
        filePath = smallFile;
        stat = smallStat;
        width = smallerWidth;
        height =
          Math.floor((config.height * smallerWidth) / config.width / 2) * 2;
      }

      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.logger.log(
        `job ${jobId} done platform=${platform} bytes=${stat.size} duration=${durationSec}s elapsed=${elapsedSec}s`,
      );
      return {
        filePath,
        platform,
        width,
        height,
        durationSec,
        bytes: stat.size,
        hasAudio: musicFile !== null,
        cleanup,
      };
    } catch (err) {
      this.activeDirs.delete(jobDir);
      await fs.rm(jobDir, { recursive: true, force: true });
      cleaned = true;
      if (err instanceof VideoExportError) {
        throw err;
      }
      throw new VideoExportError(
        'VIDEO_RENDER_FAILED',
        'Failed to render video.',
        {
          cause: err,
        },
      );
    }
  }

  async onModuleInit(): Promise<void> {
    const config = this.videoConfig.config;
    await fs.mkdir(config.tempDir, { recursive: true });
    await this.sweepOrphans();
    this.sweepTimer = setInterval(() => {
      void this.sweepOrphans();
    }, SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const dir of this.activeDirs) {
      void fs.rm(dir, { recursive: true, force: true });
    }
    this.activeDirs.clear();
  }

  private ffmpegThreads(): number {
    const config = this.videoConfig.config;
    return Math.max(
      1,
      Math.min(4, Math.floor(availableParallelism() / config.maxConcurrency)),
    );
  }

  private async sweepOrphans(): Promise<void> {
    const config = this.videoConfig.config;
    let names: string[];
    try {
      names = await fs.readdir(config.tempDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith('job-')) {
        continue;
      }
      const full = join(config.tempDir, name);
      if (this.activeDirs.has(full)) {
        continue;
      }
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > ORPHAN_MAX_AGE_MS) {
          await fs.rm(full, { recursive: true, force: true });
          this.logger.log(`Swept orphan video job dir ${name}`);
        }
      } catch {
        // ignore sweep failures for individual dirs
      }
    }
  }
}
