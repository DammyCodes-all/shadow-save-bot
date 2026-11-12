import {
  buildInstagramArgs,
  buildJoinArgs,
  buildMuxAudioArgs,
  buildShrinkArgs,
  buildTikTokArgs,
  buildTikTokStillArgs,
  dotsRowLayout,
  splitIntoSegments,
} from './slideshow.args';

import type { DotsRow } from './slideshow.args';

describe('buildTikTokArgs', () => {
  const images = Array.from(
    { length: 4 },
    (_, index) => `/tmp/job/norm-${String(index).padStart(3, '0')}.jpg`,
  );
  const dotsRows: DotsRow[] = [0, 1, 2, 3].map((slide) => ({
    file: `/tmp/job/dots-${String(slide).padStart(3, '0')}.png`,
    x: 317,
    y: 1170,
    startSec: slide * 2,
    endSec: (slide + 1) * 2,
  }));
  const base = {
    imageFiles: images,
    dotsRows,
    outputFile: '/tmp/job/out.mp4',
    totalSec: 8,
    imageCount: 4,
    perSlideSec: 2,
    transitionSec: 0.4,
    width: 720,
    height: 1280,
    fps: 30,
    preset: 'veryfast',
    crf: 26,
    threads: 2,
  };

  it('builds a swipe chain with audio mapped after the images', () => {
    const args = buildTikTokArgs({ ...base, musicFile: '/tmp/job/music.mp3' });
    expect(args[0]).toBe('-y');
    expect(args).toContain('-stream_loop');
    expect(args).toContain('/tmp/job/music.mp3');
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain(
      '[0:v]format=yuv420p,setsar=1,trim=duration=2.400,setpts=PTS-STARTPTS,fps=30[v0]',
    );
    expect(filter).toContain(
      '[v0][v1]xfade=transition=slideleft:duration=0.400:offset=2.000[vx1]',
    );
    expect(filter).toContain('offset=6.000[vout]');
    expect(args).toContain('4:a:0');
    expect(filter).toContain('[vfinal]');
    expect(filter).not.toContain('drawbox');
    expect(args).toContain(
      'afade=t=in:st=0:d=0.25,afade=t=out:st=7.500:d=0.5',
    );
    expect(args).toContain('8.000');
    expect(args).toContain('+faststart');
    expect(args[args.length - 1]).toBe('/tmp/job/out.mp4');
    expect(args).not.toContain('-an');
    expect(args.filter((a) => a === '-i')).toHaveLength(9);
  });

  it('overlays pinned dot strips with offset windows', () => {
    const args = buildTikTokArgs({ ...base, musicFile: null });
    const filter = args[args.indexOf('-filter_complex') + 1];
    // 4 strip overlays, one per slide; strips carry their own windows.
    expect(filter.match(/overlay=/g)).toHaveLength(4);
    expect(filter).toContain('overlay=317:1170:eof_action=pass:');
    expect(filter).toContain("enable='between(t,0.000,2.000)'");
    expect(filter).toContain("enable='between(t,6.000,8.000)'");
    expect(filter).not.toContain('drawbox');
    // Dots strip inputs are offset to their own windows, not looped fully.
    expect(args.filter((a) => a === '-itsoffset')).toHaveLength(4);
    expect(args).toContain('2.100');
    // 4 images + 4 dot strips, no audio.
    expect(args.filter((a) => a === '-i')).toHaveLength(8);
    expect(args).toContain('-an');
    expect(args).not.toContain('-stream_loop');
  });

  it('uses global dot layouts with segment-local windows', () => {
    const segRows: DotsRow[] = [4, 5, 6].map((slide) => ({
      file: `/tmp/job/dots-${String(slide).padStart(3, '0')}.png`,
      x: 281,
      y: 1170,
      startSec: (slide - 4) * 3,
      endSec: (slide - 3) * 3,
    }));
    const args = buildTikTokArgs({
      ...base,
      imageFiles: images.slice(0, 3),
      dotsRows: segRows,
      imageCount: 7,
      perSlideSec: 3,
      totalSec: 9,
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    // Second segment of a 7-slide show: full 7-dot row strips, shifted to
    // local 0-9s windows; the global highlight position rides along.
    expect(filter).toContain("enable='between(t,0.000,3.000)'");
    expect(filter).toContain("enable='between(t,6.000,9.000)'");
    expect(filter).not.toContain('between(t,9.000,12.000)');
    expect(filter).toContain('overlay=281:1170:eof_action=pass:');
  });

  it('rejects fewer than two images', () => {
    expect(() =>
      buildTikTokArgs({ ...base, imageFiles: images.slice(0, 1) }),
    ).toThrow('at least 2 images');
  });

  it('rejects zero or negative durations', () => {
    expect(() => buildTikTokArgs({ ...base, totalSec: 0 })).toThrow(
      'Invalid render duration',
    );
  });
});

describe('buildTikTokStillArgs', () => {
  const base = {
    imageFile: '/tmp/job/norm-000.jpg',
    outputFile: '/tmp/job/out.mp4',
    totalSec: 20,
    fps: 30,
    preset: 'veryfast',
    crf: 26,
    threads: 2,
  };

  it('loops a single still over the full audio with no dots', () => {
    const args = buildTikTokStillArgs({
      ...base,
      musicFile: '/tmp/job/music.mp3',
    });
    expect(args).toContain('-loop');
    expect(args).toContain('/tmp/job/norm-000.jpg');
    expect(args).toContain('-stream_loop');
    expect(args).toContain('1:a:0');
    expect(args).not.toContain('-filter_complex');
    expect(args).toContain('20.000');
    expect(args[args.length - 1]).toBe('/tmp/job/out.mp4');
  });

  it('uses -an when silent', () => {
    const args = buildTikTokStillArgs({ ...base, musicFile: null });
    expect(args).toContain('-an');
    expect(args).not.toContain('-stream_loop');
  });
});

describe('splitIntoSegments', () => {
  it('keeps small slideshows whole', () => {
    expect(splitIntoSegments(4, 4)).toEqual([4]);
    expect(splitIntoSegments(1, 4)).toEqual([1]);
  });

  it('splits evenly and folds a trailing single back in', () => {
    expect(splitIntoSegments(7, 4)).toEqual([4, 3]);
    expect(splitIntoSegments(9, 4)).toEqual([3, 3, 3]);
    expect(splitIntoSegments(5, 4)).toEqual([3, 2]);
    expect(splitIntoSegments(35, 4)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 3]);
  });

  it('never emits chunks smaller than 2', () => {
    expect(splitIntoSegments(3, 2)).toEqual([3]);
    const cases: Array<[number, number]> = [
      [11, 4],
      [20, 6],
      [35, 10],
    ];
    for (const [total, size] of cases) {
      const sizes = splitIntoSegments(total, size);
      expect(sizes.every((s) => s >= 2)).toBe(true);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
      expect(sizes.every((s) => s <= size)).toBe(true);
    }
  });
});

describe('buildJoinArgs', () => {
  it('concatenates segments with a stream copy', () => {
    const args = buildJoinArgs('/tmp/job/join.txt', '/tmp/job/out.mp4');
    expect(args).toContain('-f');
    expect(args).toContain('concat');
    expect(args).toContain('/tmp/job/join.txt');
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    expect(args).toContain('+faststart');
    expect(args[args.length - 1]).toBe('/tmp/job/out.mp4');
  });
});

describe('buildMuxAudioArgs', () => {
  it('muxes looped audio over the joined video with fades', () => {
    const args = buildMuxAudioArgs({
      videoFile: '/tmp/job/joined.mp4',
      musicFile: '/tmp/job/music.mp3',
      outputFile: '/tmp/job/out.mp4',
      totalSec: 21,
    });
    expect(args).toContain('/tmp/job/joined.mp4');
    expect(args).toContain('-stream_loop');
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    expect(args).toContain('1:a:0');
    expect(args).toContain(
      'afade=t=in:st=0:d=0.25,afade=t=out:st=20.500:d=0.5',
    );
    expect(args).toContain('21.000');
    expect(args[args.length - 1]).toBe('/tmp/job/out.mp4');
  });
});

describe('dotsRowLayout', () => {
  it('centers the full row when everything fits', () => {
    const layout = dotsRowLayout(4, 1, 720, 1280);
    expect(layout).not.toBeNull();
    expect(layout!.xs).toEqual([0, 24, 48, 72]);
    expect(layout!.stripWidth).toBe(86);
    expect(layout!.x).toBe(317);
    expect(layout!.y).toBe(1170);
    expect(layout!.startIndex).toBe(0);
  });

  it('truncates to a sliding window that follows the current slide', () => {
    const first = dotsRowLayout(35, 0, 720, 1280)!;
    expect(first.xs).toHaveLength(27);
    expect(first.startIndex).toBe(0);
    expect(first.x + first.stripWidth).toBeLessThanOrEqual(720);

    const last = dotsRowLayout(35, 34, 720, 1280)!;
    expect(last.xs).toHaveLength(27);
    expect(last.startIndex).toBe(8);
    expect(last.x).toBeGreaterThanOrEqual(0);

    const middle = dotsRowLayout(35, 17, 720, 1280)!;
    expect(middle.startIndex).toBe(4);
  });

  it('returns null for invalid inputs', () => {
    expect(dotsRowLayout(0, 0, 720, 1280)).toBeNull();
    expect(dotsRowLayout(4, 0, 0, 1280)).toBeNull();
  });
});

describe('buildInstagramArgs', () => {
  const images = Array.from(
    { length: 10 },
    (_, index) => `/tmp/job/norm-${String(index).padStart(3, '0')}.jpg`,
  );
  const base = {
    imageFiles: images,
    outputFile: '/tmp/job/out.mp4',
    musicFile: null,
    perSlideSec: 2,
    totalSec: 20.5,
    holdStartSec: 0.5,
    transitionSec: 0.5,
    fps: 30,
    preset: 'veryfast',
    crf: 26,
    threads: 2,
  };

  it('builds a slide-up transition chain instead of a strip crop', () => {
    const args = buildInstagramArgs(base);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain(
      '[0:v]format=yuv420p,setsar=1,trim=duration=3.000,setpts=PTS-STARTPTS,fps=30[v0]',
    );
    expect(filter).toContain('[v0][v1]xfade=transition=slideup:duration=0.500:offset=2.500[vx1]');
    expect(filter).toContain('offset=4.500');
    expect(filter).toContain('offset=18.500[vout]');
    expect(args).toContain('-filter_complex_threads');
    expect(args).toContain('[vout]');
    expect(args).toContain('-an');
    expect(args).toContain('20.500');
    expect(args).toContain('+faststart');
    expect(args).not.toContain('-vf');
    expect(args.filter((arg) => arg === '-i')).toHaveLength(10);
  });

  it('maps the music input after the image inputs', () => {
    const args = buildInstagramArgs({
      ...base,
      musicFile: '/tmp/job/music.mp3',
    });
    expect(args).toContain('-stream_loop');
    expect(args).toContain('10:a:0');
    expect(args).toContain('[vout]');
    expect(args).not.toContain('-an');
  });

  it('rejects fewer than two images', () => {
    expect(() =>
      buildInstagramArgs({ ...base, imageFiles: images.slice(0, 1) }),
    ).toThrow('at least 2 images');
  });
});

describe('buildShrinkArgs', () => {
  it('re-encodes smaller with audio copied', () => {
    const args = buildShrinkArgs('/tmp/job/out.mp4', '/tmp/job/small.mp4', {
      smallerWidth: 540,
      hasAudio: true,
      threads: 2,
    });
    expect(args).toContain('scale=540:-2');
    expect(args).toContain('veryfast');
    expect(args).toContain('32');
    expect(args).toContain('-threads');
    expect(args).toContain('-filter_threads');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args[args.length - 1]).toBe('/tmp/job/small.mp4');
  });

  it('uses -an when silent', () => {
    const args = buildShrinkArgs('/tmp/job/out.mp4', '/tmp/job/small.mp4', {
      smallerWidth: 540,
      hasAudio: false,
      threads: 2,
    });
    expect(args).toContain('-an');
    expect(args).not.toContain('copy');
  });
});
