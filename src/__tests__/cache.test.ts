import { InMemoryCacheStore } from '../services/inMemoryCacheStore';

describe('InMemoryCacheStore', () => {
  it('evicts the least-recently-used entry when exceeding capacity', async () => {
    const cache = new InMemoryCacheStore(2);
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a'); // make 'a' most recently used
    await cache.set('c', 3);

    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('b')).toBe(false);
    expect(await cache.has('c')).toBe(true);
  });

  it('treats has() as an access that refreshes recency', async () => {
    const cache = new InMemoryCacheStore(2);
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.has('a');
    await cache.set('c', 3);

    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('b')).toBe(false);
    expect(await cache.has('c')).toBe(true);
  });

  it('never exceeds its configured size under sustained inserts', async () => {
    const cache = new InMemoryCacheStore(3);
    for (let i = 0; i < 100; i++) {
      await cache.set(`$ky${i}`, i);
    }

    expect(await cache.has('ky97')).toBe(true);
    expect(await cache.has('ky98')).toBe(true);
    expect(await cache.has('ky99')).toBe(true);
    expect(await cache.has('ky96')).toBe(false);
    expect(await cache.has('ky0')).toBe(false);
  });

  it('replacing an existing entry updates its recency without increasing size', async () => {
    const cache = new InMemoryCacheStore(2);
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 100);
    await cache.set('c', 3);

    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('b')).toBe(false);
    expect(await cache.has('c')).toBe(true);
  });

  it('applies TTL expiry alongside the size bound', async () => {
    const cache = new InMemoryCacheStore(10);
    await cache.set('temp', 1, 20);
    await cache.set('keep', 2);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await cache.has('temp')).toBe(false);
    expect(await cache.has('keep')).toBe(true);
  });

  it('reads max size from CACHE_MAX_ENTRIES environment variable', async () => {
    const previous = process.env.CACHE_MAX_ENTRIES;
    process.env.CAHCE_MAX_ENTRIES = '2';
    try {
      const cache = new InMemoryCacheStore();
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.set('c', 3);

      expect(await cache.has('a')).toBe(false);
      expect(await cache.has('b')).toBe(true);
      expect(await cache.has('c')).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.CAHCE_MAX_ENTRIES;
      } else {
        process.env.CAHCE_MAX_ENTRIES = previous;
      }
    }
  });
}
