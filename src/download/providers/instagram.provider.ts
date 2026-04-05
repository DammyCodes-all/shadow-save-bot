import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { instagramGetUrl } from 'instagram-url-direct';
import type { MediaInfo, InstagramResponse } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';

interface InstagramMedia {
  src: string;
  type: string;
  height?: number;
  width?: number;
  preview?: string;
  video_view_count?: number;
}

interface InstagramUrlDirectResponse {
  resources?: InstagramMedia[];
  caption?: string;
  owner?: {
    username: string;
    name: string;
    is_verified?: boolean;
    is_private?: boolean;
  };
  likes?: number;
  is_ad?: boolean;
}

@Injectable()
export class InstagramProvider implements SocialMediaProvider {
  readonly platform = 'instagram' as const;

  private readonly logger = new Logger(InstagramProvider.name);

  private readonly instagramUrlPattern =
    /^(https?:\/\/)?(www\.)?instagram\.com\/(p|reel|tv|stories)\/.+/i;

  canHandle(url: string): boolean {
    return this.instagramUrlPattern.test(url.trim());
  }

  async getMediaInfo(url: string): Promise<MediaInfo> {
    try {
      const data = (await instagramGetUrl(
        url.trim(),
      )) as InstagramUrlDirectResponse;

      if (!data) {
        throw new HttpException(
          'Failed to retrieve Instagram media information',
          HttpStatus.BAD_REQUEST,
        );
      }

      const urls = this.extractMediaUrls(data);
      if (urls.length === 0) {
        throw new HttpException(
          'No media found in this Instagram post',
          HttpStatus.BAD_REQUEST,
        );
      }

      const isSlideshow = urls.length > 1;

      return {
        platform: this.platform,
        isSlideshow,
        title: data.caption || '',
        videoUrl: this.getFirstVideoUrl(data) || null,
        videoUrls: this.getAllVideoUrls(data) || null,
        images: this.getAllImageUrls(data) || null,
        music: '',
        author: data.owner?.username || '',
      };
    } catch (error) {
      this.logger.error(`Error fetching Instagram media: ${error}`);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        'Failed to process Instagram URL',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async getInstagramResponse(url: string): Promise<InstagramResponse> {
    try {
      const data = (await instagramGetUrl(
        url.trim(),
      )) as InstagramUrlDirectResponse;

      if (!data) {
        throw new HttpException(
          'Failed to retrieve Instagram media information',
          HttpStatus.BAD_REQUEST,
        );
      }

      const mediaDetails = this.buildMediaDetails(data);

      return {
        results_number: mediaDetails.length,
        post_info: {
          owner_username: data.owner?.username || '',
          owner_fullname: data.owner?.name || '',
          is_verified: data.owner?.is_verified || false,
          is_private: data.owner?.is_private || false,
          likes: data.likes || 0,
          is_ad: data.is_ad || false,
        },
        url_list: this.extractMediaUrls(data),
        media_details: mediaDetails,
      };
    } catch (error) {
      this.logger.error(`Error fetching Instagram response: ${error}`);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        'Failed to process Instagram URL',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private buildMediaDetails(
    data: InstagramUrlDirectResponse,
  ): InstagramResponse['media_details'] {
    if (!data.resources || !Array.isArray(data.resources)) {
      return [];
    }

    return data.resources.map((resource) => ({
      type: resource.type === 'video' ? 'video' : 'image',
      dimensions: {
        height: String(resource.height || 0),
        width: String(resource.width || 0),
      },
      video_view_count: resource.video_view_count || 0,
      url: resource.src || '',
      thumbnail: resource.preview || resource.src || '',
    }));
  }

  private extractMediaUrls(data: InstagramUrlDirectResponse): string[] {
    if (!data.resources || !Array.isArray(data.resources)) {
      return [];
    }

    return data.resources.map((resource) => resource.src).filter(Boolean);
  }

  private getFirstVideoUrl(data: InstagramUrlDirectResponse): string | null {
    if (!data.resources || !Array.isArray(data.resources)) {
      return null;
    }

    const videoResource = data.resources.find(
      (resource) => resource.type === 'video',
    );
    return videoResource?.src || null;
  }

  private getAllVideoUrls(data: InstagramUrlDirectResponse): string[] | null {
    if (!data.resources || !Array.isArray(data.resources)) {
      return null;
    }

    const videos = data.resources
      .filter((resource) => resource.type === 'video')
      .map((resource) => resource.src)
      .filter(Boolean);

    return videos.length > 0 ? videos : null;
  }

  private getAllImageUrls(data: InstagramUrlDirectResponse): string[] | null {
    if (!data.resources || !Array.isArray(data.resources)) {
      return null;
    }

    const images = data.resources
      .filter((resource) => resource.type === 'image')
      .map((resource) => resource.src)
      .filter(Boolean);

    return images.length > 0 ? images : null;
  }
}
