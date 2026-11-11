import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { VideoConfigService } from './video.config';
import { VideoExportError } from './video.types';

type PendingJob = {
  userId: number;
  job: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

@Injectable()
export class VideoRenderQueue implements OnModuleDestroy {
  private readonly logger = new Logger(VideoRenderQueue.name);
  private activeCount = 0;
  private readonly activeUsers = new Set<number>();
  private readonly pending: PendingJob[] = [];
  private readonly lastRun = new Map<number, number>();

  constructor(private readonly videoConfig: VideoConfigService) {}

  enqueue<T>(userId: number, job: () => Promise<T>): Promise<T> {
    const config = this.videoConfig.config;
    if (
      this.activeUsers.has(userId) ||
      this.pending.some((p) => p.userId === userId)
    ) {
      throw new VideoExportError(
        'VIDEO_ALREADY_RENDERING',
        'You already have a video rendering. Please wait for it to finish.',
      );
    }
    const last = this.lastRun.get(userId);
    if (last !== undefined && config.userCooldownSec > 0) {
      const elapsedSec = (Date.now() - last) / 1000;
      if (elapsedSec < config.userCooldownSec) {
        const retrySec = Math.max(
          1,
          Math.ceil(config.userCooldownSec - elapsedSec),
        );
        throw new VideoExportError(
          'VIDEO_COOLDOWN',
          `Please wait ${retrySec}s before rendering another video.`,
        );
      }
    }
    if (
      this.activeCount >= config.maxConcurrency &&
      this.pending.length >= config.maxQueue
    ) {
      throw new VideoExportError(
        'VIDEO_QUEUE_FULL',
        'Lots of videos are rendering right now. Try again in a minute.',
      );
    }
    return new Promise<T>((resolve, reject) => {
      const entry: PendingJob = {
        userId,
        job,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (this.activeCount < config.maxConcurrency) {
        void this.start(entry);
      } else {
        this.pending.push(entry);
      }
    });
  }

  onModuleDestroy(): void {
    const pending = this.pending.splice(0, this.pending.length);
    for (const entry of pending) {
      entry.reject(
        new VideoExportError(
          'VIDEO_UNAVAILABLE',
          'Video export is shutting down. Please try again later.',
        ),
      );
    }
  }

  private async start(entry: PendingJob): Promise<void> {
    this.activeCount += 1;
    this.activeUsers.add(entry.userId);
    try {
      const result = await entry.job();
      entry.resolve(result);
    } catch (err) {
      entry.reject(err);
    } finally {
      this.lastRun.set(entry.userId, Date.now());
      this.activeUsers.delete(entry.userId);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.pumpNext();
    }
  }

  private pumpNext(): void {
    const config = this.videoConfig.config;
    while (
      this.activeCount < config.maxConcurrency &&
      this.pending.length > 0
    ) {
      const next = this.pending.shift();
      if (next) {
        void this.start(next);
      }
    }
    if (this.pending.length === 0 && this.activeCount === 0) {
      this.logger.debug('Video render queue drained');
    }
  }
}
