import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { CreateVideoRequest, VideoRequest } from './video.types';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

@Injectable()
export class VideoRequestStore implements OnModuleDestroy {
  private readonly logger = new Logger(VideoRequestStore.name);
  private readonly entries = new Map<string, VideoRequest>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  create(input: CreateVideoRequest): string {
    let token = randomBytes(4).toString('hex');
    while (this.entries.has(token)) {
      token = randomBytes(4).toString('hex');
    }
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.delete(oldest.value);
      }
    }
    const request: VideoRequest = {
      ...input,
      token,
      createdAt: Date.now(),
    };
    this.entries.set(token, request);
    const timer = setTimeout(() => {
      this.delete(token);
    }, TOKEN_TTL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.timers.set(token, timer);
    return token;
  }

  get(token: string): VideoRequest | null {
    const request = this.entries.get(token);
    if (!request) {
      return null;
    }
    if (Date.now() - request.createdAt > TOKEN_TTL_MS) {
      this.delete(token);
      return null;
    }
    return request;
  }

  delete(token: string): void {
    const timer = this.timers.get(token);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(token);
    }
    if (this.entries.delete(token)) {
      this.logger.debug(`Deleted video request ${token}`);
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.entries.clear();
  }
}
