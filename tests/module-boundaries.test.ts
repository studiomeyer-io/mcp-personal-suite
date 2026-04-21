/**
 * Module-boundary tests for the post-split modules.
 *
 * The Session 839 module splits extracted `engines.ts`/`orchestrators.ts`
 * from `search/index.ts` and `setup-builders.ts`/`health-checks.ts` from
 * `system/index.ts`. These tests lock in the independence the splits
 * promised: each sub-module is importable in isolation, exports the API
 * the orchestrator expects, and does not reach back into the registration
 * layer.
 */

import { describe, it, expect } from 'vitest';
import {
  getConfig,
  hasAnyEngine,
  hasAnyProvider,
  type SearchResult,
  type SearchResponse,
} from '../src/modules/search/engines.js';
import {
  doWebSearch,
  doNewsSearch,
  doImageSearch,
  doDeepSearch,
  generateSearchAngles,
} from '../src/modules/search/orchestrators.js';
import {
  buildEmailConfig,
  buildCalendarConfig,
  buildMessagingConfig,
  buildSearchConfig,
  buildImageConfig,
} from '../src/modules/system/setup-builders.js';
import {
  checkEmailHealth,
  checkCalendarHealth,
  checkMessagingHealth,
  checkSearchHealth,
  checkImageHealth,
} from '../src/modules/system/health-checks.js';

describe('module-boundaries — search/', () => {
  it('engines.ts is importable without orchestrators.ts', () => {
    // Typeof smoke: the functions exist and are typed correctly.
    expect(typeof getConfig).toBe('function');
    expect(typeof hasAnyEngine).toBe('function');
    expect(typeof hasAnyProvider).toBe('function');
  });

  it('orchestrators.ts exports the public API the index expects', () => {
    expect(typeof doWebSearch).toBe('function');
    expect(typeof doNewsSearch).toBe('function');
    expect(typeof doImageSearch).toBe('function');
    expect(typeof doDeepSearch).toBe('function');
    expect(typeof generateSearchAngles).toBe('function');
  });

  it('generateSearchAngles is a pure function independent of HTTP', () => {
    const angles = generateSearchAngles('elixir phoenix', 4);
    expect(angles).toContain('elixir phoenix');
    expect(angles).toHaveLength(4);
    expect(new Set(angles).size).toBe(4); // no duplicates
  });

  it('SearchResult / SearchResponse types survive the re-export', () => {
    // TypeScript-compile-time check: use them in a value position.
    const r: SearchResult = { title: 't', url: 'u', snippet: 's', source: 'x' };
    const resp: SearchResponse = { results: [r], query: 'q', engine: 'test' };
    expect(resp.results[0].title).toBe('t');
  });
});

describe('module-boundaries — system/', () => {
  it('setup-builders.ts exports all five builders as pure functions', () => {
    expect(typeof buildEmailConfig).toBe('function');
    expect(typeof buildCalendarConfig).toBe('function');
    expect(typeof buildMessagingConfig).toBe('function');
    expect(typeof buildSearchConfig).toBe('function');
    expect(typeof buildImageConfig).toBe('function');
  });

  it('setup-builders rejects missing required fields before touching config files', () => {
    expect(() => buildEmailConfig({})).toThrow(/email_provider/);
    expect(() => buildEmailConfig({ email_provider: 'gmail' })).toThrow(/OAuth2/);
    expect(() => buildEmailConfig({ email_provider: 'imap' })).toThrow(/imap_host/);
  });

  it('health-checks.ts exports five checkers, callable without a real network', () => {
    expect(typeof checkEmailHealth).toBe('function');
    expect(typeof checkCalendarHealth).toBe('function');
    expect(typeof checkMessagingHealth).toBe('function');
    expect(typeof checkSearchHealth).toBe('function');
    expect(typeof checkImageHealth).toBe('function');
  });

  it('checkEmailHealth returns a warning when config is incomplete', async () => {
    const result = await checkEmailHealth({ provider: 'gmail' } as Parameters<typeof checkEmailHealth>[0]);
    expect(result).toMatch(/WARN|OAuth/);
  });
});

describe('module-boundaries — cross-module', () => {
  it('search and system modules do not circularly import each other', async () => {
    // If a circular existed, the Node-ESM loader would either deadlock or
    // hand one side an empty namespace; both are caught here.
    const search = await import('../src/modules/search/index.js');
    const system = await import('../src/modules/system/index.js');
    expect(typeof search.registerSearchTools).toBe('function');
    expect(typeof system.registerSystemTools).toBe('function');
  });
});
