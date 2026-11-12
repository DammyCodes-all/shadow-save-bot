import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import sharp from 'sharp';
import { VideoExportError } from './video.types';

const BACKGROUND = '#0B0B0F';
const JPEG_QUALITY = 86;

@Injectable()
export class ImageNormalizer {
  private readonly logger = new Logger(ImageNormalizer.name);

  constructor() {
    sharp.cache(false);
    sharp.concurrency(1);
  }

  async normalizeAll(
    inputs: string[],
    dir: string,
    width: number,
    height: number,
  ): Promise<string[]> {
    const outputs: string[] = [];
    let outputIndex = 0;
    for (const input of inputs) {
      const output = join(
        dir,
        `norm-${String(outputIndex).padStart(3, '0')}.jpg`,
      );
      try {
        await sharp(input, {
          failOn: 'none',
          limitInputPixels: 50_000_000,
          sequentialRead: true,
        })
          .rotate()
          .resize(width, height, {
            fit: 'contain',
            background: BACKGROUND,
            withoutEnlargement: false,
          })
          // Baseline JPEG on purpose: mozjpeg writes progressive scans, and
          // ffmpeg's mjpeg decoder rejects some tiny progressive files
          // (e.g. near-flat dark frames, common in real slideshows),
          // which would fail the entire render on one image.
          .jpeg({ quality: JPEG_QUALITY })
          .toFile(output);
        outputs.push(output);
        outputIndex += 1;
      } catch (err) {
        this.logger.warn(
          `Skipping image that failed to normalize (${(err as Error).message})`,
        );
      }
    }
    // A single image with no audio is just a still frame, so multi-image
    // jobs always need 2+. A single TikTok image with music becomes a
    // still-over-audio video instead.
    const minRequired = inputs.length >= 2 ? 2 : 1;
    if (outputs.length < minRequired) {
      throw new VideoExportError(
        'VIDEO_RENDER_FAILED',
        'Could not process enough images to build a video.',
      );
    }
    return outputs;
  }
}
