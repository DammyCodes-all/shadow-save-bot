import type { SocialPlatform } from '../download/providers/social-media-provider.interface';

export type VideoPlatform = Extract<SocialPlatform, 'tiktok' | 'instagram'>;

export type SlideshowRenderRequest = {
  userId: number;
  platform: VideoPlatform;
  url: string;
  images: string[];
  music: string | null;
  musicDurationSec: number | null;
  musicTitle: string | null;
  title: string;
  author: string;
};

export type VideoConfig = {
  enabled: boolean;
  ffmpegPath: string | undefined;
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  maxDurationSec: number;
  maxConcurrency: number;
  maxQueue: number;
  userCooldownSec: number;
  tiktokMinSlideSec: number;
  tiktokMaxSlideSec: number;
  instagramSecondsPerSlide: number;
  instagramHoldStartSec: number;
  maxImageBytes: number;
  maxAudioBytes: number;
  maxJobBytes: number;
  downloadTimeoutMs: number;
  audioDownloadTimeoutMs: number;
  renderTimeoutMs: number;
  tempDir: string;
};

export type TikTokTiming = {
  style: 'tiktok';
  imageCount: number;
  perSlideSec: number;
  totalSec: number;
  transitionSec: number;
};

export type InstagramTiming = {
  style: 'instagram';
  imageCount: number;
  perSlideSec: number;
  totalSec: number;
  holdStartSec: number;
  transitionSec: number;
};

export type SlideshowTiming = TikTokTiming | InstagramTiming;

export type RenderResult = {
  filePath: string;
  platform: VideoPlatform;
  width: number;
  height: number;
  durationSec: number;
  bytes: number;
  hasAudio: boolean;
  cleanup: () => Promise<void>;
};

export type VideoErrorCode =
  | 'VIDEO_DISABLED'
  | 'VIDEO_UNAVAILABLE'
  | 'VIDEO_QUEUE_FULL'
  | 'VIDEO_ALREADY_RENDERING'
  | 'VIDEO_COOLDOWN'
  | 'VIDEO_EXPIRED'
  | 'VIDEO_TOO_LARGE'
  | 'VIDEO_RENDER_FAILED'
  | 'VIDEO_DOWNLOAD_FAILED';

export class VideoExportError extends Error {
  constructor(
    readonly code: VideoErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'VideoExportError';
  }
}

export type VideoRequest = {
  token: string;
  userId: number;
  platform: VideoPlatform;
  url: string;
  images: string[];
  music: string | null;
  musicDurationSec: number | null;
  musicTitle: string | null;
  title: string;
  author: string;
  createdAt: number;
};

export type CreateVideoRequest = Omit<VideoRequest, 'token' | 'createdAt'>;
