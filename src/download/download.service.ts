import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

type TikwmResponse = {
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

type MediaInfo = {
	isSlideshow: boolean;
	title: string;
	videoUrl: string | null;
	images: string[] | null;
	music: string;
	author: string;
};

@Injectable()
export class DownloadService {
	async getMediaInfo(url: string): Promise<MediaInfo> {
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

		return {
			isSlideshow,
			title: data.title ?? '',
			videoUrl: isSlideshow ? null : (data.play ?? null),
			images: isSlideshow ? data.images! : null,
			music: data.music ?? '',
			author: data.author?.nickname ?? '',
		};
	}
}
