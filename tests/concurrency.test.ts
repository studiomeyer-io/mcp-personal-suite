import { describe, it, expect } from 'vitest';
import { createLimiter } from '../src/lib/concurrency.js';

describe('createLimiter', () => {
  it('never exceeds the configured concurrency', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;

    const jobs = Array.from({ length: 20 }, () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    );
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
  });

  it('returns values from the callback', async () => {
    const limit = createLimiter(2);
    const [a, b, c] = await Promise.all([
      limit(async () => 1),
      limit(async () => 2),
      limit(async () => 3),
    ]);
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  it('frees its slot when the callback throws', async () => {
    const limit = createLimiter(1);
    let ran = 0;

    await Promise.allSettled([
      limit(async () => {
        ran++;
        throw new Error('boom');
      }),
      limit(async () => {
        ran++;
      }),
    ]);
    expect(ran).toBe(2);
    expect(limit.activeCount).toBe(0);
    expect(limit.pendingCount).toBe(0);
  });

  it('exposes activeCount + pendingCount + concurrency', async () => {
    const limit = createLimiter(2);
    const first = limit(() => new Promise<void>((r) => setTimeout(r, 30)));
    const second = limit(() => new Promise<void>((r) => setTimeout(r, 30)));
    const third = limit(() => Promise.resolve());
    // give the microtask queue a tick so the limiter increments active.
    await new Promise((r) => setTimeout(r, 0));
    expect(limit.concurrency).toBe(2);
    expect(limit.activeCount).toBe(2);
    expect(limit.pendingCount).toBe(1);
    await Promise.all([first, second, third]);
  });

  it('dispatches queued callbacks FIFO as slots free', async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    const add = (n: number, delay: number) =>
      limit(async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, delay));
      });

    await Promise.all([add(1, 20), add(2, 5), add(3, 5), add(4, 5)]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('throws on invalid concurrency', () => {
    expect(() => createLimiter(0)).toThrow();
    expect(() => createLimiter(-1)).toThrow();
    expect(() => createLimiter(1.5)).toThrow();
  });
});
