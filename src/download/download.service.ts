import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MediaCacheService } from './media-cache.service';
import type { MediaInfo } from './download.types';
import { SOCIAL_MEDIA_PROVIDERS } from './providers/provider.constants';
import type {
	SocialMediaProvider,
	SocialPlatform,
} from './providers/social-media-provider.interface';

@Injectable()
export class DownloadService {
	constructor(
		private readonly mediaCacheService: MediaCacheService,
		@Inject(SOCIAL_MEDIA_PROVIDERS)
		private readonly providers: SocialMediaProvider[],
	) {}

	async getMediaInfo(url: string): Promise<MediaInfo> {
		const provider = this.findProviderForUrl(url);

		if (!provider) {
			throw new HttpException(
				`Unsupported link. Supported platforms: ${this.getSupportedPlatformsDisplay()}`,
				HttpStatus.BAD_REQUEST,
			);
		}

		const cached = await this.mediaCacheService.get(provider.platform, url);
		if (cached) {
			return cached;
		}

		const mediaInfo = await provider.getMediaInfo(url);
		await this.mediaCacheService.set(provider.platform, url, mediaInfo);

		return mediaInfo;
	}

	detectPlatform(url: string): SocialPlatform | null {
		return this.findProviderForUrl(url)?.platform ?? null;
	}

	getSupportedPlatforms(): SocialPlatform[] {
		return this.providers.map((provider) => provider.platform);
	}

	private findProviderForUrl(url: string): SocialMediaProvider | null {
		const trimmedUrl = url.trim();
		const provider = this.providers.find((item) => item.canHandle(trimmedUrl));
		return provider ?? null;
	}

	private getSupportedPlatformsDisplay(): string {
		return this.getSupportedPlatforms()
			.map((platform) => this.toDisplayName(platform))
			.join(', ');
	}

	private toDisplayName(platform: SocialPlatform): string {
		if (platform === 'tiktok') {
			return 'TikTok';
		}

		if (platform === 'twitter') {
			return 'Twitter/X';
		}

		return platform;
	}
}
