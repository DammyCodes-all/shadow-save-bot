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

export type RenderRung = {
  preset: string;
  width: number;
  height: number;
  threads: number;
};

const FASTER_PRESET: Record<string, string> = {
  placebo: 'veryslow',
  veryslow: 'slower',
  slower: 'slow',
  slow: 'medium',
  medium: 'fast',
  fast: 'faster',
  faster: 'veryfast',
  veryfast: 'superfast',
  superfast: 'ultrafast',
  ultrafast: 'ultrafast',
};

function stepFasterPreset(preset: string): string {
  return FASTER_PRESET[preset] ?? 'veryfast';
}

/**
 * Automatic step-down ladder: full quality first, then faster + smaller on
 * each ffmpeg failure (OOM, timeout), down to a 480px-wide floor. Retries
 * are bounded (max 3) and no-ops are removed, so an already-minimal config
 * still renders exactly once.
 */
export function buildRenderLadder(
  preset: string,
  width: number,
  height: number,
  threads: number,
): RenderRung[] {
  const widths = [Math.floor(width / 2) * 2];
  const shrunk = Math.floor((width * 0.75) / 2) * 2;
  if (shrunk < widths[0] && shrunk >= 360) {
    widths.push(shrunk);
  }
  if (480 < widths[widths.length - 1] && widths.length < 3) {
    widths.push(480);
  }
  const presets = [preset, stepFasterPreset(preset), 'ultrafast'];
  const ladder: RenderRung[] = [];
  for (let i = 0; i < widths.length; i += 1) {
    const rung: RenderRung = {
      preset: presets[Math.min(i, presets.length - 1)],
      width: widths[i],
      height: Math.floor((height * widths[i]) / width / 2) * 2,
      threads: i === 0 ? threads : 1,
    };
    const last = ladder[ladder.length - 1];
    if (
      !last ||
      last.preset !== rung.preset ||
      last.width !== rung.width ||
      last.height !== rung.height ||
      last.threads !== rung.threads
    ) {
      ladder.push(rung);
    }
  }
  return ladder;
}

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
      const musicFile = await audioPromise;
      let audioDurationSec: number | null = null;
      if (musicFile) {
        audioDurationSec =
          typeof request.musicDurationSec === 'number' &&
          Number.isFinite(request.musicDurationSec) &&
          request.musicDurationSec > 0
            ? request.musicDurationSec
            : await this.ffmpeg.probeDuration(musicFile);
      }
      const ladder = buildRenderLadder(
        config.preset,
        config.width,
        config.height,
        this.ffmpegThreads(),
      );
      // Dots bake into TikTok slideshow frames during normalization (same
      // Sharp pass, no extra decode/encode). Singles and Instagram skip them.
      const bakeDots = request.platform === 'tiktok' && downloaded.length >= 2;
      let normalized = await this.normalizer.normalizeAll(
        downloaded,
        jobDir,
        ladder[0].width,
        ladder[0].height,
        bakeDots,
      );
      const outputFile = join(jobDir, 'out.mp4');
      let width = ladder[0].width;
      let height = ladder[0].height;
      let durationSec: number;
      let platform: VideoPlatform = request.platform;
      let lastError: VideoExportError | null = null;
      for (let attempt = 0; attempt < ladder.length; attempt += 1) {
        const rung = ladder[attempt];
        if (attempt > 0) {
          this.logger.warn(
            `job ${jobId} attempt ${attempt + 1}/${ladder.length}: stepping down to ${rung.preset} ${rung.width}x${rung.height} after ${lastError instanceof VideoExportError ? lastError.code : 'failure'}`,
          );
          normalized = await this.normalizer.normalizeAll(
            downloaded,
            jobDir,
            rung.width,
            rung.height,
            bakeDots,
          );
          width = rung.width;
          height = rung.height;
        }
        try {
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
                  preset: rung.preset,
                  crf: config.crf,
                  threads: rung.threads,
                }),
                config.renderTimeoutMs,
              );
            } else {
              this.logger.log(
                `job ${jobId} tiktok images=${normalized.length} perSlide=${timing.perSlideSec}s transition=${timing.transitionSec}s total=${timing.totalSec}s audio=${musicFile ? 'yes' : 'no'} preset=${rung.preset} ${rung.width}x${rung.height}`,
              );
              await this.ffmpeg.run(
                buildTikTokArgs({
                  imageFiles: normalized,
                  outputFile,
                  musicFile,
                  totalSec: timing.totalSec,
                  perSlideSec: timing.perSlideSec,
                  transitionSec: timing.transitionSec,
                  fps: config.fps,
                  preset: rung.preset,
                  crf: config.crf,
                  threads: rung.threads,
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
                preset: rung.preset,
                crf: config.crf,
                threads: rung.threads,
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
            const smallerWidth = Math.floor((rung.width * 0.75) / 2) * 2;
            await this.ffmpeg.run(
              buildShrinkArgs(outputFile, smallFile, {
                smallerWidth,
                hasAudio: musicFile !== null,
                threads: rung.threads,
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
              Math.floor((rung.height * smallerWidth) / rung.width / 2) * 2;
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
        } catch (attemptErr) {
          if (
            attemptErr instanceof VideoExportError &&
            (attemptErr.code === 'VIDEO_RENDER_FAILED' ||
              attemptErr.code === 'VIDEO_TOO_LARGE') &&
            attempt < ladder.length - 1
          ) {
            this.logger.warn(
              `job ${jobId} attempt ${attempt + 1}/${ladder.length} failed (${attemptErr.code}); will step down and retry`,
            );
            lastError = attemptErr;
            continue;
          }
          throw attemptErr;
        }
      }
      throw (
        lastError ??
        new VideoExportError('VIDEO_RENDER_FAILED', 'Failed to render video.')
      );
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
    // Pinned low on purpose: containers report the host's CPU count, so an
    // uncapped pool oversubscribes throttled vCPUs and each extra x264
    // thread holds its own frame buffers.
    const config = this.videoConfig.config;
    return Math.max(
      1,
      Math.min(2, Math.floor(availableParallelism() / config.maxConcurrency)),
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
