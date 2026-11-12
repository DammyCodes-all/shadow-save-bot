import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import sharp from 'sharp';
import { dotsRowLayout } from './slideshow.args';
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
    bakeDots = false,
  ): Promise<string[]> {
    const outputs: string[] = [];
    let outputIndex = 0;
    for (const input of inputs) {
      const output = join(
        dir,
        `norm-${String(outputIndex).padStart(3, '0')}.jpg`,
      );
      try {
        let pipeline = sharp(input, {
          failOn: 'none',
          limitInputPixels: 50_000_000,
          sequentialRead: true,
        })
          .rotate()
          .resize(width, height, {
            fit: 'contain',
            background: BACKGROUND,
            withoutEnlargement: false,
          });
        // Dots go on in the same pipeline: a second decode+encode pass just
        // to stamp dots would double sharp's work per image.
        if (bakeDots) {
          const overlay = this.dotsOverlay(
            inputs.length,
            outputIndex,
            width,
            height,
          );
          if (overlay) {
            pipeline = pipeline.composite([overlay]);
          }
        }
        await pipeline
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

  /**
   * Builds the dot-row overlay for one slide (bright dot on the current
   * slide, dim on the rest, sliding window when truncated). Returns null
   * when dots don't apply. Totals use the requested image count, so a
   * skipped image can only shift the window in the rare failure case —
   * never the dot positions of the images that did process.
   */
  private dotsOverlay(
    total: number,
    slide: number,
    width: number,
    height: number,
  ): { input: Buffer; left: number; top: number } | null {
    if (total < 2) {
      return null;
    }
    const layout = dotsRowLayout(total, slide, width, height);
    if (!layout) {
      return null;
    }
    const radius = layout.diameter / 2;
    const activeOffset = slide - layout.startIndex;
    const circles = layout.xs
      .map(
        (dx, i) =>
          `<circle cx="${dx + radius}" cy="${radius}" r="${radius}" ` +
          `fill="white" fill-opacity="${i === activeOffset ? 1 : 0.35}"/>`,
      )
      .join('');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.stripWidth}" ` +
      `height="${layout.stripHeight}">${circles}</svg>`;
    return { input: Buffer.from(svg), left: layout.x, top: layout.y };
  }
}
