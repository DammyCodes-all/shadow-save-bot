import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { MediaCacheService } from './media-cache.service';
import type { MediaInfo, TikwmResponse } from './download.types';

@Injectable()
export class DownloadService {
	constructor(private readonly mediaCacheService: MediaCacheService) {}

	async getMediaInfo(url: string): Promise<MediaInfo> {
		const cached = await this.mediaCacheService.get(url);
		if (cached) {
			return cached;
		}

		const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;

		let response: Response;
		try {
			response = await fetch(endpoint);
		} catch {
			throw new HttpException(
				'Failed to reach TikWM service',
				HttpStatus.BAD_GATEWAY,
			);
		}

		if (!response.ok) {
			throw new HttpException(
				`TikWM request failed with status ${response.status}`,
				HttpStatus.BAD_GATEWAY,
			);
		}

		const payload = (await response.json()) as TikwmResponse;

		if (payload.code !== 0) {
			throw new HttpException(
				payload.msg ?? 'TikWM failed to process this URL',
				HttpStatus.BAD_REQUEST,
			);
		}

		const data = payload.data;
		if (!data) {
			throw new HttpException('TikWM returned empty data', HttpStatus.BAD_GATEWAY);
		}

		const isSlideshow = Array.isArray(data.images) && data.images.length > 0;

		const mediaInfo: MediaInfo = {
			isSlideshow,
			title: data.title ?? '',
			videoUrl: isSlideshow ? null : (data.play ?? null),
			images: isSlideshow ? data.images! : null,
			music: data.music ?? '',
			author: data.author?.nickname ?? '',
		};

		await this.mediaCacheService.set(url, mediaInfo);

		return mediaInfo;
	}
}
