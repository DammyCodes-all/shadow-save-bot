import { VideoExportError } from './video.types';

export type TikTokArgsOptions = {
  imageFiles: string[];
  outputFile: string;
  musicFile?: string | null;
  totalSec: number;
  perSlideSec: number;
  transitionSec: number;
  fps: number;
  preset: string;
  crf: number;
  threads: number;
};

export type TikTokStillArgsOptions = {
  imageFile: string;
  outputFile: string;
  musicFile?: string | null;
  totalSec: number;
  fps: number;
  preset: string;
  crf: number;
  threads: number;
};

export type InstagramArgsOptions = {
  imageFiles: string[];
  outputFile: string;
  musicFile?: string | null;
  perSlideSec: number;
  totalSec: number;
  holdStartSec: number;
  transitionSec: number;
  fps: number;
  preset: string;
  crf: number;
  threads: number;
};

export type ShrinkArgsOptions = {
  smallerWidth: number;
  hasAudio: boolean;
  threads: number;
};

function assertPositiveDuration(totalSec: number): void {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    throw new VideoExportError(
      'VIDEO_RENDER_FAILED',
      `Invalid render duration: ${totalSec}`,
    );
  }
}

function fadeOutStart(totalSec: number): string {
  return (totalSec - 0.5).toFixed(3);
}

/**
 * TikTok-style progress dots: fixed-size circles, one per slide. Like TikTok,
 * the row is truncated to what fits the frame instead of shrinking — when
 * there are more slides than fit, a window follows the current slide so the
 * highlighted dot is always visible.
 */
export const DOTS_DIAMETER = 14;
export const DOTS_SPACING = 24;
export const DOTS_Y_OFFSET = 110;
const DOTS_MAX_WIDTH_RATIO = 0.9;

export type DotsRowLayout = {
  diameter: number;
  spacing: number;
  /** X offsets of each visible dot's left edge, relative to the strip. */
  xs: number[];
  stripWidth: number;
  stripHeight: number;
  /** Frame position of the strip's top-left corner. */
  x: number;
  y: number;
  /** Index (into the slideshow) of the first visible dot. */
  startIndex: number;
};

export function dotsRowLayout(
  imageCount: number,
  current: number,
  width: number,
  height: number,
): DotsRowLayout | null {
  if (
    !Number.isFinite(imageCount) ||
    Math.floor(imageCount) < 1 ||
    !Number.isFinite(current) ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null;
  }
  const count = Math.floor(imageCount);
  const maxRowWidth = width * DOTS_MAX_WIDTH_RATIO;
  const visible = Math.max(
    1,
    Math.floor((maxRowWidth + DOTS_SPACING - DOTS_DIAMETER) / DOTS_SPACING),
  );
  const shown = Math.min(count, visible);
  const clamped = Math.min(Math.max(0, Math.floor(current)), count - 1);
  const startIndex = Math.min(
    Math.max(0, clamped - Math.floor(shown / 2)),
    Math.max(0, count - shown),
  );
  const rowWidth = (shown - 1) * DOTS_SPACING + DOTS_DIAMETER;
  const x = Math.round((width - rowWidth) / 2);
  const y = Math.round(height - DOTS_Y_OFFSET);
  const xs: number[] = [];
  for (let i = 0; i < shown; i += 1) {
    xs.push(i * DOTS_SPACING);
  }
  return {
    diameter: DOTS_DIAMETER,
    spacing: DOTS_SPACING,
    xs,
    stripWidth: rowWidth,
    stripHeight: DOTS_DIAMETER,
    x,
    y,
    startIndex,
  };
}

function videoCodecArgs(
  preset: string,
  crf: number,
  threads: number,
): string[] {
  return [
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    String(crf),
    '-profile:v',
    'main',
    '-level',
    '4.0',
    '-threads',
    String(threads),
    '-filter_threads',
    '1',
    '-pix_fmt',
    'yuv420p',
  ];
}

function audioArgs(
  totalSec: number,
  audioInputIndex: number,
  videoMap?: string,
): string[] {
  const args: string[] = [];
  if (videoMap) {
    args.push('-map', videoMap);
  }
  args.push(
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-map',
    `${audioInputIndex}:a:0`,
    '-af',
    `afade=t=in:st=0:d=0.25,afade=t=out:st=${fadeOutStart(totalSec)}:d=0.5`,
  );
  return args;
}

export function buildTikTokArgs(opts: TikTokArgsOptions): string[] {
  assertPositiveDuration(opts.totalSec);
  assertPositiveDuration(opts.perSlideSec);
  assertPositiveDuration(opts.transitionSec);
  if (opts.imageFiles.length < 2) {
    throw new VideoExportError(
      'VIDEO_RENDER_FAILED',
      'TikTok slideshow export needs at least 2 images.',
    );
  }
  const hasAudio = Boolean(opts.musicFile);
  const lastIndex = opts.imageFiles.length - 1;
  // Input durations absorb the dissolve overlap so the finished video is
  // still exactly perSlideSec per slide (same total as the timing math).
  const durations = opts.imageFiles.map((_, index) =>
    index === lastIndex
      ? opts.perSlideSec
      : opts.perSlideSec + opts.transitionSec,
  );
  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
  ];
  opts.imageFiles.forEach((file, index) => {
    args.push(
      '-loop',
      '1',
      '-framerate',
      String(opts.fps),
      '-t',
      durations[index].toFixed(3),
      '-i',
      file,
    );
  });
  const audioInputIndex = opts.imageFiles.length;
  if (hasAudio) {
    args.push('-stream_loop', '-1', '-i', opts.musicFile as string);
  }
  const filters = opts.imageFiles.map((_, index) => {
    return (
      `[${index}:v]format=yuv420p,setsar=1,` +
      `trim=duration=${durations[index].toFixed(3)},setpts=PTS-STARTPTS,` +
      `fps=${opts.fps}[v${index}]`
    );
  });
  let lastLabel = 'v0';
  let offset = opts.perSlideSec;
  for (let index = 1; index < opts.imageFiles.length; index += 1) {
    const outputLabel = index === lastIndex ? 'vout' : `vx${index}`;
    // TikTok-style swipe: the next photo slides in from the right with a
    // hard edge (pure translate, no cross-fade), like a finger swipe
    // advancing the slideshow. NOTE: the smooth* xfade variants blend the
    // frames, which looks like fading — plain slideleft does not.
    filters.push(
      `[${lastLabel}][v${index}]xfade=transition=slideleft:` +
        `duration=${opts.transitionSec.toFixed(3)}:` +
        `offset=${offset.toFixed(3)}[${outputLabel}]`,
    );
    lastLabel = outputLabel;
    offset += opts.perSlideSec;
  }
  // Dots are baked into the frames by the normalizer, so the filter graph
  // stays a plain xfade chain with no overlay inputs (looped overlay
  // streams cost hundreds of MB of peak RAM via framesync).
  args.push('-filter_complex_threads', '1');
  args.push('-filter_complex', filters.join(';'));
  args.push(...videoCodecArgs(opts.preset, opts.crf, opts.threads));
  if (hasAudio) {
    args.push(...audioArgs(opts.totalSec, audioInputIndex, '[vout]'));
  } else {
    args.push('-map', '[vout]', '-an');
  }
  args.push(
    '-t',
    opts.totalSec.toFixed(3),
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    opts.outputFile,
  );
  return args;
}

export function buildTikTokStillArgs(opts: TikTokStillArgsOptions): string[] {
  assertPositiveDuration(opts.totalSec);
  const hasAudio = Boolean(opts.musicFile);
  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-loop',
    '1',
    '-framerate',
    String(opts.fps),
    '-t',
    opts.totalSec.toFixed(3),
    '-i',
    opts.imageFile,
  ];
  if (hasAudio) {
    args.push('-stream_loop', '-1', '-i', opts.musicFile as string);
  }
  args.push('-vf', `fps=${opts.fps},format=yuv420p,setsar=1`);
  args.push(...videoCodecArgs(opts.preset, opts.crf, opts.threads));
  if (hasAudio) {
    args.push(...audioArgs(opts.totalSec, 1, '0:v:0'));
  } else {
    args.push('-an');
  }
  args.push(
    '-t',
    opts.totalSec.toFixed(3),
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    opts.outputFile,
  );
  return args;
}

export function buildInstagramArgs(opts: InstagramArgsOptions): string[] {
  assertPositiveDuration(opts.totalSec);
  assertPositiveDuration(opts.perSlideSec);
  assertPositiveDuration(opts.transitionSec);
  if (opts.imageFiles.length < 2) {
    throw new VideoExportError(
      'VIDEO_RENDER_FAILED',
      'Instagram video export needs at least 2 images.',
    );
  }
  const hasAudio = Boolean(opts.musicFile);
  const lastIndex = opts.imageFiles.length - 1;
  const durations = opts.imageFiles.map((_, index) => {
    if (index === 0) {
      return opts.holdStartSec + opts.perSlideSec + opts.transitionSec;
    }
    if (index === lastIndex) {
      return opts.perSlideSec;
    }
    return opts.perSlideSec + opts.transitionSec;
  });
  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
  ];
  opts.imageFiles.forEach((file, index) => {
    args.push(
      '-loop',
      '1',
      '-framerate',
      String(opts.fps),
      '-t',
      durations[index].toFixed(3),
      '-i',
      file,
    );
  });
  if (hasAudio) {
    args.push('-stream_loop', '-1', '-i', opts.musicFile as string);
  }
  // Note: fps must come after trim/setpts. trim resets the frame-rate
  // metadata on the filter link and xfade rejects inputs that are not
  // marked as constant frame rate.
  const filters = opts.imageFiles.map((_, index) => {
    return (
      `[${index}:v]format=yuv420p,setsar=1,` +
      `trim=duration=${durations[index].toFixed(3)},setpts=PTS-STARTPTS,` +
      `fps=${opts.fps}[v${index}]`
    );
  });
  let lastLabel = 'v0';
  let offset = opts.holdStartSec + opts.perSlideSec;
  for (let index = 1; index < opts.imageFiles.length; index += 1) {
    const outputLabel = index === lastIndex ? 'vout' : `vx${index}`;
    filters.push(
      `[${lastLabel}][v${index}]xfade=transition=slideup:` +
        `duration=${opts.transitionSec.toFixed(3)}:` +
        `offset=${offset.toFixed(3)}[${outputLabel}]`,
    );
    lastLabel = outputLabel;
    offset += opts.perSlideSec;
  }
  args.push('-filter_complex_threads', '1');
  args.push('-filter_complex', filters.join(';'));
  args.push(...videoCodecArgs(opts.preset, opts.crf, opts.threads));
  if (hasAudio) {
    args.push(...audioArgs(opts.totalSec, opts.imageFiles.length, '[vout]'));
  } else {
    args.push('-map', '[vout]', '-an');
  }
  args.push(
    '-t',
    opts.totalSec.toFixed(3),
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    opts.outputFile,
  );
  return args;
}

export function buildShrinkArgs(
  inputFile: string,
  outputFile: string,
  opts: ShrinkArgsOptions,
): string[] {
  if (!Number.isFinite(opts.smallerWidth) || opts.smallerWidth <= 0) {
    throw new VideoExportError(
      'VIDEO_RENDER_FAILED',
      `Invalid shrink width: ${opts.smallerWidth}`,
    );
  }
  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    inputFile,
    '-vf',
    `scale=${Math.round(opts.smallerWidth)}:-2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '32',
    '-profile:v',
    'main',
    '-level',
    '4.0',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    String(opts.threads),
    '-filter_threads',
    '1',
  ];
  if (opts.hasAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', outputFile);
  return args;
}
