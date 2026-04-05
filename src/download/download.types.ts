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

export type InstagramMediaDetails = {
  type: 'video' | 'image';
  dimensions: {
    height: string;
    width: string;
  };
  video_view_count: number;
  url: string;
  thumbnail: string;
};

export type InstagramPostInfo = {
  owner_username: string;
  owner_fullname: string;
  is_verified: boolean;
  is_private: boolean;
  likes: number;
  is_ad: boolean;
};

export type InstagramResponse = {
  results_number: number;
  post_info: InstagramPostInfo;
  url_list: string[];
  media_details: InstagramMediaDetails[];
};
