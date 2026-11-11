import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FfmpegRunner } from './ffmpeg.runner';
import { ImageNormalizer } from './image.normalizer';
import { SlideshowDownloader } from './slideshow.downloader';
import { VideoConfigService } from './video.config';
import { VideoRenderQueue } from './video-render-queue';
import { VideoRenderService } from './video-render.service';
import { VideoRequestStore } from './video-request.store';

@Module({
  imports: [ConfigModule],
  providers: [
    VideoConfigService,
    FfmpegRunner,
    SlideshowDownloader,
    ImageNormalizer,
    VideoRenderQueue,
    VideoRequestStore,
    VideoRenderService,
  ],
  exports: [VideoRenderService, VideoRequestStore],
})
export class VideoModule {}
