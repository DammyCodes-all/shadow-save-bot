import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ffmpegStatic from 'ffmpeg-static';
import { availableParallelism } from 'os';
import { join } from 'path';
import { tmpdir } from 'os';
import type { VideoConfig } from './video.types';

const X264_PRESETS = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
]);

function readBoolean(
  config: ConfigService,
  name: string,
  fallback: boolean,
): boolean {
  const raw = config.get<string | boolean | number>(name);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  if (typeof raw === 'boolean') {
    return raw;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false)`);
}

function readNumber(
  config: ConfigService,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config.get<string | number>(name);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }

  return value;
}

function readString(
  config: ConfigService,
  name: string,
  fallback: string,
): string {
  const raw = config.get<string | number>(name);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }

  return String(raw).trim();
}

export function loadVideoConfig(config: ConfigService): VideoConfig {
  const cpuCount = Math.max(1, availableParallelism());
  const defaultConcurrency = Math.max(1, Math.min(2, Math.floor(cpuCount / 2)));

  const width = readNumber(config, 'VIDEO_WIDTH', 720, 360, 1080);
  const height = readNumber(config, 'VIDEO_HEIGHT', 1280, 640, 1920);
  const preset = readString(config, 'VIDEO_PRESET', 'veryfast');
  if (!X264_PRESETS.has(preset)) {
    throw new Error(
      `VIDEO_PRESET must be one of: ${Array.from(X264_PRESETS).join(', ')}`,
    );
  }

  const tiktokMinSlideSec = readNumber(
    config,
    'VIDEO_TIKTOK_MIN_SLIDE_SEC',
    1.5,
    0.5,
    10,
  );
  const tiktokMaxSlideSec = readNumber(
    config,
    'VIDEO_TIKTOK_MAX_SLIDE_SEC',
    3,
    0.5,
    15,
  );

  if (tiktokMaxSlideSec < tiktokMinSlideSec) {
    throw new Error(
      'VIDEO_TIKTOK_MAX_SLIDE_SEC must be greater than or equal to VIDEO_TIKTOK_MIN_SLIDE_SEC',
    );
  }

  return {
    enabled: readBoolean(config, 'VIDEO_EXPORT_ENABLED', true),
    ffmpegPath:
      config.get<string>('FFMPEG_PATH')?.trim() || ffmpegStatic || undefined,
    width: Math.floor(width / 2) * 2,
    height: Math.floor(height / 2) * 2,
    fps: readNumber(config, 'VIDEO_FPS', 30, 24, 60),
    crf: readNumber(config, 'VIDEO_CRF', 26, 18, 34),
    preset,
    maxDurationSec: readNumber(config, 'VIDEO_MAX_DURATION_SEC', 60, 5, 120),
    maxConcurrency: readNumber(
      config,
      'VIDEO_MAX_CONCURRENCY',
      defaultConcurrency,
      1,
      4,
    ),
    maxQueue: readNumber(config, 'VIDEO_MAX_QUEUE', 20, 0, 100),
    userCooldownSec: readNumber(config, 'VIDEO_USER_COOLDOWN_SEC', 30, 0, 3600),
    tiktokMinSlideSec,
    tiktokMaxSlideSec,
    instagramSecondsPerSlide: readNumber(
      config,
      'VIDEO_IG_SECONDS_PER_SLIDE',
      2,
      0.5,
      10,
    ),
    instagramHoldStartSec: readNumber(
      config,
      'VIDEO_IG_HOLD_START_SEC',
      0.5,
      0,
      10,
    ),
    maxImageBytes: readNumber(
      config,
      'VIDEO_MAX_IMAGE_BYTES',
      12 * 1024 * 1024,
      1024 * 1024,
      100 * 1024 * 1024,
    ),
    maxAudioBytes: readNumber(
      config,
      'VIDEO_MAX_AUDIO_BYTES',
      25 * 1024 * 1024,
      1024 * 1024,
      200 * 1024 * 1024,
    ),
    maxJobBytes: readNumber(
      config,
      'VIDEO_MAX_JOB_BYTES',
      150 * 1024 * 1024,
      10 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
    downloadTimeoutMs: readNumber(
      config,
      'VIDEO_DOWNLOAD_TIMEOUT_MS',
      20000,
      5000,
      120000,
    ),
    audioDownloadTimeoutMs: readNumber(
      config,
      'VIDEO_AUDIO_DOWNLOAD_TIMEOUT_MS',
      90000,
      5000,
      300000,
    ),
    renderTimeoutMs: readNumber(
      config,
      'VIDEO_RENDER_TIMEOUT_MS',
      120000,
      10000,
      600000,
    ),
    tempDir:
      config.get<string>('VIDEO_TEMP_DIR')?.trim() ||
      join(tmpdir(), 'shadow-save-video'),
  };
}

@Injectable()
export class VideoConfigService {
  readonly config: VideoConfig;

  constructor(configService: ConfigService) {
    this.config = loadVideoConfig(configService);
  }
}
