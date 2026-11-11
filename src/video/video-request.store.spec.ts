import { VideoRequestStore } from './video-request.store';
import type { CreateVideoRequest } from './video.types';

function makeInput(
  overrides: Partial<CreateVideoRequest> = {},
): CreateVideoRequest {
  return {
    userId: 42,
    platform: 'tiktok',
    url: 'https://example.com/post',
    images: ['https://example.com/1.jpg'],
    music: null,
    musicDurationSec: null,
    musicTitle: null,
    title: 'title',
    author: 'author',
    ...overrides,
  };
}

describe('VideoRequestStore', () => {
  let store: VideoRequestStore;

  beforeEach(() => {
    store = new VideoRequestStore();
  });

  afterEach(() => {
    store.onModuleDestroy();
  });

  it('creates an 8-char hex token and returns the request', () => {
    const token = store.create(makeInput());
    expect(token).toMatch(/^[0-9a-f]{8}$/);
    const request = store.get(token);
    expect(request).not.toBeNull();
    expect(request?.userId).toBe(42);
    expect(request?.token).toBe(token);
  });

  it('returns null for unknown tokens', () => {
    expect(store.get('deadbeef')).toBeNull();
  });

  it('expires entries older than 24 hours', () => {
    const token = store.create(makeInput());
    const stored = store.get(token);
    expect(stored).not.toBeNull();
    stored!.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    expect(store.get(token)).toBeNull();
  });

  it('deletes entries', () => {
    const token = store.create(makeInput());
    store.delete(token);
    expect(store.get(token)).toBeNull();
  });

  it('evicts the oldest entry when full', () => {
    const tokens: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      tokens.push(store.create(makeInput({ userId: i })));
    }
    expect(store.get(tokens[0])).not.toBeNull();
    const extra = store.create(makeInput({ userId: 9999 }));
    expect(store.get(tokens[0])).toBeNull();
    expect(store.get(extra)).not.toBeNull();
    const internals = store as unknown as {
      entries: Map<string, unknown>;
    };
    expect(internals.entries.size).toBe(500);
  });
});
