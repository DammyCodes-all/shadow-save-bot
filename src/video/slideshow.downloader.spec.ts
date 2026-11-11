import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SlideshowDownloader } from './slideshow.downloader';
import type { VideoConfigService } from './video.config';
import { VideoExportError } from './video.types';

function makeDownloader(): SlideshowDownloader {
  const fake = {
    config: {
      maxImageBytes: 12 * 1024 * 1024,
      maxAudioBytes: 25 * 1024 * 1024,
      maxJobBytes: 150 * 1024 * 1024,
      downloadTimeoutMs: 5000,
    },
  } as unknown as VideoConfigService;
  return new SlideshowDownloader(fake);
}

describe('SlideshowDownloader guards', () => {
  it('rejects non-HTTPS image URLs without network access', async () => {
    const downloader = makeDownloader();
    const dir = await fs.mkdtemp(join(tmpdir(), 'dl-test-'));
    try {
      await expect(
        downloader.downloadImages(
          ['http://example.com/1.jpg', 'http://example.com/2.jpg'],
          dir,
          35,
        ),
      ).rejects.toBeInstanceOf(VideoExportError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for audio download failures (silent fallback)', async () => {
    const downloader = makeDownloader();
    const dir = await fs.mkdtemp(join(tmpdir(), 'dl-test-'));
    try {
      await expect(
        downloader.downloadAudio('http://example.com/music.mp3', dir),
      ).resolves.toBeNull();
      await expect(
        downloader.downloadAudio('not-a-url', dir),
      ).resolves.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks loopback hosts', async () => {
    const downloader = makeDownloader();
    const dir = await fs.mkdtemp(join(tmpdir(), 'dl-test-'));
    try {
      await expect(
        downloader.downloadImages(
          ['https://localhost/1.jpg', 'https://localhost/2.jpg'],
          dir,
          35,
        ),
      ).rejects.toMatchObject({ code: 'VIDEO_DOWNLOAD_FAILED' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('requires 2 images by default but allows minCount 1 for still jobs', async () => {
    const downloader = makeDownloader();
    const dir = await fs.mkdtemp(join(tmpdir(), 'dl-test-'));
    try {
      // Default: a single requested image is rejected before any download.
      await expect(
        downloader.downloadImages(['http://example.com/1.jpg'], dir, 35),
      ).rejects.toMatchObject({ code: 'VIDEO_DOWNLOAD_FAILED' });
      // minCount 1: proceeds to download, then fails on the blocked URL.
      await expect(
        downloader.downloadImages(['http://example.com/1.jpg'], dir, 35, 1),
      ).rejects.toMatchObject({ code: 'VIDEO_DOWNLOAD_FAILED' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
