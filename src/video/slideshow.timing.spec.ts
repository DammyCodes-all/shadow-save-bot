import {
  computeInstagramTiming,
  computeTikTokTiming,
} from './slideshow.timing';

describe('computeTikTokTiming', () => {
  const base = {
    maxDurationSec: 60,
    minSlideSec: 1.5,
    maxSlideSec: 4,
  };

  it('matches audio length when it fits (10 images, 20s audio)', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 10,
      audioDurationSec: 20,
    });
    expect(timing.style).toBe('tiktok');
    expect(timing.perSlideSec).toBe(2);
    expect(timing.totalSec).toBe(20);
    expect(timing.transitionSec).toBe(0.4);
  });

  it('caps long audio at max slide length (10 images, 60s audio)', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 10,
      audioDurationSec: 60,
    });
    expect(timing.perSlideSec).toBe(4);
    expect(timing.totalSec).toBe(40);
  });

  it('floors short audio at min slide length (10 images, 5s audio)', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 10,
      audioDurationSec: 5,
    });
    expect(timing.perSlideSec).toBe(1.5);
    expect(timing.totalSec).toBe(15);
  });

  it('falls back to 2.5s per slide with no audio', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 8,
      audioDurationSec: null,
    });
    expect(timing.perSlideSec).toBe(2.5);
    expect(timing.totalSec).toBe(20);
  });

  it('uses the full audio duration for a single image', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 1,
      audioDurationSec: 20,
    });
    expect(timing.perSlideSec).toBe(20);
    expect(timing.totalSec).toBe(20);
    expect(timing.transitionSec).toBe(0);
  });

  it('caps single-image audio at max duration', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 1,
      audioDurationSec: 120,
    });
    expect(timing.perSlideSec).toBe(60);
    expect(timing.totalSec).toBe(60);
    expect(timing.transitionSec).toBe(0);
  });

  it('falls back to 2.5s for a single image with no audio', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 1,
      audioDurationSec: null,
    });
    expect(timing.perSlideSec).toBe(2.5);
    expect(timing.totalSec).toBe(2.5);
  });

  it('caps total at max duration (35 images, 120s audio)', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 35,
      audioDurationSec: 120,
    });
    expect(timing.totalSec).toBe(60);
    expect(timing.perSlideSec).toBeCloseTo(60 / 35, 3);
  });

  it('clamps non-positive image counts to 1', () => {
    const timing = computeTikTokTiming({
      ...base,
      imageCount: 0,
      audioDurationSec: null,
    });
    expect(timing.imageCount).toBe(1);
    expect(timing.perSlideSec).toBe(2.5);
    expect(timing.totalSec).toBe(2.5);
  });
});

describe('computeInstagramTiming', () => {
  const base = {
    maxDurationSec: 60,
    secondsPerSlide: 2,
    holdStartSec: 0.5,
  };

  it('computes total and transition for 10 slides', () => {
    const timing = computeInstagramTiming({ ...base, imageCount: 10 });
    expect(timing.style).toBe('instagram');
    expect(timing.perSlideSec).toBe(2);
    expect(timing.totalSec).toBe(20.5);
    expect(timing.holdStartSec).toBe(0.5);
    expect(timing.transitionSec).toBe(0.5);
  });

  it('computes total for 20 slides', () => {
    const timing = computeInstagramTiming({ ...base, imageCount: 20 });
    expect(timing.perSlideSec).toBe(2);
    expect(timing.totalSec).toBe(40.5);
    expect(timing.transitionSec).toBe(0.5);
  });

  it('reduces per-slide time when the cap would be exceeded', () => {
    const timing = computeInstagramTiming({ ...base, imageCount: 40 });
    expect(timing.totalSec).toBeLessThanOrEqual(60);
    expect(timing.perSlideSec).toBeLessThan(2);
    expect(timing.transitionSec).toBeLessThan(0.5);
  });

  it('never drops below the 0.5s floor', () => {
    const timing = computeInstagramTiming({ ...base, imageCount: 200 });
    expect(timing.perSlideSec).toBeGreaterThanOrEqual(0.5);
  });
});
