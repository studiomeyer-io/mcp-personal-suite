/**
 * Tests for Exa + Tavily search providers.
 * Uses vitest's fetch mock to verify request shape + response parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exaNeuralSearch, exaCodeSearch } from '../src/modules/search/providers/exa.js';
import { tavilyResearch } from '../src/modules/search/providers/tavily.js';

describe('search/providers/exa', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exaNeuralSearch', () => {
    it('calls Exa API with neural type + x-api-key header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Article A', url: 'https://a.com', score: 0.9 },
            { title: 'Article B', url: 'https://b.com', score: 0.85 },
          ],
        }),
      });

      const result = await exaNeuralSearch('test-key', 'concept query', 5);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.exa.ai/search');
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>)['x-api-key']).toBe('test-key');

      const body = JSON.parse(opts.body as string);
      expect(body.query).toBe('concept query');
      expect(body.type).toBe('neural');
      expect(body.numResults).toBe(5);
      expect(body.contents.highlights).toBeDefined();
      expect(body.contents.text).toBeUndefined(); // default: false

      expect(result.results).toHaveLength(2);
      expect(result.results[0].title).toBe('Article A');
    });

    it('clamps maxResults to [1, 100]', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
      await exaNeuralSearch('k', 'q', 500);
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.numResults).toBe(100);
    });

    it('clamps maxResults minimum to 1', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
      await exaNeuralSearch('k', 'q', 0);
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.numResults).toBe(1);
    });

    it('includes category + domain filters when provided', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
      await exaNeuralSearch('k', 'q', 10, {
        category: 'research paper',
        includeDomains: ['arxiv.org'],
        excludeDomains: ['spam.com'],
        includeText: true,
      });
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.category).toBe('research paper');
      expect(body.includeDomains).toEqual(['arxiv.org']);
      expect(body.excludeDomains).toEqual(['spam.com']);
      expect(body.contents.text).toEqual({ maxCharacters: 1000 });
    });

    it('throws on non-2xx response with error message', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Invalid API key',
      });

      await expect(exaNeuralSearch('bad-key', 'q', 5)).rejects.toThrow(/Exa API error: 401/);
    });
  });

  describe('exaCodeSearch', () => {
    it('uses github category + code-related domains', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
      await exaCodeSearch('k', 'streaming tool_use', 10);

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.category).toBe('github');
      expect(body.includeDomains).toContain('github.com');
      expect(body.includeDomains).toContain('stackoverflow.com');
      expect(body.contents.text).toEqual({ maxCharacters: 1000 });
    });
  });
});

describe('search/providers/tavily', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tavilyResearch', () => {
    it('calls Tavily API with api_key in Authorization header, advanced depth by default', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'what is MCP',
          answer: 'MCP stands for Model Context Protocol...',
          results: [{ title: 'R1', url: 'https://r1.com', content: 'x', score: 0.9 }],
          response_time: 12.3,
        }),
      });

      const result = await tavilyResearch('tvly-abc', 'what is MCP');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.tavily.com/search');
      expect(opts.method).toBe('POST');

      // Security fix: API key in Authorization header, not body
      expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tvly-abc');

      const body = JSON.parse(opts.body as string);
      expect(body.api_key).toBeUndefined(); // must NOT be in body
      expect(body.query).toBe('what is MCP');
      expect(body.search_depth).toBe('advanced'); // default
      expect(body.topic).toBe('general');
      expect(body.max_results).toBe(5); // default
      expect(body.include_answer).toBe('advanced');

      expect(result.answer).toContain('MCP stands for');
      expect(result.response_time).toBe(12.3);
    });

    it('supports basic depth + news topic + daysBack', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: 'q', results: [], response_time: 1 }),
      });

      await tavilyResearch('k', 'latest ai', {
        depth: 'basic',
        topic: 'news',
        maxResults: 3,
        daysBack: 7,
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.search_depth).toBe('basic');
      expect(body.topic).toBe('news');
      expect(body.max_results).toBe(3);
      expect(body.days).toBe(7);
    });

    it('does NOT include days param when topic is not news', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: 'q', results: [], response_time: 1 }),
      });

      await tavilyResearch('k', 'q', { topic: 'general', daysBack: 7 });
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.days).toBeUndefined();
    });

    it('clamps maxResults to [1, 20]', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: 'q', results: [], response_time: 1 }),
      });
      await tavilyResearch('k', 'q', { maxResults: 500 });
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.max_results).toBe(20);
    });

    it('includes domain filters when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: 'q', results: [], response_time: 1 }),
      });

      await tavilyResearch('k', 'q', {
        includeDomains: ['anthropic.com'],
        excludeDomains: ['reddit.com'],
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.include_domains).toEqual(['anthropic.com']);
      expect(body.exclude_domains).toEqual(['reddit.com']);
    });

    it('throws on non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      await expect(tavilyResearch('k', 'q')).rejects.toThrow(/Tavily API error: 429/);
    });
  });
});
