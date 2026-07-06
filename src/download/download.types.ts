import type { SocialPlatform } from './providers/social-media-provider.interface';

export type TikwmResponse = {
  code: number;
  msg?: string;
  data?: {
    title?: string;
    play?: string;
    images?: string[];
    music?: string;
    author?: {
      nickname?: string;
    };
  };
};

export type MediaInfo = {
  platform: SocialPlatform;
  isSlideshow: boolean;
  title: string;
  videoUrl: string | null;
  videoUrls: string[] | null;
  images: string[] | null;
  music: string;
  author: string;
};
