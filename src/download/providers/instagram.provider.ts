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

interface InstagramUrlDirectRawResponse {
  resources?: InstagramMedia[];
  caption?: string;
  owner?: {
    username?: string;
    name?: string;
    fullname?: string;
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
      const payload = (await instagramGetUrl(url.trim())) as unknown;
      const normalized = this.normalizeResponse(payload);

      if (normalized.url_list.length === 0) {
        throw new HttpException(
          'Failed to retrieve Instagram media information',
          HttpStatus.BAD_REQUEST,
        );
      }

      const videoUrls = normalized.media_details
        .filter((item) => item.type === 'video' && item.url)
        .map((item) => item.url);
      const imageUrls = normalized.media_details
        .filter((item) => item.type === 'image' && item.url)
        .map((item) => item.url);

      const fallbackVideoUrls =
        videoUrls.length > 0
          ? videoUrls
          : normalized.url_list.filter((item) => this.looksLikeVideoUrl(item));
      const fallbackImageUrls =
        imageUrls.length > 0
          ? imageUrls
          : normalized.url_list.filter((item) => this.looksLikeImageUrl(item));
      const firstAvailableUrl = normalized.url_list[0] ?? null;

      const mediaCount =
        normalized.media_details.length > 0
          ? normalized.media_details.length
          : normalized.url_list.length;
      const isSlideshow = mediaCount > 1;

      return {
        platform: this.platform,
        isSlideshow,
        title: normalized.post_info.caption ?? '',
        videoUrl:
          fallbackVideoUrls[0] ??
          (fallbackImageUrls.length === 0 ? firstAvailableUrl : null),
        videoUrls:
          fallbackVideoUrls.length > 0
            ? fallbackVideoUrls
            : firstAvailableUrl && fallbackImageUrls.length === 0
              ? [firstAvailableUrl]
              : null,
        images: fallbackImageUrls.length > 0 ? fallbackImageUrls : null,
        music: '',
        author: normalized.post_info.owner_username,
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
      const payload = (await instagramGetUrl(url.trim())) as unknown;
      return this.normalizeResponse(payload);
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

  private normalizeResponse(payload: unknown): InstagramResponse {
    if (this.isNormalizedResponse(payload)) {
      return {
        results_number: Number.isFinite(payload.results_number)
          ? payload.results_number
          : payload.media_details.length,
        post_info: {
          owner_username: payload.post_info.owner_username ?? '',
          owner_fullname: payload.post_info.owner_fullname ?? '',
          is_verified: payload.post_info.is_verified ?? false,
          is_private: payload.post_info.is_private ?? false,
          likes: payload.post_info.likes ?? 0,
          is_ad: payload.post_info.is_ad ?? false,
          caption: payload.post_info.caption,
        },
        url_list: payload.url_list.filter((item) => typeof item === 'string'),
        media_details: payload.media_details.map((item) => ({
          type: item.type === 'video' ? 'video' : 'image',
          dimensions: {
            height: item.dimensions?.height ?? '0',
            width: item.dimensions?.width ?? '0',
          },
          video_view_count: item.video_view_count ?? 0,
          url: item.url ?? '',
          thumbnail: item.thumbnail ?? item.url ?? '',
        })),
      };
    }

    if (this.isRawResponse(payload)) {
      const mediaDetails = (payload.resources ?? []).map((resource) => ({
        type: (resource.type === 'video' ? 'video' : 'image') as
          | 'video'
          | 'image',
        dimensions: {
          height: String(resource.height ?? 0),
          width: String(resource.width ?? 0),
        },
        video_view_count: resource.video_view_count ?? 0,
        url: resource.src ?? '',
        thumbnail: resource.preview ?? resource.src ?? '',
      }));

      return {
        results_number: mediaDetails.length,
        post_info: {
          owner_username: payload.owner?.username ?? '',
          owner_fullname: payload.owner?.fullname ?? payload.owner?.name ?? '',
          is_verified: payload.owner?.is_verified ?? false,
          is_private: payload.owner?.is_private ?? false,
          likes: payload.likes ?? 0,
          is_ad: payload.is_ad ?? false,
          caption: payload.caption,
        },
        url_list: mediaDetails.map((item) => item.url).filter(Boolean),
        media_details: mediaDetails,
      };
    }

    throw new HttpException(
      'Instagram response format is not supported',
      HttpStatus.BAD_GATEWAY,
    );
  }

  private isRawResponse(
    payload: unknown,
  ): payload is InstagramUrlDirectRawResponse {
    if (!this.isRecord(payload)) {
      return false;
    }

    return 'resources' in payload || 'owner' in payload || 'caption' in payload;
  }

  private isNormalizedResponse(payload: unknown): payload is InstagramResponse {
    if (!this.isRecord(payload)) {
      return false;
    }

    if (
      !Array.isArray(payload.url_list) ||
      !Array.isArray(payload.media_details)
    ) {
      return false;
    }

    return this.isRecord(payload.post_info);
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
  }

  private looksLikeVideoUrl(url: string): boolean {
    return /\.mp4(\?|$)|\.m3u8(\?|$)/i.test(url);
  }

  private looksLikeImageUrl(url: string): boolean {
    return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
  }
}
