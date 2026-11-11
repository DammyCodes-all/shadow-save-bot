import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import sharp from 'sharp';
import { dotsRowLayout } from './slideshow.args';
import type { DotsRow } from './slideshow.args';
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

  /**
   * Builds one small overlay strip per slide showing the TikTok progress
   * dots for that moment: fixed-size circles, truncated to a window that
   * follows the current slide, with the current dot bright and the rest dim.
   * Strips are tiny (row-sized, mostly transparent) so decoding one per
   * frame stays cheap.
   */
  async buildDotsRows(
    imageCount: number,
    perSlideSec: number,
    width: number,
    height: number,
    dir: string,
  ): Promise<DotsRow[]> {
    const rows: DotsRow[] = [];
    for (let slide = 0; slide < imageCount; slide += 1) {
      const layout = dotsRowLayout(imageCount, slide, width, height);
      if (!layout) {
        throw new VideoExportError(
          'VIDEO_RENDER_FAILED',
          'Could not lay out progress dots.',
        );
      }
      const radius = layout.diameter / 2;
      const activeOffset = slide - layout.startIndex;
      const circles = layout.xs
        .map((dx, i) => {
          const opacity = i === activeOffset ? 1 : 0.35;
          return (
            `<circle cx="${dx + radius}" cy="${radius}" r="${radius}" ` +
            `fill="white" fill-opacity="${opacity}"/>`
          );
        })
        .join('');
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.stripWidth}" ` +
        `height="${layout.stripHeight}">${circles}</svg>`;
      const file = join(dir, `dots-${String(slide).padStart(3, '0')}.png`);
      try {
        await sharp(Buffer.from(svg)).png().toFile(file);
      } catch (err) {
        throw new VideoExportError('VIDEO_RENDER_FAILED', 'Could not render progress dots.', {
          cause: err,
        });
      }
      rows.push({
        file,
        x: layout.x,
        y: layout.y,
        startSec: slide * perSlideSec,
        endSec: (slide + 1) * perSlideSec,
      });
    }
    return rows;
  }
}
