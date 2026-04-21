/**
 * Zero-dependency concurrency limiter.
 *
 * Motivation: `doDeepSearch` previously ran every search-angle in parallel
 * via `Promise.allSettled`. For `maxRounds = 8` that means 8 simultaneous
 * upstream requests against a single BYOK provider, which (a) blows past
 * Brave's 1 req/s free-tier limit and (b) fans out paid Tavily/Exa calls
 * faster than the user wanted when they asked for "deep" research.
 *
 * `createLimiter(N)` returns a `run(fn)` wrapper that never executes more
 * than N callbacks at the same time. Callers keep their existing
 * `Promise.allSettled` + `.map` shape — only the body is wrapped.
 *
 * Semantics match p-limit: in-flight count is capped, queued work is
 * dispatched FIFO as slots free up, a callback that throws still frees
 * its slot.
 */

export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly concurrency: number;
}

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    const resume = queue.shift();
    if (resume) resume();
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };

  const limiter = run as Limiter;
  Object.defineProperty(limiter, 'activeCount', {
    get: () => active,
  });
  Object.defineProperty(limiter, 'pendingCount', {
    get: () => queue.length,
  });
  Object.defineProperty(limiter, 'concurrency', {
    value: concurrency,
    writable: false,
  });
  return limiter;
}
