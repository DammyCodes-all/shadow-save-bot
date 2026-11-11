import type { InstagramTiming, TikTokTiming } from './video.types';

export type TikTokTimingOptions = {
  imageCount: number;
  audioDurationSec?: number | null;
  maxDurationSec: number;
  minSlideSec: number;
  maxSlideSec: number;
};

export type InstagramTimingOptions = {
  imageCount: number;
  maxDurationSec: number;
  secondsPerSlide: number;
  holdStartSec: number;
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeCount(imageCount: number): number {
  if (!Number.isFinite(imageCount) || imageCount <= 0) {
    return 1;
  }
  return Math.floor(imageCount);
}

export function computeTikTokTiming(opts: TikTokTimingOptions): TikTokTiming {
  const imageCount = normalizeCount(opts.imageCount);
  const audioDurationSec =
    typeof opts.audioDurationSec === 'number' &&
    Number.isFinite(opts.audioDurationSec) &&
    opts.audioDurationSec > 0
      ? opts.audioDurationSec
      : null;
  // A single image is a still: hold it for the whole sound instead of
  // spreading the audio across slides.
  if (imageCount === 1 && audioDurationSec !== null) {
    const total = Math.min(audioDurationSec, opts.maxDurationSec);
    return {
      style: 'tiktok',
      imageCount,
      perSlideSec: round3(total),
      totalSec: round3(total),
      transitionSec: 0,
    };
  }
  const target =
    audioDurationSec !== null ? audioDurationSec : imageCount * 2.5;
  const perSlide = Math.min(
    Math.max(target / imageCount, opts.minSlideSec),
    opts.maxSlideSec,
  );
  const total = Math.min(perSlide * imageCount, opts.maxDurationSec);
  const finalPerSlide = total / imageCount;
  // Short dissolve between slides; scales with slide length so quick
  // slideshows keep snappy cuts and long ones get a gentler blend.
  const transitionSec = Math.min(
    0.5,
    Math.max(0.2, round3(finalPerSlide * 0.2)),
  );

  return {
    style: 'tiktok',
    imageCount,
    perSlideSec: round3(finalPerSlide),
    totalSec: round3(total),
    transitionSec: round3(transitionSec),
  };
}

export function computeInstagramTiming(
  opts: InstagramTimingOptions,
): InstagramTiming {
  const imageCount = normalizeCount(opts.imageCount);
  const holdStartSec = Math.max(0, opts.holdStartSec);
  const available = (opts.maxDurationSec - holdStartSec) / imageCount;
  const perSlide = Math.max(0.5, Math.min(opts.secondsPerSlide, available));
  const total = Math.min(
    holdStartSec + perSlide * imageCount,
    opts.maxDurationSec,
  );
  const transitionSec = Math.min(0.5, Math.max(0.15, round3(perSlide * 0.25)));

  return {
    style: 'instagram',
    imageCount,
    perSlideSec: round3(perSlide),
    totalSec: round3(total),
    holdStartSec: round3(holdStartSec),
    transitionSec: round3(transitionSec),
  };
}
