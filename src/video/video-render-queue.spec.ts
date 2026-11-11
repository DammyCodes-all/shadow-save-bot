import type { VideoConfigService } from './video.config';
import { VideoRenderQueue } from './video-render-queue';
import { VideoExportError } from './video.types';

function makeQueue(
  overrides: {
    maxConcurrency?: number;
    maxQueue?: number;
    userCooldownSec?: number;
  } = {},
): VideoRenderQueue {
  const fake = {
    config: {
      maxConcurrency: 1,
      maxQueue: 1,
      userCooldownSec: 30,
      ...overrides,
    },
  } as unknown as VideoConfigService;
  return new VideoRenderQueue(fake);
}

function deferred<T = string>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('VideoRenderQueue', () => {
  it('starts immediately when a slot is free', async () => {
    const queue = makeQueue();
    await expect(queue.enqueue(1, async () => 'ok')).resolves.toBe('ok');
    queue.onModuleDestroy();
  });

  it('enforces the concurrency limit and runs queued jobs FIFO', async () => {
    const queue = makeQueue({ maxConcurrency: 1, maxQueue: 5 });
    const started: number[] = [];
    const first = deferred();
    const p1 = queue.enqueue(1, () => {
      started.push(1);
      return first.promise;
    });
    const p2 = queue.enqueue(2, async () => {
      started.push(2);
      return 'second';
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1]);
    first.resolve('first');
    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('second');
    expect(started).toEqual([1, 2]);
    queue.onModuleDestroy();
  });

  it('rejects when active and queue are full', async () => {
    const queue = makeQueue({ maxConcurrency: 1, maxQueue: 1 });
    const first = deferred();
    const p1 = queue.enqueue(1, () => first.promise);
    const p2 = queue.enqueue(2, async () => 'queued');
    expect(() => queue.enqueue(3, async () => 'x')).toThrow(VideoExportError);
    try {
      queue.enqueue(3, async () => 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as VideoExportError).code).toBe('VIDEO_QUEUE_FULL');
    }
    first.resolve('first');
    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('queued');
    queue.onModuleDestroy();
  });

  it('rejects a second active job from the same user', async () => {
    const queue = makeQueue({ maxConcurrency: 2, maxQueue: 5 });
    const first = deferred();
    const p1 = queue.enqueue(7, () => first.promise);
    try {
      queue.enqueue(7, async () => 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as VideoExportError).code).toBe('VIDEO_ALREADY_RENDERING');
    }
    first.resolve('done');
    await expect(p1).resolves.toBe('done');
    queue.onModuleDestroy();
  });

  it('applies a cooldown after completion', async () => {
    const queue = makeQueue({
      maxConcurrency: 1,
      maxQueue: 5,
      userCooldownSec: 30,
    });
    await expect(queue.enqueue(9, async () => 'ok')).resolves.toBe('ok');
    try {
      queue.enqueue(9, async () => 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as VideoExportError).code).toBe('VIDEO_COOLDOWN');
      expect((err as Error).message).toMatch(/\d+s/);
    }
    queue.onModuleDestroy();
  });

  it('releases the slot when a job fails and the next job still runs', async () => {
    const queue = makeQueue({ maxConcurrency: 1, maxQueue: 5 });
    const failing = queue.enqueue(1, async () => {
      throw new Error('boom');
    });
    const p2 = queue.enqueue(2, async () => 'recovered');
    await expect(failing).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('recovered');
    queue.onModuleDestroy();
  });

  it('rejects pending jobs on destroy', async () => {
    const queue = makeQueue({ maxConcurrency: 1, maxQueue: 5 });
    const first = deferred();
    const p1 = queue.enqueue(1, () => first.promise);
    const p2 = queue.enqueue(2, async () => 'never');
    queue.onModuleDestroy();
    await expect(p2).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
    first.resolve('first');
    await expect(p1).resolves.toBe('first');
  });
});
