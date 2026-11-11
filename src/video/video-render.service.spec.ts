import { buildRenderLadder } from './video-render.service';

describe('buildRenderLadder', () => {
  it('steps down preset, resolution and threads', () => {
    expect(buildRenderLadder('veryfast', 720, 1280, 2)).toEqual([
      { preset: 'veryfast', width: 720, height: 1280, threads: 2 },
      { preset: 'superfast', width: 540, height: 960, threads: 1 },
      { preset: 'ultrafast', width: 480, height: 852, threads: 1 },
    ]);
  });

  it('starts from the configured preset', () => {
    expect(buildRenderLadder('superfast', 720, 1280, 2)).toEqual([
      { preset: 'superfast', width: 720, height: 1280, threads: 2 },
      { preset: 'ultrafast', width: 540, height: 960, threads: 1 },
      { preset: 'ultrafast', width: 480, height: 852, threads: 1 },
    ]);
  });

  it('collapses to fewer rungs when already small', () => {
    expect(buildRenderLadder('ultrafast', 540, 960, 1)).toEqual([
      { preset: 'ultrafast', width: 540, height: 960, threads: 1 },
      { preset: 'ultrafast', width: 404, height: 718, threads: 1 },
    ]);
  });

  it('renders once with no pointless retries at the floor', () => {
    expect(buildRenderLadder('ultrafast', 320, 568, 1)).toEqual([
      { preset: 'ultrafast', width: 320, height: 568, threads: 1 },
    ]);
  });
});
