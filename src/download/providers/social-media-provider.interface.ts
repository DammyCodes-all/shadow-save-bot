import type { MediaInfo } from '../download.types';

export type SocialPlatform = 'tiktok' | 'twitter';

export interface SocialMediaProvider {
  readonly platform: SocialPlatform;

  canHandle(url: string): boolean;

  getMediaInfo(url: string): Promise<MediaInfo>;
}
